q# ORCMS — Completed Features

**Stage A (Foundation) complete — A1 through A5.**
Build order and feature IDs come from [IMPLEMENTATION.md §12](IMPLEMENTATION.md).

| | |
|---|---|
| Features complete | **9 of 9** in Stage A (A1–A9) |
| Tests passing | **105** (0 failures) |
| Stack | Node 24 · TypeScript · Fastify 5 · React 18 · PostgreSQL 16 |
| Code | ~5,200 lines across 49 files |

---

## A1 — Foundation and tooling

| Delivered | Where |
|---|---|
| npm workspaces (`server`, `web`) with unified scripts | [package.json](package.json) |
| Docker Compose: app, PostgreSQL 16, nightly backup service | [docker-compose.yml](docker-compose.yml) |
| Multi-stage Dockerfile, non-root user, healthcheck | [Dockerfile](Dockerfile) |
| CI: typecheck, tests, frontend build | [.github/workflows/ci.yml](.github/workflows/ci.yml) |
| **Second CI job** running migrations against real PostgreSQL 16 | same |
| Security headers — CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy | [server/src/app.ts](server/src/app.ts) |
| Typed error layer mapped to HTTP status codes | [server/src/lib/errors.ts](server/src/lib/errors.ts) |
| `.env` loader (no dependency); real env vars always win | [server/src/env.ts](server/src/env.ts) |
| Production safety assertions — refuses to boot with dev secrets or an embedded DB | same |

**Done when:** `docker compose up` serves a page; CI green. ✅

---

## A2 — Schema and seeders · 17 tests

**41 tables** across 7 migrations, covering the complete schema in [IMPLEMENTATION.md §4](IMPLEMENTATION.md) — all three divisions, both ledgers, finance, and cross-cutting concerns.

| Delivered | Detail |
|---|---|
| Migration runner | Checksummed and forward-only; an edited migration is refused |
| Seeders | 33 accounts, 4 inventory items, 11 expense categories, 5 roles, 20 permissions, 11 settings, fiscal year, bootstrap admin |
| Idempotent | Re-running migrate or seed changes nothing |
| Dual driver | Same SQL on embedded PostgreSQL (dev/test) and a real server (production) |

### Business rules enforced by the database itself

| Rule | How | Proven by |
|---|---|---|
| **BR-25** journal entries must balance | `je_must_balance` deferred constraint trigger (plpgsql) | An unbalanced entry inserted with **raw SQL** is rejected at `COMMIT` |
| **BR-26** a document posts at most once | `posting_key` unique on both ledgers | Duplicate key rejected |
| **BR-02** purchases never belong to Water Treatment | `CHECK (division IN ('UCO','UEO'))` | Insert rejected |
| **BR-22** a "no purchase" day carries zero value | `CHECK` constraint | Insert rejected |
| **BR-07** wastewater carries no cost basis | `is_valued = false` on the item | Asserted in seed test |
| **BR-27** control accounts flagged | `is_control` on AR, AP, Inventory, Fee Receivable | Asserted in seed test |

**Done when:** a fresh database migrates and seeds with no manual step. ✅

---

## A3 — Authentication · 28 tests

| Delivered | Detail |
|---|---|
| Password hashing | scrypt, memory-hard, ~120 ms/hash, salted, no native dependency |
| Password policy (§10) | 12-char minimum, mixed case, digit, rejects your own name/email and common words |
| Account lockout | 5 failed attempts → locked 15 minutes; the **correct** password is refused while locked |
| Attempt logging | Every attempt recorded with IP, user agent and outcome |
| Sessions | 8-hour lifetime, 30-minute idle timeout, signed httpOnly `SameSite=strict` cookie |
| Session revocation | Logout, expiry, idle timeout, and user deactivation all kill live sessions |
| Password change | Requires the current password; revokes every other session |
| Enumeration resistance | Unknown email and wrong password return byte-identical responses |

**Done when:** a wrong password 5× locks the account for 15 minutes and logs every attempt. ✅

---

## A4 — Role-based access control · 22 tests

**5 roles × 20 permissions**, seeded from a single source of truth: [server/src/modules/rbac/matrix.ts](server/src/modules/rbac/matrix.ts). The seeder writes it to the database and the test suite iterates it — if the code and §6.1 ever drift apart, a test fails.

| Role | Permissions | Status at go-live |
|---|---|---|
| Administrator | all 20 | enabled |
| Accountant | 12 | enabled |
| Auditor | 6 (read-only) | enabled |
| Manager | 4 | seeded **disabled** (SRS §6.3) |
| Data Entry Operator | 3 | seeded **disabled** (SRS §6.3) |

| Delivered | Detail |
|---|---|
| Route guards | `requireAuth`, `requirePermission`, `requireAnyPermission`, `requireRole` |
| Permission-filtered navigation | `/api/nav` returns only what the caller may see; a parent with no visible children is dropped |
| Honest 403s | Names the missing permission and carries **no payload** |
| **BR-18** | Only Administrator may delete activity logs — asserted for every role |
| Field-level design | `profit.view` withheld from Data Entry; enforced server-side, not by hiding UI |

**Done when:** a test iterates the whole matrix and every cell passes. ✅ — plus 16 explicit denial assertions for the cells that carry business meaning.

---

## A5 — Two-factor authentication · 38 tests

RFC 6238 TOTP implemented on `node:crypto` (~60 lines, no dependency), verified against the **official RFC test vectors**.

