# ORCMS — Integrated Oil, Water & Recycling ERP

Web ERP for a company operating three divisions — Used Cooking Oil (UCO), Used Engine Oil (UEO) and Water Treatment (WTD) — on one shared accounting core.

| Document | What it covers |
|---|---|
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Architecture, full schema, 30 business rules, feature-by-feature build order |
| [FLOWS.md](FLOWS.md) | Data flow diagrams and 16 scenario user flows ([rendered](FLOWS.html)) |

---

## Status

**Stage A complete — features A1 to A5.** 105 tests passing.

| Feature | What it delivers | Tests |
|---|---|---|
| A1 | Workspace, Docker Compose, CI, security headers | — |
| A2 | 41-table schema, migrations, seeders | 17 |
| A3 | Authentication, lockout, sessions, password policy | 28 |
| A4 | RBAC — 5 roles, 20 permissions, permission-filtered navigation | 22 |
| A5 | Two-factor authentication (TOTP), recovery codes, `ENFORCE_2FA` policy switch | 38 |

Not built yet: everything from Stage B onward. Navigation shows those screens and each names the feature that will fill it — nothing dead-ends, and nothing displays invented numbers.

---

## Running it

```bash
npm install
npm run migrate && npm run seed
npm run dev
```

`http://localhost:5173` — Vite serves the UI and proxies `/api` to the server on port 3000.

`http://127.0.0.1:5200` — sign in with `admin@orcms.local` and the password from `SEED_ADMIN_PASSWORD` (default `ChangeMeAdmin2026!`).

### Two-factor authentication

`.env` currently sets `ENFORCE_2FA=false`, so login goes straight to the dashboard with no authenticator app needed.

| `ENFORCE_2FA` | Behaviour |
|---|---|
| `true` (default, required at go-live) | Mandatory for Administrator and Accountant — first login forces enrolment (§6.1) |
| `false` | Opt-in. Nobody is pushed through enrolment, but anyone who **has** enrolled is still challenged |

Turning it off never silently weakens an account that opted in, and the server prints a warning on every boot while it is off. The feature is fully built and tested in both positions — flipping the flag back to `true` is the only step needed.

### Commands

| Command | Effect |
|---|---|
| `npm run dev` | Server and UI with hot reload |
| `npm test` | Full suite against embedded PostgreSQL |
| `npm run typecheck` | Both workspaces |
| `npm run build` | Builds the SPA into `server/public`, served by the API on one origin |
| `npm run migrate` / `seed` / `reset` | Database lifecycle |

---

## The database

Development and tests run **PGlite** — real PostgreSQL 16 compiled to WebAssembly, embedded in the process. No installation, no container, no service to start.

This is not a compromise on the schema. The features the design depends on all work: `plpgsql`, the deferred constraint trigger that enforces double-entry balancing, `SELECT … FOR UPDATE`, enums, `jsonb`, `inet`, partial and expression indexes. The `BR-25` test proves it by inserting an unbalanced journal entry with raw SQL and watching the database reject it at `COMMIT`.

Production points `DATABASE_URL` at a real PostgreSQL server. The same SQL runs on both, and CI runs migrations against PostgreSQL 16 on every push so a PGlite-specific behaviour cannot quietly become a dependency.

```
DATABASE_URL unset     -> embedded, persisted under .data/
DATABASE_URL=memory:// -> embedded, in-memory (tests)
DATABASE_URL=postgres://...  -> real server (production)
```

---

## Layout

```
server/
  src/
    db/
      migrations/*.sql      the schema from IMPLEMENTATION.md §4
      client.ts             one interface over PGlite and node-postgres
      migrate.ts            checksummed, forward-only
      seed.ts               accounts, items, roles, settings, bootstrap admin
    lib/
      password.ts           scrypt hashing and the §10 password policy
      totp.ts               RFC 6238, on node:crypto
      errors.ts             typed errors mapped to HTTP status codes
    modules/
      auth/                 login, sessions, lockout, password change
      twofactor/            enrolment, challenge, recovery codes, admin reset
      rbac/matrix.ts        the §6.1 permission matrix — single source of truth
      rbac/guard.ts         route guards
      activity/log.ts       audit trail with redaction and diffing
      meta/routes.ts        health, navigation, reference data
  tests/                    one file per feature, named for what it proves
web/
  src/
    auth/                   login, 2FA enrolment, 2FA challenge
    shell/AppShell.tsx      renders whatever /api/nav returns
    pages/                  dashboard and honest placeholders
```

---

## Decisions worth knowing

**The permission matrix lives in one file.** [`server/src/modules/rbac/matrix.ts`](server/src/modules/rbac/matrix.ts) is what the seeder writes to the database and what the tests iterate. If the code and IMPLEMENTATION.md §6.1 ever disagree, a test fails — which is the point.

**Balancing is a database constraint, not an application check.** `je_must_balance` is a deferred constraint trigger. An unbalanced journal entry cannot be committed by any path, including raw SQL, a future integration, or a data fix run by hand.

**scrypt instead of bcrypt.** §10 specifies bcrypt cost 12. scrypt is memory-hard, ships inside Node, and needs no native compilation — which matters when the runbook says the office server must be rebuildable from bare hardware. Parameters are tuned to ~120 ms per hash, comparable to bcrypt cost 12.

**TOTP is implemented, not imported.** Around 60 lines of well-specified arithmetic on `node:crypto`, verified against the RFC 6238 test vectors. An authentication dependency is a supply-chain liability for a system holding a company's financial records.

**Two-step 2FA enrolment.** The secret is stored on step one but does not count as enrolled until a live code proves the authenticator actually received it. Committing on step one is how users lock themselves out permanently.

**Money and quantities stay strings in transit.** node-postgres returns `numeric` and `int8` as strings because they exceed JavaScript number precision. PGlite is configured to match, so the test environment cannot be more forgiving than production.

---

## Deployment

```bash
cp .env.example .env     # set POSTGRES_PASSWORD and SESSION_SECRET
docker compose up -d
```

The app refuses to start in production with a development session secret, an embedded database, or insecure cookies — see `assertProductionSafety()` in [`server/src/env.ts`](server/src/env.ts).

Nothing is published to the internet. Remote access, if it is ever approved, goes over VPN (SRS §6.2).
