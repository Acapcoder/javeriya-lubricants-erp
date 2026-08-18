# Deploying ORCMS

ORCMS runs online: the app on Vercel, the database on Supabase. There is no
on-premises component.

```
  Browser ──▶ Vercel CDN            static React app
          └─▶ Vercel Function       /api/*  (Fastify)
                   └─▶ Supabase     PostgreSQL 17, session pooler
```

---

## 1. Which Supabase connection string

Supabase offers two pooled endpoints. Use the **session pooler** on port `5432`:

```
postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres
```

Supabase dashboard → Project Settings → Database → Connection string →
**Session pooler**. The same string runs the migrations from your machine, so
there is only one to keep track of.

|  | Session pooler `5432` | Transaction pooler `6543` |
|---|---|---|
| Holds | One database connection per client | Connections shared per transaction |
| Many containers | Can reach the connection limit | Built for it |
| Prepared statements, `SET`, advisory locks | Work normally | Not available across statements |

Serverless starts many short-lived containers, so the session pooler is the one
that could eventually run out of connections. Two things keep that far away:
the pool caps at **2 connections per container** on serverless (see
`server/src/db/client.ts`), and Vercel reuses a warm container across requests.
Move to `6543` only if sign-ins start failing with connection errors under real
load; the app has been verified to work through it, including transactions,
`SELECT … FOR UPDATE` and the deferred balance trigger.

## 2. Set the environment variables

Vercel dashboard → Settings → Environment Variables, for Production (and
Preview, if you use it):

| Name | Value | |
|---|---|---|
| `DATABASE_URL` | The **5432** session pooler string | required |
| `SESSION_SECRET` | Generate one, see below. Never the development default | required |
| `COOKIE_SECURE` | `true` | defaults to `true` in production |
| `ENFORCE_2FA` | `true` before real use. `false` only while testing | defaults to `true` |

`SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD` belong on your machine, not
here. They are read by `npm run seed`, which you run once against the database;
the deployed app never looks at them.

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
# From your machine, with the same 5432 string you set in Vercel
DATABASE_URL="postgresql://...5432/postgres" npm run migrate
SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD='...' \
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

- `npm run build` does two things: the React app into `server/public`, served
  from the CDN, and the server into `server/dist/serverless.mjs`, a single
  JavaScript module the function loads.
- **Why the server is bundled.** Vercel compiles `api/index.ts` to JavaScript
  but does not carry `server/src` into the deployment, so a function importing
  `../server/src/app.ts` dies at load with `Cannot find module
  /var/task/server/src/env.ts`. Bundling ahead of time (`scripts/build-api.mjs`)
  takes the platform's TypeScript resolution out of the picture. `includeFiles`
  in `vercel.json` is what puts the bundle in the function.
- `api/index.ts` wraps the Fastify app. The `/api/(.*)` rewrite sends every
  `/api/…` path to it at any depth, with the URL intact, which is what Fastify
  routes on. The filename catch-all (`api/[...path].ts`) is the tidier
  convention and was tried first, but on this project it only ever matched a
  single segment: `/api/nav` reached the function while `/api/auth/me` returned
  a platform 404 before the function ran.
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

**Function timeout.** 30 seconds, declared by the `config` export in
`api/index.ts` rather than in `vercel.json`. Every request in the system
finishes well inside that; one approaching it means something is wrong rather
than slow.

**When the API returns 500.** The body names the cause. `STARTUP_FAILED` with a
message about a variable means that variable is missing from the Vercel
project. Set `DEBUG_STARTUP=1` to have the stack included as well, and remove
it afterwards.

## Rotating the database password

Supabase dashboard → Project Settings → Database → Reset database password.
Then update `DATABASE_URL` in Vercel and redeploy, and in your local `.env`.