| Delivered | Detail |
|---|---|
| Enrolment | Two-step: QR code + manual key, then a live code before anything is committed |
| Why two-step | Committing on step one is how users lock themselves out permanently |
| Recovery codes | 10 per user, stored hashed, single-use, shown exactly once |
| Login challenge | TOTP or recovery code; ±1 step tolerance for clock drift; constant-time comparison |
| Administrator reset | Clears 2FA, revokes sessions, forces re-enrolment |
| Secret hygiene | Never returned after enrolment; redacted from the activity log |
| **`ENFORCE_2FA` switch** | `true` = mandatory for Admin/Accountant (§6.1) · `false` = opt-in |

**On the switch:** turning enforcement off never silently weakens an account that opted in — a user who enrolled voluntarily is still challenged. The server logs a warning on every boot while it is off. Both positions are tested.

> **Currently `ENFORCE_2FA=false`** in `.env` for convenience during development. Set it to `true` before go-live — no other change needed.

**Done when:** an Accountant without 2FA enrolled is forced through setup before any other route. ✅

---

## A6–A9 — Shell, audit, settings, attachments

| Feature | Delivered |
|---|---|
| **A6** Application shell | React 18 + TypeScript SPA: login, 2FA enrolment, 2FA challenge, permission-driven sidebar, topbar, dashboard. Light and dark themes. Renders whatever `/api/nav` returns rather than deciding visibility itself |
| **A7** Activity log | Schema, observers, before/after diffing, secret redaction, denormalised `user_name` so the trail survives user deletion. Login, failed login, lockout, logout, 2FA enrolment, 2FA failure and password change all recorded |
| **A8** Settings | 11 seeded keys — company profile, fee label, payment methods, costing method, allocation method, capacities, yield tolerance, base currency |
| **A9** Attachments | Table, SHA-256 hashing, upload metadata; files stored outside the web root and served through an authorising controller |

A7's **viewer UI** and A8's **editor UI** are backend-complete; their admin screens arrive with the user-management work.

---

## Cross-cutting

| | |
|---|---|
| Type safety | `strict` TypeScript both workspaces, `noUncheckedIndexedAccess`, zero errors |
| Money precision | `numeric`/`int8` returned as **strings** on both drivers — JS numbers cannot hold them safely |
| Money columns | `numeric(14,2)`; quantities `numeric(12,3)`. Never floats |
| Optimistic locking | `version` column on every document table (BR-30) |
| Soft deletes | `deleted_at` throughout — nothing is ever physically removed (BR-19) |

---

## Bugs found and fixed during the build

Each was caught by a test or a smoke check, not by inspection.

1. **Guards hung every request.** Fastify hooks taking `(request, reply)` must return a promise; the synchronous guards left requests waiting forever for a `done()` callback that never came.
2. **Money would have silently rounded.** PGlite parsed `numeric`/`int8` into JS numbers while node-postgres returns strings precisely because they exceed JS precision. Fixed at the driver layer so tests cannot be more forgiving than production.
3. **A fresh clone could not start.** PGlite's `mkdir` is not recursive, so the default nested data directory failed on first run.
4. **`/` returned 403.** `@fastify/static` with `index: false` treats a root request as a directory listing.
5. **`.env` was decorative.** Nothing in the codebase read it — any setting placed there was silently ignored.
6. **Local `.env` leaked into the test suite.** `env.ts` is evaluated during import resolution, before any test body runs, so the helper's `NODE_ENV='test'` guard was too late. Now detects `NODE_TEST_CONTEXT`; a test asserts hermeticity.
7. **Two databases could exist at once.** The embedded data directory resolved against `process.cwd()`, so npm workspace scripts (cwd `server/`) and root-run scripts used different databases — the second appearing mysteriously empty. Now anchored to the repository root.

---

## Accounts

One account exists:

| Email | Name | Role | 2FA |
|---|---|---|---|
| `admin@orcms.local` | System Administrator | Administrator | not enrolled |

Password: `SEED_ADMIN_PASSWORD` (default `ChangeMeAdmin2026!`). No parties, employees or drivers yet. A user-management screen is not built — additional accounts currently need a seed or script.

---

## Not built yet

Everything from **Stage B** onward. In build order:

| Stage | Scope |
|---|---|
| **B** Ledger core | Posting service, journal, manual entries, cash & bank ledgers, trial balance, opening balances, fiscal-year locking |
| **C** Inventory core | Stock movements, row locking, weighted-average valuation, recost/backdating, adjustments |
| **D** Master data | Parties, party ledger, agreements, drivers, employees |
| **E** Document machinery | Numbering, optimistic locking, payment allocation, deletion-as-reversal |
| **F** Divisions | UCO, UEO, Water Treatment documents |
| **G** Finance | Expenses, salaries, drawings, weight-fee refunds, bank reconciliation |
| **H** Reporting | Report catalogue, PDF/Excel export, dashboard |
| **I** Integrity & ops | Nightly checks, notifications, backup and restore |
| **J** Hardening | Performance, security, E2E, data migration, UAT |

The governing rule: **nothing that writes to the ledgers is built until the ledger core is proven.** A division module built on an unverified posting engine produces wrong numbers that look right, and every feature added afterwards inherits the error.

Unbuilt screens are reachable in the navigation and each names the feature that will fill it — nothing dead-ends. The dashboard deliberately shows only what the ledgers can currently prove rather than placeholder revenue figures.
