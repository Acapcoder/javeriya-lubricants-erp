# ORCMS — Oil Recycling ERP

Web ERP for a used-oil recycling business. Two operating divisions, Used Cooking
Oil (UCO) and Used Engine Oil (UEO), on one shared accounting core.

Runs online: the app on **Vercel**, the database on **Supabase** (PostgreSQL 17).

| Document | What it covers |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Deploying to Vercel and Supabase |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | Architecture, full schema, business rules, build order |
| [FLOWS.md](FLOWS.md) | Data flow diagrams and scenario user flows |
| [FEATURES.md](FEATURES.md) | What is built, feature by feature |

**144 tests passing.**

---

## Running it locally

```bash
npm install
npm run migrate && npm run seed
npm run dev
```

Open `http://127.0.0.1:5200` and sign in with the username `admin` and the
password from `SEED_ADMIN_PASSWORD` (default `ChangeMeAdmin2026!`).

With no `DATABASE_URL` set it uses an embedded PostgreSQL, so nothing has to be
installed. Point `DATABASE_URL` at Supabase to work against real data.

| Command | Effect |
|---|---|
| `npm run dev` | Server and UI with hot reload |
| `npm test` | Full suite against embedded PostgreSQL |
| `npm run typecheck` | Both workspaces |
| `npm run build` | Builds the SPA into `server/public` |
| `npm run migrate` / `seed` / `reset` | Database lifecycle |

> Stop the dev server before running `migrate` or `seed` against the embedded
> database. Two processes cannot hold the same embedded data directory.

---

## What it does

**Purchases.** One screen for every intake, whatever the source: a driver
collection, a company agreement, or a supplier delivering to the yard. Records
the drums, what they cost, how they were paid for, which tank they went into,
and any government weight fee with a photograph of the slip.

**Drivers.** Split by the distinction that actually matters. An **in-house**
driver uses your truck and works against an advance you issue; an **outsourced**
driver uses their own and is paid per load. Only the first can hold an advance,
because only their money is still yours.

**Inventory and tanks.** Stock totals per oil, and the physical tanks holding
them, with capacity enforced so a delivery with nowhere to go is refused before
it is recorded. Dip readings compare the books against the tank.

**Finance.** Cash and bank ledgers, trial balance, the journal, running costs,
wages, owner's drawings, supplier payments with allocation across invoices, and
the government weight fee refund pipeline.

**Reports.** Intake grouped by day, month, driver, supplier, source or area;
stock movement; profit; and who owes what.

**Three profiles.** Administrator, Accountant, Auditor. The Accountant does all
day-to-day work; **deletion is the one thing only the Administrator can do**,
because deletion is the one action that rewrites history.

---

## The two things that hold everything together

**Two authoritative stores, both append-only.** A double-entry financial ledger
and a stock movement ledger. Every balance in the system is derived from them;
nothing writes a total directly. If a figure looks wrong, the document behind it
is wrong.

**Money never touches a JavaScript number.** Amounts are parsed into exact
bigint minor units and stay strings in transit, because `0.1 + 0.2 !== 0.3` and
a ledger that balances to within a tolerance does not balance. Quantities use a
separate 3-decimal scale, and mixing the two is an error the code refuses rather
than rounds.

---

## Decisions worth knowing

**Balancing is a database constraint, not an application check.**
`je_must_balance` is a deferred constraint trigger. An unbalanced journal entry
cannot be committed by any path, including raw SQL or a future integration. A
test proves it by inserting one directly and watching PostgreSQL reject it at
`COMMIT`.

**The permission matrix lives in one file.**
[`server/src/modules/rbac/matrix.ts`](server/src/modules/rbac/matrix.ts) is what
the seeder writes to the database and what the tests iterate. If it and the
documentation ever disagree, a test fails.

**Sign in is by username, not email.** In a yard office not everyone has an
email address, and a login screen should not require what people do not have.
Email is optional contact detail.

**scrypt instead of bcrypt.** Memory-hard, ships inside Node, needs no native
compilation. Tuned to about 120 ms per hash.

**TOTP is implemented, not imported.** Around 60 lines of well-specified
arithmetic on `node:crypto`, verified against the RFC 6238 test vectors. An
authentication dependency is a supply-chain liability for a system holding a
company's financial records.

**Slip photographs go in the database.** Downscaled in the browser and capped at
2 MB by a database constraint. The backup then covers the images automatically,
and a refund claim cannot lose its evidence.

---

## Layout

```
api/index.ts              Vercel serverless entry: no listen(), no migrations
vercel.json               build, routing, function config

server/src/
  db/
    migrations/*.sql      the schema, forward-only and checksummed
    client.ts             one interface over embedded and real PostgreSQL
  lib/
    money.ts              exact decimal arithmetic
    password.ts           scrypt hashing and the password policy
    totp.ts               RFC 6238, on node:crypto
  modules/
    auth/ twofactor/      sign in, sessions, lockout, 2FA
    rbac/                 the permission matrix and route guards
    purchases/            intake, the one document every load flows through
    inventory/            stock ledger, tanks, capacity
    finance/              posting engine, ledgers, journal, spending, payments
    reports/              everything derived, nothing stored
    users/ masters/       people, drivers, suppliers, agreements
server/tests/             one file per feature, named for what it proves

web/src/
  pages/                  one screen per operation
  components/             money, hints, search, receipt upload
  content/operations.ts   what each operation means, in plain language
```

---

## Deployment

See [DEPLOY.md](DEPLOY.md). In short: run the migrations from your machine
against the Supabase **session** pooler, point Vercel at the **transaction**
pooler, set the environment variables, and deploy.

The app refuses to start in production with a development session secret, an
embedded database, or insecure cookies. A misconfigured deployment fails loudly
rather than running insecurely.
