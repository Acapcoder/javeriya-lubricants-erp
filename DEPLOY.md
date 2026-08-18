# Deploying ORCMS

ORCMS runs online: the app on Vercel, the database on Supabase. There is no
on-premises component.

```
  Browser ──▶ Vercel CDN            static React app
          └─▶ Vercel Function       /api/*  (Fastify)
                   └─▶ Supabase     PostgreSQL 17, transaction pooler
```

---

## 1. Use the transaction pooler, not the session pooler

This matters more than anything else on this page.

Supabase gives two connection strings. The **session pooler** on port `5432`
holds one database connection per client, which suits a single long-running
server. Serverless starts many short-lived containers, each wanting a
connection, and that exhausts the limit quickly.

Use the **transaction pooler** on port `6543` for Vercel:

```
postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Supabase dashboard → Project Settings → Database → Connection string →
**Transaction pooler**.

Keep the `5432` session string for running migrations from your machine.

## 2. Set the environment variables

Vercel dashboard → Settings → Environment Variables, for Production (and
Preview, if you use it):

| Name | Value |
|---|---|
| `DATABASE_URL` | The **6543** transaction pooler string |
| `SESSION_SECRET` | Generate one, see below. Never the development default |
| `COOKIE_SECURE` | `true` |
| `ENFORCE_2FA` | `true` before real use. `false` only while testing |
| `SEED_ADMIN_USERNAME` | `admin`, or whatever you prefer |
| `SEED_ADMIN_PASSWORD` | A strong password, 12+ characters |

**Do not add `NODE_ENV`.** Vercel applies it at runtime already. Setting it as a
build variable makes npm skip devDependencies, and the build tools live there,
so the build fails with `vite: command not found`. The install command in
`vercel.json` passes `--include=dev` to survive this, but the variable is still
better left unset.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The app **refuses to start** in production with a development secret, an
embedded database, or insecure cookies, and returns a message naming the
problem. A misconfigured deployment should fail loudly rather than run
insecurely.

## 3. Run the migrations before the first deploy

Migrations are **not** run automatically. On a platform that may start many
containers at once, running them at boot means running them concurrently. They
are a deploy step:

```bash
# From your machine, using the SESSION pooler string (port 5432)
DATABASE_URL="postgresql://...5432/postgres" npm run migrate
DATABASE_URL="postgresql://...5432/postgres" npm run seed
```

Re-run `npm run migrate` after any deploy that adds one. It is idempotent, so
running it when nothing is new does nothing.

## 4. Vercel project settings

These two are easy to get wrong when importing from GitHub, and both cause the
build to fail:

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | the repository root, **not** `server` | `vercel.json`, `api/` and the npm workspaces all live at the root. Pointing at `server` means Vercel never reads the config, and installs only part of the dependency tree. |
| **Framework Preset** | **Other** | Not Fastify. A preset brings its own build assumptions; `vercel.json` already says how to build this. |

Everything else lives in `vercel.json` and needs no dashboard configuration.

> `vercel.json` is validated against a strict schema. Any key Vercel does not
> recognise is rejected outright, and JSON has no comments, so notes about the
> config belong in this file rather than in it.

**Why the install command passes `--include=dev`:** if `NODE_ENV=production` is
set as a build variable, npm skips devDependencies, and the build tools live
there. The flag makes the install correct either way.

## 5. Deploy

Connect the GitHub repository in the Vercel dashboard and it builds on every
push to `main`. Or from the command line:

```bash
npm i -g vercel
vercel login
vercel link          # once, to attach this folder to a project
vercel --prod
```

## 6. Check it came up

```
https://your-project.vercel.app/api/health
```

Should return `{"ok":true,...}`. Then sign in at the root with the username and
password you seeded.

---

## How it is wired

- `vercel.json` builds the React app into `server/public`, served from the CDN.
- `/api/*` rewrites to `api/index.ts`, a serverless function wrapping the
  Fastify app.
- Every other path falls back to `index.html`, because routing is client-side.
- The Fastify app is built **once per container** and reused, so warm requests
  pay no startup cost and hold one connection pool rather than one per request.
- Sessions live in the `sessions` table, not in memory, so it does not matter
  which container answers a request.
- The connection pool caps at 2 per container on serverless, against 10 for a
  long-running process, so containers do not multiply into Supabase's limit.

## Things to know about serverless

**Cold starts.** The first request to an idle container pays app startup plus a
database connection, roughly a second. Subsequent requests are normal.

**No background jobs.** Nightly backups, the integrity check and notification
scans assume a process that keeps running. On Vercel they need
[Cron Jobs](https://vercel.com/docs/cron-jobs), which are not wired up yet.
Supabase takes its own database backups, so the data itself is covered.

**File uploads.** Slip photographs go into the database rather than a
filesystem, so they work unchanged and are included in Supabase's backups. The
2 MB cap keeps requests inside the function body limit.

**Function timeout.** Set to 30 seconds in `vercel.json`. Every request in the
system finishes well inside that; a request approaching it means something is
wrong rather than slow.

## Rotating the database password

Supabase dashboard → Project Settings → Database → Reset database password.
Then update `DATABASE_URL` in Vercel and redeploy, and in your local `.env`.
