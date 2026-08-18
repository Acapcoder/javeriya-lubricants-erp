# Integrated Oil Recycling ERP — Implementation Plan

**System name:** ORCMS (Oil Recycling Company Management System)
**Source documents:** `ORCMS Requirements Specification.docx` v1.0 (baseline SRS)
**Document version:** 1.1 — implementation blueprint (revised)
**Date:** 2026-08-05

---

## 0. How to read this document

This plan focuses exclusively on the two core operations of the business:

| Area | Resolution |
|---|---|
| Divisions | **UCO** (Used Cooking Oil) and **UEO** (Used Engine Oil / Black Oil) |
| Deployment | Online: Vercel and Supabase (supersedes the original on-premises decision) |
| Roles | **Administrator, Accountant, Auditor** — three profiles, no others |
| Inventory | **UCO drums** and **UEO drums** |
| Sales Routing | UCO is exclusively **Exported**; UEO is exclusively **Sold Locally** |
| Driver Management | Explicit split between **In-House** (quota/advances) and **Outsourced** (direct pay) |
| Weight fee refunds | Full refund pipeline + aging |

---

## 1. Scope summary

A single centralized web ERP covering two operating divisions plus one shared finance/accounting core.

```
                    ┌─────────────────────────────────────────┐
                    │        SHARED ACCOUNTING CORE           │
                    │  Chart of Accounts · Journal · Cash &   │
                    │  Bank · AR/AP · Expenses · Salaries ·   │
                    │  Owner's Drawings · P&L · Weight Fees   │
                    └───────────────▲─────────────────────────┘
                                    │ every document posts here
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────┴────────┐         ┌────────┴────────┐
│  UCO Division  │         │  UEO Division   │
│ Suppliers      │         │ Purchases       │
│ Driver collect.│         │ Tankers         │
│ Agreements     │         │ Local sales     │
│ Export sales   │         │                 │
│ Containers     │         │                 │
└───────┬────────┘         └────────┬────────┘
        │                           │
        │                           │
        │                           │
        ▼                           ▼
        ┌───────────────────────────────────────────────────────┐
        │  INVENTORY LEDGER: UCO drums · UEO drums              │
        └───────────────────────────────────────────────────────┘
```

**Core architectural principle:** operational records are kept **per division**; money is kept in **one shared ledger**. Every operational document (purchase, sale, expense, salary, drawing) is a *source document* that automatically posts to the accounting core and, where relevant, to the inventory ledger. Nothing writes a balance directly — all balances are derived from immutable movement rows.

---

## 2. Technology stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | PHP 8.3 | Mature ERP ecosystem, cheap local hosting, easy handover |
| Framework | Laravel 11 | First-class RBAC, queues, migrations, policies, scheduler |
| UI | Inertia.js + React 18 + TypeScript + Tailwind + shadcn/ui | Single-page feel without a separate API surface; typed forms |
| Database | PostgreSQL 16 | Transactional integrity, partial/expression indexes, `numeric` money type, window functions for ledgers |
| Cache/queue | Redis 7 | Notification jobs, report caching, backup scheduling |
| PDF export | `barryvdh/laravel-dompdf` (server-rendered Blade templates) | Consistent print/PDF from one template |
| Excel export | `maatwebsite/excel` (PhpSpreadsheet) | Native `.xlsx`, large-report chunked writes |
| Auth / RBAC | Laravel Fortify + `spatie/laravel-permission` | Role + permission matrix, 2FA (TOTP) built in |
| Audit trail | `owen-it/laravel-auditing` extended | Automatic before/after diffs on every model |
| File storage | Local disk `storage/app/attachments`, hashed paths | Slip scans and receipts stay on premises |
| Deployment | Vercel (serverless) with Supabase PostgreSQL | Online system, no on-premises component. See DEPLOY.md |
| Backups | `pg_dump` + attachment `rsync`, nightly, dated, to NAS/second disk | Indefinite retention requirement (SRS §5.1) |

**Alternative if the team is .NET-native:** ASP.NET Core 8 + EF Core + PostgreSQL + Blazor Server. Every schema, rule, and module boundary in this document transfers unchanged; only §2 and §13 differ.

**Money type rule:** all monetary columns are `numeric(14,2)`; all drum/quantity columns are `numeric(12,3)`. Never `float`, never `money`.

---

## 3. Deployment architecture

```
  Office LAN (192.168.x.0/24)
  ┌──────────────────────────────────────────────────────────┐
  │  SERVER (single box, UPS-backed)                          │
  │  ┌────────────┐  ┌──────────┐  ┌────────┐  ┌───────────┐ │
  │  │  nginx     │→ │ php-fpm  │→ │postgres│  │  redis    │ │
  │  │  :80/:443  │  │ (app)    │  │ :5432  │  │  :6379    │ │
  │  └────────────┘  └────┬─────┘  └────┬───┘  └───────────┘ │
  │                       │             │                     │
  │              ┌────────┴───┐   ┌─────┴──────┐              │
  │              │ queue      │   │ nightly    │              │
  │              │ worker     │   │ pg_dump →  │              │
  │              │ + scheduler│   │ /backups   │              │
  │              └────────────┘   └────────────┘              │
  └──────────────────────────────────────────────────────────┘
        ▲             ▲              ▲
   Accountant    Accountant     Admin / Auditor
    laptop 1      laptop 2        browser
```

- Access via `http://orcms.local` (internal DNS or hosts entry) with a self-signed or internal CA TLS certificate.
- No public exposure. Remote access, if later approved, is added via VPN only — no port forwarding (SRS §6.2).
- Nightly backup at 01:00 to a second physical disk **and** a NAS/external drive; weekly restore test is part of the ops checklist.

---

## 4. Data model

### 4.1 Design rules

1. **Immutable movement rows.** `stock_movements` and `journal_lines` are append-only. Corrections are reversing entries, never `UPDATE`s.
2. **One source of truth per fact.** Money lives in `journal_lines`; quantity lives in `stock_movements`. No other table may be the authority for a balance. Anything else showing a balance is either a *derived query* or a *reconciled cache* (§4.11) — never an independently maintained number.
3. **Derived balances.** Cash balance, bank balance, stock on hand, party outstanding — all computed by aggregation over the ledgers, then cached in summary tables refreshed inside the same transaction as the posting.
4. **Denormalised money columns on documents are display caches only.** `balance_due` and `payment_status` on purchases and sales are recomputed from the ledger on every posting and verified nightly (§4.11). Reports and dashboards read the ledger, not these columns.
5. **Soft deletes everywhere** (`deleted_at`). Nothing is physically removed except activity logs by Administrator (Bold §11).
6. **Every table** carries `created_by`, `updated_by`, `created_at`, `updated_at`, `fiscal_year_id`, and `version integer NOT NULL DEFAULT 0` for optimistic locking (two accountants, same document — §15).
7. **Division tagging.** Operational tables carry `division` (`UCO` | `UEO`); finance tables do not (expenses are company-wide, Bold §8 / SRS §4.9). Divisional attribution for reporting comes from `journal_lines.division`, not from the document table.
8. **Rounding.** All allocations (payment application, tax) distribute to 2 decimals and give the **remainder to the last row**, so the parts always sum exactly to the whole. Never `round()` each part independently.
9. **Opening balances are postings, not columns.** Cut-over balances enter as a dated opening journal entry and opening stock movements — so day-one figures are auditable by the same mechanism as everything after them.
10. **Idempotent posting.** Every posting carries a unique `posting_key`; a retried request can never double-post.

### 4.2 Reference & security tables

```sql
CREATE TYPE division_t   AS ENUM ('UCO', 'UEO');
CREATE TYPE party_type_t AS ENUM ('SUPPLIER', 'CUSTOMER');
CREATE TYPE driver_type_t AS ENUM ('IN_HOUSE', 'OUTSOURCED');
CREATE TYPE pay_status_t AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
CREATE TYPE refund_t     AS ENUM ('NOT_ELIGIBLE', 'PENDING', 'CLAIMED', 'RECEIVED');

CREATE TABLE fiscal_years (
  id            serial PRIMARY KEY,
  label         varchar(20) NOT NULL UNIQUE,   -- '2026'
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  is_locked     boolean NOT NULL DEFAULT false,
  locked_at     timestamptz,
  locked_by     bigint REFERENCES users(id)
);

CREATE TABLE users (
  id                  bigserial PRIMARY KEY,
  name                varchar(120) NOT NULL,
  email               varchar(190) NOT NULL UNIQUE,
  password            varchar(255) NOT NULL,
  two_factor_secret   text,
  two_factor_confirmed_at timestamptz,
  is_active           boolean NOT NULL DEFAULT true,
  last_login_at       timestamptz,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);
-- roles, permissions, model_has_roles: spatie/laravel-permission schema

CREATE TABLE settings (
  key         varchar(80) PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  bigint REFERENCES users(id),
  updated_at  timestamptz
);
-- seeded keys: company.profile, fee.label, stock.low_thresholds,
-- refund.aging_days, year_end.lock_policy, payment_methods, expense_categories
```

### 4.3 Master data

```sql
CREATE TABLE parties (
  id                 bigserial PRIMARY KEY,
  code               varchar(20) NOT NULL UNIQUE,      -- SUP-0001 / CUS-0001 / IND-0001
  type               party_type_t NOT NULL,
  name               varchar(160) NOT NULL,
  company            varchar(160),
  contact_person     varchar(120),
  phone              varchar(40),
  email              varchar(190),
  address            text,
  division           division_t,          -- null = serves multiple divisions
  -- NOTE: no opening_balance column (rule 9). Cut-over balances are posted as an
  -- opening journal entry against AR/AP with party_id set, so the party ledger and
  -- the control account can never disagree.
  credit_terms_days  smallint NOT NULL DEFAULT 0,
  notes              text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);
CREATE INDEX parties_type_idx ON parties(type) WHERE deleted_at IS NULL;

CREATE TABLE agreements (               -- Direct Company Agreements
  id              bigserial PRIMARY KEY,
  party_id        bigint NOT NULL REFERENCES parties(id),
  agreement_no    varchar(50) NOT NULL UNIQUE,
  agreement_date  date NOT NULL,
  expires_on      date,                          -- drives contract-expiry notification
  division        division_t NOT NULL,
  rate_per_drum   numeric(14,2),
  payment_terms   varchar(120),
  notes           text,
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE drivers (
  id               bigserial PRIMARY KEY,
  code             varchar(20) NOT NULL UNIQUE,
  type             driver_type_t NOT NULL,
  name             varchar(120) NOT NULL,
  phone            varchar(40),
  vehicle_number   varchar(40),
  license_number   varchar(60),
  salary           numeric(14,2),        -- for in-house only
  advance_balance  numeric(14,2) NOT NULL DEFAULT 0,  -- quota money owed by in-house driver
  joining_date     date,                 -- for in-house only
  status           varchar(20) NOT NULL DEFAULT 'ACTIVE'  -- ACTIVE|ON_LEAVE|INACTIVE
);

CREATE TABLE driver_vacations (
  id         bigserial PRIMARY KEY,
  driver_id  bigint NOT NULL REFERENCES drivers(id),
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  reason     text,
  CHECK (ends_on >= starts_on)
);

CREATE TABLE employees (
  id            bigserial PRIMARY KEY,
  code          varchar(20) NOT NULL UNIQUE,
  name          varchar(120) NOT NULL,
  designation   varchar(80),
  base_salary   numeric(14,2) NOT NULL DEFAULT 0,
  joining_date  date,
  is_active     boolean NOT NULL DEFAULT true
);
```

### 4.4 Inventory ledger

```sql
CREATE TABLE inventory_items (
  id            smallserial PRIMARY KEY,
  code          varchar(20) NOT NULL UNIQUE,  -- UCO, UEO
  name          varchar(80) NOT NULL,
  uom           varchar(20) NOT NULL DEFAULT 'DRUM',
  division      division_t NOT NULL,
  low_threshold numeric(12,3) NOT NULL DEFAULT 0,
  is_valued     boolean NOT NULL DEFAULT true
);

CREATE TABLE stock_movements (
  id             bigserial PRIMARY KEY,
  item_id        smallint NOT NULL REFERENCES inventory_items(id),
  moved_on       date NOT NULL,
  direction      smallint NOT NULL CHECK (direction IN (1, -1)),
  quantity       numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost      numeric(14,4) NOT NULL DEFAULT 0,
  value          numeric(14,2) NOT NULL DEFAULT 0,     -- quantity * unit_cost
  source_type    varchar(60) NOT NULL,   -- Purchase|ExportSale|LocalSale|StockAdjustment|Opening
  source_id      bigint NOT NULL,
  is_reversal_of bigint REFERENCES stock_movements(id),
  posting_key    varchar(120) NOT NULL UNIQUE,  -- e.g. 'ExportSale:412:UCO:out' — idempotency
  balance_after  numeric(12,3) NOT NULL, -- running balance, written under row lock (§4.4.1)
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  notes          text
);
CREATE INDEX sm_item_date_idx ON stock_movements(item_id, moved_on, id);
CREATE INDEX sm_source_idx    ON stock_movements(source_type, source_id);

CREATE TABLE stock_balances (            -- cache, refreshed inside the same transaction
  item_id       smallint PRIMARY KEY REFERENCES inventory_items(id),
  quantity      numeric(12,3) NOT NULL DEFAULT 0,
  value         numeric(14,2) NOT NULL DEFAULT 0,
  avg_unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

#### 4.4.1 Concurrency

`balance_after` and `avg_unit_cost` are only correct if movements for one item serialise. Every stock write therefore begins with `SELECT … FROM stock_balances WHERE item_id = ? FOR UPDATE`, taken **before** any journal work, and released at commit. Items are locked in ascending `item_id` order when a single operation touches several (the treatment batch touches three) — this is what prevents deadlock between a batch completion and a concurrent sale. Isolation level stays `READ COMMITTED`; the row lock, not the isolation level, provides the guarantee.

#### 4.4.2 Valuation

Weighted moving average. On an inbound movement:
`new_avg = (old_qty * old_avg + in_qty * in_cost) / (old_qty + in_qty)`.
Outbound movements are costed at the average at the time of the movement, and that cost becomes COGS for gross-profit reporting.

**Backdating policy.** A moving average is order-dependent, so inserting a movement *before* existing ones silently invalidates every later `balance_after` and COGS figure. The rule:

- A backdated movement is allowed only if no later movement exists for that item, **or** the user holds `inventory.backdate` (Admin/Accountant).
- When permitted, the service replays the item's movements from the insertion point forward, rewriting `balance_after` and `unit_cost`, and posts a single **COGS adjustment** journal entry for the net change rather than rewriting historical journal entries.
- The replay is logged as a distinct activity-log action (`RECOST`) naming the item, date range, and value delta.
- Backdating into a locked fiscal year is refused outright (BR-24).

### 4.5 Accounting core

```sql
CREATE TABLE accounts (                  -- chart of accounts
  id        smallserial PRIMARY KEY,
  code      varchar(20) NOT NULL UNIQUE,
  name      varchar(120) NOT NULL,
  type      varchar(20) NOT NULL,  -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
  subtype   varchar(40),           -- CASH|BANK|AR|AP|INVENTORY|COGS|...
  parent_id smallint REFERENCES accounts(id),
  is_postable boolean NOT NULL DEFAULT true,
  is_control  boolean NOT NULL DEFAULT false,  -- AR/AP/INVENTORY: services only, no manual JE
  bank_name       varchar(120),               -- set when subtype = BANK
  account_number  varchar(60),
  is_active   boolean NOT NULL DEFAULT true
);
```

**Multiple cash and bank accounts.** The chart supports any number of `CASH` and `BANK` accounts (petty cash, main safe, two bank accounts) rather than the single hardcoded 1010/1020 pair. Every money movement names an `account_id`, not a free-text `"CASH"` / `"ONLINE"` string. `payment_methods` in settings maps a user-facing label to a target account, so adding a bank later is configuration, not a migration.

```sql
CREATE TABLE journal_entries (
  id             bigserial PRIMARY KEY,
  entry_no       varchar(30) NOT NULL UNIQUE,   -- JE-2026-000123
  entry_date     date NOT NULL,
  narration      text,
  source_type    varchar(60) NOT NULL,   -- document class, or 'ManualJournal'
  source_id      bigint NOT NULL,
  posting_key    varchar(120) NOT NULL UNIQUE,  -- idempotency (rule 10)
  is_reversal_of bigint REFERENCES journal_entries(id),
  is_manual      boolean NOT NULL DEFAULT false,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  posted_by      bigint NOT NULL REFERENCES users(id),
  posted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX je_reversal_once_idx ON journal_entries(is_reversal_of)
  WHERE is_reversal_of IS NOT NULL;     -- an entry can be reversed at most once

CREATE TABLE journal_lines (
  id         bigserial PRIMARY KEY,
  entry_id   bigint NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  entry_date date NOT NULL,      -- denormalised from the entry: lets every ledger and
                                 -- P&L query hit one index with no join (§9)
  account_id smallint NOT NULL REFERENCES accounts(id),
  debit      numeric(14,2) NOT NULL DEFAULT 0,
  credit     numeric(14,2) NOT NULL DEFAULT 0,
  party_id   bigint REFERENCES parties(id),   -- set on AR/AP lines
  division   division_t,                      -- set on income/COGS lines for divisional P&L
  currency   char(3),                         -- null = base currency; forward-compat (§16 Q5)
  fx_rate    numeric(14,6),                   -- rate applied to reach the base amounts above
  memo       varchar(255),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0))
);
CREATE INDEX jl_account_date_idx ON journal_lines(account_id, entry_date, id);
CREATE INDEX jl_party_idx        ON journal_lines(party_id, entry_date)
  WHERE party_id IS NOT NULL;
CREATE INDEX jl_division_idx     ON journal_lines(division, entry_date)
  WHERE division IS NOT NULL;

-- Balancing is enforced by the database, not only by the application.
CREATE CONSTRAINT TRIGGER je_must_balance
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
-- assert_entry_balanced(): SUM(debit) = SUM(credit) for NEW.entry_id, else RAISE EXCEPTION.
-- Deferred so a multi-line entry is checked once at COMMIT, not after each row.
```

An unbalanced entry is therefore **impossible to commit**, whatever the application does — a stronger guarantee than the assertion in `PostingService`, and one that also protects manual entries, data fixes, and future integrations.

**Seeded chart of accounts (minimum):**

| Code | Name | Type / subtype | Control |
|---|---|---|:--:|
| 1010 | Cash in Hand | ASSET / CASH | |
| 1011… | Additional cash accounts (petty cash, safe) | ASSET / CASH | |
| 1020 | Bank Account — primary | ASSET / BANK | |
| 1021… | Additional bank accounts | ASSET / BANK | |
| 1100 | Accounts Receivable | ASSET / AR | ✔ |
| 1200 | Inventory — UCO | ASSET / INVENTORY | ✔ |
| 1210 | Inventory — UEO | ASSET / INVENTORY | ✔ |
| 1220 | Inventory — Treated Water | ASSET / INVENTORY | ✔ |
| 1300 | Government Weight Fee Receivable | ASSET / RECEIVABLE | ✔ |
| 2100 | Accounts Payable | LIABILITY / AP | ✔ |
| 2200 | Salaries Payable | LIABILITY |
| 3000 | Owner's Capital | EQUITY |
| 3100 | Owner's Drawings | EQUITY (contra) |
| 4100 | Export Sales — UCO | INCOME |
| 4200 | Local Sales — UEO | INCOME |
| 4300 | Treatment Service Income | INCOME |
| 4400 | Treated Water Sales | INCOME |
| 5100 | COGS — UCO | EXPENSE / COGS |
| 5200 | COGS — UEO | EXPENSE / COGS |
| 5300 | COGS — Treated Water | EXPENSE / COGS |
| 5400 | Treatment Processing Cost | EXPENSE |
| 6xxx | Operating expenses (one per category) | EXPENSE |
| 6900 | Government Weight Fee Expense (non-refundable portion) | EXPENSE |

### 4.6 UCO division

```sql
CREATE TABLE purchases (                -- used by UCO and UEO
  id                bigserial PRIMARY KEY,
  doc_no            varchar(30) NOT NULL UNIQUE,   -- PUR-UCO-2026-000045
  division          division_t NOT NULL CHECK (division IN ('UCO','UEO')),
  purchase_date     date NOT NULL,
  source            varchar(30) NOT NULL,          -- IN_HOUSE_DRIVER | OUTSOURCED_DRIVER | DIRECT_AGREEMENT
  party_id          bigint REFERENCES parties(id), -- required for DIRECT_AGREEMENT
  agreement_id      bigint REFERENCES agreements(id),
  driver_id         bigint REFERENCES drivers(id), -- required for driver sources
  collection_area   varchar(120),
  drums             numeric(12,3) NOT NULL DEFAULT 0 CHECK (drums >= 0),
  rate_per_drum     numeric(14,2) NOT NULL DEFAULT 0,
  total_amount      numeric(14,2) NOT NULL DEFAULT 0,
  advance_deducted  numeric(14,2) NOT NULL DEFAULT 0, -- applied if source = IN_HOUSE_DRIVER
  amount_paid       numeric(14,2) NOT NULL DEFAULT 0, -- cash/online paid for outsourced/agreements
  balance_due       numeric(14,2) NOT NULL DEFAULT 0,
  payment_status    pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_purchase    boolean NOT NULL DEFAULT false,  -- zero-activity day marker
  notes             text,
  fiscal_year_id    int NOT NULL REFERENCES fiscal_years(id),
  created_by bigint, updated_by bigint,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz,
  CHECK (is_no_purchase = false OR (drums = 0 AND total_amount = 0))
);
CREATE INDEX pur_div_date_idx ON purchases(division, purchase_date);

CREATE TABLE weight_fees (
  id                bigserial PRIMARY KEY,
  purchase_id       bigint NOT NULL REFERENCES purchases(id),
  fee_paid          boolean NOT NULL DEFAULT false,
  fee_amount        numeric(14,2) NOT NULL DEFAULT 0,
  slip_number       varchar(60),
  attachment_id     bigint REFERENCES attachments(id),
  refund_eligible   boolean NOT NULL DEFAULT true,
  refund_status     refund_t NOT NULL DEFAULT 'PENDING',
  claimed_on        date,
  refund_amount     numeric(14,2) NOT NULL DEFAULT 0,   -- may differ from fee_amount
  refund_received_on date,
  gov_return_status varchar(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | RETURNED
  notes             text
);
CREATE INDEX wf_status_idx ON weight_fees(refund_status, claimed_on);

CREATE TABLE containers (
  id                bigserial PRIMARY KEY,
  container_number  varchar(40) NOT NULL,
  capacity_drums    numeric(12,3),        -- physical capacity, drives validation
  sale_id           bigint REFERENCES export_sales(id),
  UNIQUE (container_number, sale_id)
);

CREATE TABLE export_sales (
  id               bigserial PRIMARY KEY,
  doc_no           varchar(30) NOT NULL UNIQUE,   -- EXP-2026-000012
  export_date      date NOT NULL,
  party_id         bigint NOT NULL REFERENCES parties(id),   -- buyer
  destination_country varchar(80),
  container_count  smallint NOT NULL DEFAULT 0,
  drums            numeric(12,3) NOT NULL CHECK (drums > 0),
  rate_per_drum    numeric(14,2) NOT NULL,
  total_amount     numeric(14,2) NOT NULL,
  invoice_no       varchar(50),
  payment_method   varchar(40),
  amount_received  numeric(14,2) NOT NULL DEFAULT 0,
  balance_due      numeric(14,2) NOT NULL DEFAULT 0,
  payment_status   pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_sale       boolean NOT NULL DEFAULT false,
  notes            text,
  fiscal_year_id   int NOT NULL REFERENCES fiscal_years(id),
  created_by bigint, updated_by bigint,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);
```

### 4.7 UEO division

```sql
CREATE TABLE tankers (
  id             bigserial PRIMARY KEY,
  tanker_number  varchar(40) NOT NULL,
  capacity_drums numeric(12,3),
  sale_id        bigint REFERENCES local_sales(id)
);

CREATE TABLE local_sales (
  id              bigserial PRIMARY KEY,
  doc_no          varchar(30) NOT NULL UNIQUE,   -- LSL-2026-000031
  sale_date       date NOT NULL,
  party_id        bigint NOT NULL REFERENCES parties(id),
  tanker_number   varchar(40),
  drums           numeric(12,3) NOT NULL CHECK (drums > 0),
  rate_per_drum   numeric(14,2) NOT NULL,
  total_amount    numeric(14,2) NOT NULL,
  invoice_no      varchar(50),
  payment_method  varchar(40),
  amount_received numeric(14,2) NOT NULL DEFAULT 0,
  balance_due     numeric(14,2) NOT NULL DEFAULT 0,
  payment_status  pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_sale      boolean NOT NULL DEFAULT false,
  notes           text,
  fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id),
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);
```

```

### 4.8 Finance

```sql
CREATE TABLE expense_categories (
  id       smallserial PRIMARY KEY,
  name     varchar(80) NOT NULL UNIQUE,
  account_id smallint NOT NULL REFERENCES accounts(id),
  is_active boolean NOT NULL DEFAULT true
);
-- seeded: Salaries, Fuel, Electricity, Water, Rent, Kitchen,
--         Vehicle Maintenance, Machinery Maintenance, Chemicals,
--         Office Expenses, Miscellaneous

CREATE TABLE expenses (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  expense_date   date NOT NULL,
  category_id    smallint NOT NULL REFERENCES expense_categories(id),
  description    text,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id     smallint NOT NULL REFERENCES accounts(id),  -- cash/bank account credited
  method_label   varchar(40) NOT NULL,     -- display only
  attachment_id  bigint REFERENCES attachments(id),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);

CREATE TABLE salaries (
  id             bigserial PRIMARY KEY,
  employee_id    bigint NOT NULL REFERENCES employees(id),
  period_month   date NOT NULL,          -- first day of the salary month
  salary_amount  numeric(14,2) NOT NULL,
  advance_amount numeric(14,2) NOT NULL DEFAULT 0,
  remaining      numeric(14,2) NOT NULL DEFAULT 0,   -- salary - advance - paid
  paid_amount    numeric(14,2) NOT NULL DEFAULT 0,
  payment_date   date,
  account_id     smallint REFERENCES accounts(id),
  method_label   varchar(40),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  UNIQUE (employee_id, period_month)
);

CREATE TABLE owner_drawings (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  drawing_date   date NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id     smallint NOT NULL REFERENCES accounts(id),
  method_label   varchar(40) NOT NULL,
  purpose        varchar(160),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id)
);

CREATE TABLE payments (                 -- receipts and disbursements against any document
  id            bigserial PRIMARY KEY,
  doc_no        varchar(30) NOT NULL UNIQUE,
  payment_date  date NOT NULL,
  direction     varchar(10) NOT NULL,   -- IN | OUT
  party_id      bigint REFERENCES parties(id),
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id    smallint NOT NULL REFERENCES accounts(id),  -- which cash/bank account moved
  method_label  varchar(40) NOT NULL,   -- display only: 'Cash', 'Online', 'Cheque'
  reference_no  varchar(60),
  notes         text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id)
);

CREATE TABLE payment_allocations (      -- one payment may settle several documents
  id           bigserial PRIMARY KEY,
  payment_id   bigint NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  target_type  varchar(60) NOT NULL,    -- Purchase|ExportSale|LocalSale
  target_id    bigint NOT NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, target_type, target_id)
);
CREATE INDEX pa_target_idx ON payment_allocations(target_type, target_id);
-- Unallocated remainder (payment.amount - SUM(allocations)) sits on account as a party
-- credit; it is visible on the party ledger and applied to a later document.

CREATE TABLE bank_statement_lines (     -- IMPORTED from the bank; NOT a ledger
  id            bigserial PRIMARY KEY,
  account_id    smallint NOT NULL REFERENCES accounts(id),
  statement_ref varchar(60),
  txn_date      date NOT NULL,
  description   text,
  amount        numeric(14,2) NOT NULL,   -- signed: +credit / -debit as per statement
  matched_line_id bigint REFERENCES journal_lines(id),
  matched_at    timestamptz,
  matched_by    bigint REFERENCES users(id),
  UNIQUE (account_id, statement_ref, txn_date, amount, description)
);
```

**Why `bank_statement_lines` replaces a `bank_transactions` table.** A separate transactions table would be a *second* record of what the bank account did, competing with `journal_lines` on account 1020 — the exact duplication rule 2 forbids, and the usual cause of a bank ledger that disagrees with the trial balance. The bank ledger is now purely a query over `journal_lines`. This table holds only what the *bank* says, so reconciliation is a comparison between two genuinely independent records, which is the entire point of reconciling.

### 4.10 Cross-cutting

```sql
CREATE TABLE attachments (
  id            bigserial PRIMARY KEY,
  original_name varchar(255) NOT NULL,
  stored_path   varchar(400) NOT NULL,
  mime_type     varchar(120),
  size_bytes    bigint,
  sha256        char(64),
  uploaded_by   bigint NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id           bigserial PRIMARY KEY,
  user_id      bigint REFERENCES users(id),
  user_name    varchar(120) NOT NULL,   -- denormalised: survives user deletion
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  module       varchar(60) NOT NULL,
  action       varchar(30) NOT NULL,    -- CREATE|UPDATE|DELETE|LOGIN|EXPORT|LOCK|RESTORE
  record_type  varchar(60),
  record_id    bigint,
  record_label varchar(160),
  old_values   jsonb,
  new_values   jsonb,
  ip_address   inet,
  user_agent   text
);
CREATE INDEX al_time_idx   ON activity_logs(occurred_at DESC);
CREATE INDEX al_record_idx ON activity_logs(record_type, record_id);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  type        varchar(60) NOT NULL,   -- LOW_STOCK|PAYMENT_DUE|SALARY_DUE|
                                      -- CONTRACT_EXPIRY|REFUND_AGING|BACKUP_REMINDER|VACATION_END
  severity    varchar(10) NOT NULL DEFAULT 'INFO',
  title       varchar(160) NOT NULL,
  body        text,
  link_url    varchar(255),
  dedupe_key  varchar(160) UNIQUE,     -- prevents duplicate daily alerts
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 4.11 Reconciled caches and control-account invariants

Caches exist for speed, but a cache that can drift silently is worse than no cache. Every cached figure has a **stated invariant** and a nightly job that asserts it. Any failure raises a `SEVERE` notification naming the row, and the figure is shown in the UI with a warning badge until resolved.

| Cache | Invariant | Checked by |
|---|---|---|
| `stock_balances.quantity` | `= Σ(direction × quantity)` from `stock_movements` per item | `integrity:check` |
| `stock_balances.value` | `=` balance of the item's inventory control account (1200/1210/1220) | `integrity:check` |
| `purchases.balance_due` / `payment_status` | `= total_amount − Σ payment_allocations` | `integrity:check` |
| Sales `balance_due` / `payment_status` | same, per sale document | `integrity:check` |
| Party outstanding | `Σ` party's AR/AP journal lines `=` party ledger closing balance | `integrity:check` |
| AR control 1100 | `= Σ` all customer outstanding balances | `integrity:check` |
| AP control 2100 | `= Σ` all supplier outstanding balances | `integrity:check` |
| Weight Fee Receivable 1300 | `= Σ` fees with `refund_status IN (PENDING, CLAIMED)` | `integrity:check` |
| Driver Advance Balance 1110 | `= Σ` outstanding balances owed by in-house drivers | `integrity:check` |
| `monthly_summaries` | rebuilt nightly from the ledger; a differing rebuild is itself the alert | `summaries:rebuild` |

**Control accounts** (`accounts.is_control = true`) may be posted to **only** by domain services. Manual journal entries touching them are rejected at validation — this is what keeps AR, AP, and inventory tied to their subsidiary ledgers instead of drifting the moment someone posts a well-meaning correction.

---

## 5. Business rules — authoritative list

Each rule is implemented in exactly one place: a **domain service** wrapped in a database transaction. Controllers never touch balances.

| # | Rule | Source | Implemented in |
|---|---|---|---|
| BR-01 | Purchases are always recorded in drums | Bold §4 | `Purchase` validation, `drums` required |
| BR-02 | A UCO purchase belongs only to the UCO division | Bold §4 | DB `CHECK` + policy scope |
| BR-03 | Purchase increases the division's oil stock | Bold §7 | `PurchaseService::post()` → inbound `stock_movement` |
| BR-04 | Export sale decreases UCO stock | Bold §4 | `ExportSaleService::post()` → outbound movement |
| BR-05 | Local sale decreases UEO stock | Bold §5 | `LocalSaleService::post()` |
| BR-06 | Cooking oil (UCO) is exclusively for export | New Rule | `ExportSale` validation |
| BR-07 | Engine/Black oil (UEO) is exclusively for local sales | New Rule | `LocalSale` validation |
| BR-08 | In-house drivers use quota/advances to purchase | New Rule | `Purchase` posting deducts from 1110 |
| BR-09 | Outsourced drivers are paid directly (no advance) | New Rule | `Purchase` validation |
| BR-12 | Owner's drawings are **not** company expenses | Bold §8 / SRS §4.13 | posts to equity 3100, excluded from P&L expense totals |
| BR-13 | Expenses are company-wide, not division-tagged | SRS §4.9 | `expenses` has no `division` column |
| BR-14 | Cash ledger auto-updates on purchases, sales, expenses, salaries, drawings | SRS §4.14 | journal lines against 1010 |
| BR-15 | Bank ledger auto-updates on online payments, transfers, deposits, withdrawals | SRS §4.14 | journal lines against 1020 |
| BR-16 | Drums assigned to a container/tanker must not exceed physical capacity | SRS §4.7 | `ContainerCapacityRule` validation |
| BR-17 | Warn (not block) if a sale exceeds available stock | SRS §4.8 | `StockAvailabilityCheck` → soft warning, Admin override logged |
| BR-18 | Only the Administrator may delete activity logs | Bold §11 | `ActivityLogPolicy::delete()` |
| BR-19 | No operational record is ever auto-deleted; all years remain queryable | SRS §4.15, §5.1 | soft deletes + no purge job |
| BR-20 | Weight fee refund amount may differ from the amount paid | SRS §4.11 | separate `fee_amount` / `refund_amount` columns |
| BR-21 | Refund received must reconcile against the bank ledger | SRS §4.11 | `refund_received_on` creates a bank receipt journal entry |
| BR-22 | "No Purchase" / "No Sale" days are recorded with zero values | SRS §4.3, §4.6 | `is_no_purchase` / `is_no_sale`, excluded from totals, included in daily-completeness report |
| BR-23 | Drivers on vacation are marked unavailable in reports | SRS §4.2 | `driver_vacations` date-range join |
| BR-24 | Closed fiscal years are read-only (subject to §16 Q1) | SRS §6.1 | `FiscalYearLockMiddleware` on all write routes |
| BR-25 | Every journal entry must balance (Σdebit = Σcredit) | Accounting | **deferred DB constraint trigger** `je_must_balance` — not merely an app assertion |
| BR-26 | A document posts at most once, however many times the request is retried | Integrity | `posting_key` unique on `journal_entries` and `stock_movements` |
| BR-27 | Control accounts (AR, AP, Inventory, Fee Receivable) are never posted manually | Accounting | `ManualJournalRequest` rejects `is_control` accounts |
| BR-28 | A locked year accepts no writes at all, including reversals | SRS §6.1 | corrections post to the open year as dated adjustments |
| BR-29 | Backdated stock movements trigger a documented recost, never a silent one | Costing | `RecostService`, `inventory.backdate` permission, `RECOST` log action |
| BR-30 | Concurrent edits to one document cannot silently overwrite each other | SRS §2.1 (two accountants) | `version` column, optimistic lock, conflict shown as a diff |

### 5.1 Posting rules (document → journal)

| Document | Debit | Credit |
|---|---|---|
| Purchase (UCO/UEO) | Inventory 1200/1210 (total) | If in-house: Advances 1110. If outsourced/agreement: Cash/Bank + AP 2100 |
| Weight fee paid, refund-eligible | Weight Fee Receivable 1300 | Cash/Bank |
| Weight fee paid, not eligible | Weight Fee Expense 6900 | Cash/Bank |
| Refund received | Bank 1020 | Weight Fee Receivable 1300 (shortfall → 6900) |
| Export sale | Cash/Bank (received) + AR 1100 (balance) | Export Sales 4100 |
| Export sale — COGS | COGS 5100 | Inventory 1200 |
| Local sale | Cash/Bank + AR 1100 | Local Sales 4200 |
| Local sale — COGS | COGS 5200 | Inventory 1210 |
| Expense | Expense 6xxx | Cash/Bank |
| Salary paid | Salaries expense 6100 | Cash/Bank (+ Salaries Payable 2200 for the unpaid remainder) |
| Owner's drawing | Owner's Drawings 3100 | Cash/Bank |
| Payment received on account | Cash/Bank | AR 1100 |
| Payment made on account | AP 2100 | Cash/Bank |
| Driver advance issued | Advances to Drivers 1110 | Cash/Bank |
| Opening balances (cut-over) | Cash, Bank, Inventory, AR, Fee Receivable, Advances | AP, Salaries Payable, Owner's Capital (balancing figure) |
| Backdated recost adjustment | COGS 5x00 (or credit, if negative) | Inventory 12x0 |

"Cash/Bank" above means **the specific `account_id` the payment names**, resolved from the payment method, not a fixed 1010/1020.

---

## 6. Module implementation

Each module follows the same shape:

```
app/Domain/<Module>/
  Models/            Eloquent models, casts, relationships, scopes
  Services/          <X>Service.php   — create/update/void, wraps DB::transaction
  Actions/           single-purpose operations (PostToJournal, MoveStock, …)
  Policies/          <X>Policy.php    — role gates
  Http/Requests/     FormRequest validation
  Http/Controllers/  thin: validate → service → redirect/Inertia response
  Reports/           query builders returning DTOs used by web/PDF/Excel alike
resources/js/Pages/<Module>/   Index.tsx, Form.tsx, Show.tsx
tests/Feature/<Module>/        HTTP + business-rule tests
```

### 6.1 Authentication & RBAC (SRS §3, Bold §2)

The system has **exactly three profiles**. There is no Manager and no Data Entry Operator — every entry is made by the Accountant or the Administrator.

| Profile | What it is |
|---|---|
| **Administrator** | Everything the Accountant can do, **plus deletion and administration** (users, settings, backups, year locks) |
| **Accountant** | All day-to-day entry and finance work: purchases, sales, expenses, journals, master data, reports |
| **Auditor** | Read-only across all modules and all historical years, plus the activity log |

**The single difference between Administrator and Accountant is deletion.** The Accountant creates and edits everything but cannot delete: `operations.delete` and `activity_log.delete` are the Administrator's alone. Deleting a posted document is the one action that rewrites history, so it stays with one person. An Accountant who needs a document undone posts a reversal (BR-19) — which is the correct accounting answer anyway, since it leaves the trail intact.

Permission matrix — seeded, editable by Administrator only:

| Permission group | Admin | Accountant | Auditor |
|---|:--:|:--:|:--:|
| operations.view | ✔ | ✔ | ✔ |
| operations.create / update | ✔ | ✔ | — |
| operations.delete | ✔ | — | — |
| finance.view | ✔ | ✔ | ✔ |
| finance.manage | ✔ | ✔ | — |
| journal.manual | ✔ | ✔ | — |
| inventory.backdate | ✔ | ✔ | — |
| inventory.adjust | ✔ | — | — |
| profit.view | ✔ | ✔ | ✔ |
| reports.view / export | ✔ | ✔ | ✔ |
| masters.manage | ✔ | ✔ | — |
| users.manage | ✔ | — | — |
| settings.manage | ✔ | — | — |
| activity_log.view | ✔ | — | ✔ |
| activity_log.delete | ✔ | — | — |
| backup.run / restore | ✔ | — | — |
| year.lock / unlock | ✔ | — | — |

Implementation notes:
- 2FA (TOTP) is **required** for Administrator and Accountant, optional for others — enforced by a `RequiresTwoFactor` middleware on those roles.
- Session lifetime 8 hours, idle timeout 30 minutes, single-device re-auth prompt on password change.

### 6.2 Dashboard (Bold §3, SRS §4.1)

Four cards, each backed by one cached query (Redis, 60-second TTL, invalidated on any posting).

**Company Summary:** Today's purchases / sales / expenses · Monthly & Annual Net Profit · Cash Balance · Bank Balance · Total Expenses · Owner's Drawings · Total Outstanding Refunds Owed by Government · Recent Transactions (last 20 across all documents, unioned view).

**UCO Summary:** Drums Purchased (MTD/YTD) · Current UCO Stock · Export Sales value · Containers Exported · Monthly & Annual Gross Profit.

**UEO Summary:** Drums Purchased · Current UEO Stock · Local Sales value · Tankers Sold · Monthly & Annual Gross Profit.

Gross profit per division = Σ(income lines with that `division`) − Σ(COGS lines with that `division`). Net profit is company-wide only: gross profit across all divisions minus operating expenses (drawings excluded, BR-12).

### 6.3 UCO division

- **Supplier management** → `parties` filtered to `SUPPLIER`, with a transaction-history tab (purchases + payments, running balance) and outstanding balance from AR/AP aggregation.
- **Purchase entry** — one screen, sections: Basic / Details / Payment / Weight Fee / Additional. Rate × drums auto-computes total.
- **In-House Driver** — a purchase with `source = IN_HOUSE_DRIVER`. Instead of paying the driver in cash/online, the total is deducted from their `advance_balance` (quota).
- **Outsourced Driver** — a purchase with `source = OUTSOURCED_DRIVER`. Paid directly via cash/online.
- **Direct agreements** — agreement record + purchases linked via `agreement_id` (source = DIRECT_AGREEMENT).
- **Export sales** — buyer, country, container list (repeater rows writing to `containers`), drums, rate, invoice, payment status. Capacity validation per BR-16, stock check per BR-17.

### 6.4 UEO division

Same purchase screen as UCO with `division = UEO`. Local sales mirror export sales with a tanker instead of containers.

### 6.5 Inventory

- Four items seeded. Stock screen shows: on-hand quantity, average unit cost, total value, low threshold, status badge.
- **Movement ledger** per item — a full audit trail with drill-through links to the source document.
- **Stock adjustment** — Admin-only, requires a reason; posts an inventory-shrinkage/gain journal entry. This is the only way a quantity changes outside a business document.
- **Reconciliation check** — a nightly job asserts `stock_balances.quantity == SUM(direction * quantity)` per item and `stock_balances.value == inventory account balance`; any drift raises a `SEVERE` notification.

### 6.7 Finance

- **Expenses** — category-driven, receipt attachment, cash/bank split.
- **Salaries** — monthly grid per employee: salary, advance, paid, remaining. Advances are recorded when given, then netted at payment.
- **Owner's drawings** — separate module and separate report, never appearing in expense totals (BR-12). The P&L template shows drawings in a distinct "Equity movements" block below net profit.
- **Payments** — one receipt or disbursement can settle several documents (`payment_allocations`). The screen shows the party's open documents oldest-first with a suggested allocation; any unallocated remainder stays as a party credit rather than being forced onto an arbitrary invoice.
- **Cash & bank ledgers** — running-balance views derived from `journal_lines`, one tab per cash/bank account, with opening balance, date filters, and export. No separate transactions table backs these (§4.9).
- **Bank reconciliation** — import statement lines (CSV/OFX) or hand-enter them into `bank_statement_lines`, auto-match against unreconciled `journal_lines` on the same account by amount + date window ±3 days + reference, present unmatched on both sides, and produce a reconciliation statement (book balance → outstanding items → statement balance). Matching sets `matched_line_id`; it never edits either side.
- **Manual journal entry** — Admin and Accountant only, for accruals, corrections, and the opening-balance entry. Control accounts are blocked (BR-27), the entry must balance before Save, and every manual entry requires a narration. Manual entries are flagged `is_manual` and listed in their own report so an auditor can review exactly what was posted outside the document flow.
- **Government weight fee** — the refund pipeline. List view grouped by `refund_status` with an aging bucket on `claimed_on` (0–30 / 31–60 / 60+ days, threshold configurable). Bulk action: mark a set of slips as Claimed with a claim date. Receiving a refund records the bank receipt and closes the receivable (BR-21).

### 6.8 Reports

Every report is one class implementing `ReportContract` with `filters()`, `columns()`, `rows()`, `totals()`. Web view, PDF, Excel, and print all consume the same class — no divergence between formats.

**Common filters:** date range (with presets: today, this month, this year, custom), fiscal year, division, party, driver, payment status.

| Group | Reports |
|---|---|
| UCO | Daily/Monthly/Annual Purchases · Driver Collections · Agreement Purchases · Export Sales · Container Report · Gross Profit |
| UEO | Daily/Monthly/Annual Purchases · Local Sales · Tanker Report · Gross Profit |
| Inventory | Stock on Hand · Stock Movement Ledger · Stock Valuation · Low Stock |
| Finance | Combined Purchases · Combined Sales · Expense Summary (by category/month) · Salary Report · Owner's Drawings · Cash Ledger · Bank Ledger · Bank Reconciliation · Weight Fee & Refund Aging · AR/AP Aging (0–30/31–60/60+) · Monthly & Annual P&L · Trial Balance |
| Comparative | Year-over-year Net Profit · Division contribution · Multi-year purchase/sale trend |

Exports: PDF (dompdf, company letterhead from settings), Excel (`.xlsx`, one sheet per report, frozen header, totals row), and a print stylesheet. Exports over 5,000 rows are queued and delivered as a download notification.

### 6.9 Activity log

- Model observers write an `activity_logs` row on every create/update/delete with a JSON before/after diff, plus explicit rows for login, failed login, export, year lock/unlock, backup, and restore.
- Viewer: filters by user, date range, module, action; a record timeline showing every change to a single document.
- Deletion is Administrator-only (BR-18), requires a typed confirmation, and — deliberately — writes its own log entry recording the deletion range before removing rows.

### 6.10 Notifications

A scheduled job (`notifications:scan`, hourly) evaluates rules and writes deduplicated `notifications` rows. Delivery is in-app (bell menu with unread count); email is a later add-on.

| Rule | Trigger |
|---|---|
| LOW_STOCK | `stock_balances.quantity < inventory_items.low_threshold` |
| PAYMENT_DUE | AR/AP entry past `credit_terms_days`, or due within 3 days |
| SALARY_DUE | Salary month with `remaining > 0` past the configured pay day |
| CONTRACT_EXPIRY | `agreements.expires_on` within 30 days |
| REFUND_AGING | `refund_status = CLAIMED` and `claimed_on` older than the configured threshold |
| VACATION_END | `driver_vacations.ends_on` within 2 days |
| BACKUP_REMINDER | No successful backup in the last 24 hours |
| INTEGRITY_ALERT | Stock or journal reconciliation drift detected |

### 6.11 Settings & administration

Company profile · Users & roles · Expense categories · Payment methods · Government fee label · Low-stock thresholds per item · Refund aging threshold · Year-end lock policy · Backup schedule and destination · Restore (Administrator, requires confirmation and puts the app in maintenance mode) · Fiscal year open/close.

---

## 7. API / route surface

Inertia pages plus a small internal JSON API for pickers and dashboards. All routes sit behind `auth`, `verified`, `two-factor`, and `fiscal-year-lock` middleware.

```
GET|POST   /uco/purchases            index, store
GET|PUT    /uco/purchases/{id}       show/edit, update
DELETE     /uco/purchases/{id}       soft delete + reversing journal entry
POST       /uco/purchases/no-entry   record a "No Purchase" day
GET|POST   /uco/export-sales
GET|POST   /uco/agreements
GET        /uco/containers
GET|POST   /ueo/local-sales
GET        /inventory                    balances
GET        /inventory/{item}/movements
POST       /inventory/adjustments        Admin only
GET|POST   /finance/expenses
GET|POST   /finance/salaries
GET|POST   /finance/drawings
GET|POST   /finance/payments
GET        /finance/cash-ledger?account=
GET        /finance/bank-ledger?account=
GET|POST   /finance/journal              manual entries (journal.manual, control accts blocked)
GET        /finance/journal/{id}         entry + lines + source document link
POST       /finance/journal/{id}/reverse
GET|POST   /finance/reconciliation
POST       /finance/reconciliation/import      statement upload
POST       /finance/reconciliation/match       {statement_line_id, journal_line_id}
GET|PUT    /finance/weight-fees
POST       /finance/weight-fees/bulk-claim
GET        /reports/{group}/{report}
POST       /reports/{group}/{report}/export   {format: pdf|xlsx}
GET        /admin/users, /admin/activity-log, /admin/settings
POST       /admin/backups, /admin/backups/{id}/restore
POST       /admin/fiscal-years/{id}/lock|unlock

# JSON helpers
GET /api/parties/search?type=&q=
GET /api/stock/availability?item=&qty=
GET /api/dashboard/{card}
```

**Deletion semantics:** deleting a posted document never removes journal or stock rows. It soft-deletes the document and posts a **reversing** journal entry plus reversing stock movements, both linked via `is_reversal_of`. The trail stays intact.

---

## 8. Validation rules (representative)

| Field | Rule |
|---|---|
| `drums`, `quantity` | `> 0`, max 3 decimals; `= 0` only when a No-Purchase/No-Sale flag is set |
| `rate_per_drum`, `amount` | `>= 0`, exactly 2 decimals |
| `cash_paid + online_paid` | `<= total_amount`; overpayment requires an explicit "advance" flag |
| `purchase_date`, `sale_date` | not in the future; must fall inside an unlocked fiscal year |
| `slip_number` | required when `fee_paid = true`; unique per fiscal year |
| Weight fee attachment | required when `fee_paid = true`; PDF/JPG/PNG, ≤ 10 MB |
| `refund_amount` | required when `refund_status = RECEIVED`; may differ from `fee_amount` |
| Container/tanker drums | Σ assigned drums ≤ `capacity_drums` (BR-16) |
| Sale drums | soft warning if > available stock; Admin override recorded in the activity log |
| `invoice_no` | unique per division per fiscal year when present |

---

## 9. Performance plan

Targets: dashboard and current-month reports **< 2 s**; historical multi-year reports **< 5 s** at tens of thousands of rows (SRS §5.2).

- Indexes on `(division, date)`, `(party_id, date)`, `(driver_id, date)`, `(item_id, moved_on, id)`, and — because `entry_date` is denormalised onto `journal_lines` — `(account_id, entry_date, id)`, `(party_id, entry_date)`, `(division, entry_date)`. Every ledger, aging, and P&L query is then an index-only range scan with **no join to `journal_entries`**, which is what makes the multi-year targets reachable.
- `stock_balances` and a `monthly_summaries` table (division, year, month, purchases, sales, cogs, expenses, profit) maintained incrementally on posting — historical-year reports read summaries, not raw rows, and drill into raw rows only on demand.
- Redis caching of dashboard cards, invalidated by a `DocumentPosted` event.
- Cursor pagination on all list screens (50 rows/page); server-side filtering only, never client-side.
- Large exports run on the queue.
- Partition `activity_logs` by year once it exceeds ~2 M rows.

---

## 10. Security implementation

- RBAC at route (middleware), record (policy), and field (DTO) level.
- 2FA/TOTP mandatory for Administrator and Accountant.
- Bcrypt (cost 12) password hashing; minimum 12-character passwords; lockout after 5 failed attempts for 15 minutes; all attempts logged.
- CSRF on every mutating request; strict Content-Security-Policy; `SameSite=Strict` session cookies.
- Attachments stored outside the web root and served through an authorising controller — never a direct file URL.
- All input validated server-side through FormRequests; all output escaped by React; queries only via the query builder or bound parameters.
- Internal TLS certificate; HTTP redirected to HTTPS; HSTS on the internal host.
- Database user for the app has no `DROP`/`TRUNCATE` grants; migrations run under a separate account.
- Backups encrypted at rest (AES-256) with the passphrase held by the Administrator, off-system.

---

## 11. Testing strategy

| Level | Tool | Coverage target |
|---|---|---|
| Unit | Pest/PHPUnit | Every posting rule, valuation math, aging buckets, allocation |
| Feature (HTTP) | Pest + Laravel test client | Every route × every role (permission matrix as a data provider) |
| Business rule | Dedicated `tests/Feature/BusinessRules/` | One test per BR-01…BR-25, named after the rule |
| Integrity | Scheduled + test | Journal balances, stock reconciliation, AR/AP tie-out to party balances |
| Report | Snapshot | Golden fixtures for P&L, aging, gross profit per division |
| E2E | Playwright | Purchase→sale→P&L flow; treatment batch flow; refund pipeline; year lock |
| Performance | k6 against seeded 3-year dataset (~60 k documents) | The §9 targets |

**Non-negotiable test set** — these must exist before go-live:

1. In-house driver purchase deducts from their advance balance instead of creating a payable.
2. Outsourced driver purchase creates a payable/cash payment directly.
3. Owner's drawing never appears in P&L expenses (BR-12).
4. Deleting a posted purchase produces a reversal, not a data hole.
6. Auditor gets `403` on every write route.
7. Data Entry Operator's report payload contains no profit fields.
8. A write dated inside a locked fiscal year is rejected (BR-24).
9. Weight fee refund received for less than the amount paid books the shortfall to expense (BR-20).
10. Concurrent sales of the same stock item cannot drive the balance below zero without a logged override (row-level lock on `stock_balances`).
11. Submitting the same posting twice (double-click, retried request) creates **one** journal entry and one set of stock movements (BR-26).
12. An unbalanced entry inserted directly via SQL is rejected by the database at COMMIT (BR-25) — proves the guarantee is not app-only.
13. A backdated purchase recosts subsequent movements and posts a COGS adjustment whose value equals the recomputed delta (BR-29).
14. A manual journal entry touching AR, AP, or an inventory account is rejected (BR-27).
15. Two users editing one purchase: the second save is rejected with a conflict, not silently applied (BR-30).
16. A payment split across three invoices allocates exactly, and the unallocated remainder appears as a party credit.
17. Every `integrity:check` invariant in §4.11 is asserted against a seeded dataset containing deliberate drift.

---

## 12. Build order — feature by feature

No timeboxes. The system is built as a sequence of **features**, each one small enough to implement, test, and verify in a single sitting before the next begins. A feature is finished only when its *Done when* condition is demonstrably true — not when the code compiles.

**The one rule that governs the order:** never build a feature that writes to the ledgers before the ledgers themselves are correct and tested. Everything else is negotiable; this is not. A division module built on an unverified posting engine produces wrong numbers that look right, and every feature added afterwards inherits the error.

### Legend

- **Depends on** — features that must be complete and green first.
- **Done when** — the observable condition that ends the feature. Write this test first.

---

### Stage A — Foundation

| # | Feature | Depends on | Done when |
|---|---|---|---|
| A1 | Repo, Docker Compose (app, web, db, redis, worker, scheduler), CI running the test suite | — | `docker compose up` serves a page; CI is green on an empty suite |
| A2 | Schema migrations for all tables in §4, plus seeders (chart of accounts, inventory items, expense categories, roles, permissions, settings) | A1 | A fresh database migrates and seeds with no manual step |
| A3 | Authentication: login, logout, password rules, lockout after 5 failures | A2 | A wrong password 5× locks the account for 15 minutes and logs every attempt |
| A4 | RBAC: roles, permissions, policies, the §6.1 matrix as a seeded fixture | A3 | A test iterates the whole matrix; every cell passes |
| A5 | Two-factor authentication (TOTP), mandatory for Admin and Accountant | A4 | An Accountant without 2FA enrolled is forced through setup before any other route |
| A6 | Application shell: navigation per §7, layout, list/form/detail component primitives | A4 | Navigation renders exactly the modules the current role may see |
| A7 | Activity log: model observers, before/after diffs, explicit login/export/lock events, viewer with filters | A6 | Every write in the app produces a log row with a readable diff |
| A8 | Settings module: company profile, payment methods, categories, thresholds, fee label | A6 | Changing the government fee label changes it everywhere in the UI |
| A9 | Attachments: upload, hash, authorising download controller | A6 | A direct file URL without a session returns 403 |

### Stage B — Ledger core (the critical path)

Nothing in Stage C or later may begin until every feature here is green.

| # | Feature | Depends on | Done when |
|---|---|---|---|
| B1 | Chart of accounts CRUD, multi cash/bank accounts, `is_control` flag | A2 | A second bank account can be added through the UI and is selectable as a payment target |
| B2 | Fiscal years: create, open, lock, unlock; `FiscalYearLockMiddleware` | B1 | A write dated inside a locked year is rejected on every write route (BR-24, BR-28) |
| B3 | `je_must_balance` deferred constraint trigger | B1 | An unbalanced entry inserted **by raw SQL** is rejected at COMMIT (BR-25) |
| B4 | `PostingService`: build entry, post lines, idempotent `posting_key`, reversal | B3 | Posting the same key twice creates one entry; reversing produces a mirror entry (BR-26) |
| B5 | Manual journal entry screen, control-account block, `is_manual` flag and report | B4 | A manual entry touching AR, AP, or inventory is refused (BR-27) |
| B6 | Cash & bank ledger views, running balance, per account, date filters, export | B4 | Ledger closing balance equals the account balance in the trial balance |
| B7 | Trial balance report | B4 | Total debits equal total credits on a seeded multi-document dataset |
| B8 | Opening-balance entry: guided screen producing one dated journal entry | B5 | Cut-over cash, bank, stock, and party balances reproduce exactly and the entry balances |

### Stage C — Inventory core

| # | Feature | Depends on | Done when |
|---|---|---|---|
| C1 | Inventory items, thresholds, `stock_balances` | A2 | Four items seeded with correct division and valuation flags |
| C2 | `StockService`: movement writing, `FOR UPDATE` locking, ascending item-id lock order, `balance_after` | C1, B4 | Two concurrent movements on one item serialise; neither balance is lost |
| C3 | Weighted-average valuation, inbound recalculation, outbound costing | C2 | Average cost after a mixed-rate purchase sequence matches a hand-worked example |
| C4 | Stock movement ledger view with drill-through to source documents | C2 | Every movement links to the document that caused it |
| C5 | Recost / backdating: permission gate, forward replay, COGS adjustment entry, `RECOST` log action | C3, B4 | A backdated purchase recosts later movements and posts an adjustment equal to the delta (BR-29) |
| C6 | Stock adjustment (Admin), reason required, journal posting | C3 | An adjustment moves both quantity and the inventory control account |

### Stage D — Master data

| # | Feature | Depends on | Done when |
|---|---|---|---|
| D1 | Parties: suppliers, customers, industrial companies; code generation; search API | A6 | A party can be created and found by the picker used on every document form |
| D2 | Party ledger tab: transaction history and running outstanding balance from the journal | D1, B6 | Party closing balance equals its share of the AR/AP control account |
| D3 | Agreements with expiry date | D1 | An agreement's rate pre-fills a purchase and the variance hint appears when overridden |
| D4 | Drivers, vacations, availability rule | A6 | A driver on vacation is flagged unavailable in the date range (BR-23) |
| D5 | Employees | A6 | CRUD complete, feeding salary entry |

### Stage E — Shared document machinery

Built once, reused by every division. Building this before Stage F is what keeps the three divisions from drifting into three different implementations.

| # | Feature | Depends on | Done when |
|---|---|---|---|
| E1 | Document numbering service (`PUR-UCO-2026-000045` etc.), gap-free per series per year | B2 | Concurrent creates never collide or skip a number |
| E2 | Optimistic locking: `version` column, conflict response, diff UI | A6 | Two users editing one document — the second save is rejected with a diff (BR-30) |
| E3 | Payment entry + `payment_allocations` (one payment, several documents, remainder as party credit) | D2, B4 | A payment split across three invoices allocates exactly to the cent |
| E4 | Document payment status recomputation from allocations | E3 | `balance_due` and `payment_status` always equal `total − Σ allocations` |
| E5 | Document deletion as reversal: soft delete + reversing journal and stock movements | B4, C2 | Deleting a posted document leaves the trail intact and the balances correct |
| E6 | Stock availability check (soft warning, logged Admin override) | C2 | A sale exceeding stock warns, proceeds only on override, and logs it (BR-17) |

### Stage F — Divisions

Order chosen deliberately: UCO first because it exercises the most machinery (purchases, weight fees, drivers, agreements, exports, containers); UEO is then largely configuration of the same code; WTD last because it is the only division that both consumes and produces stock.

| # | Feature | Depends on | Done when |
|---|---|---|---|
| F1 | Purchase entry (shared UCO/UEO), rate × drums, payment split, posting | E1–E5, C3 | A purchase raises stock, raises inventory value, and creates the payable |
| F2 | Government weight fee sub-form: slip, attachment, eligibility | F1, A9 | A fee marked paid requires slip number and attachment before save |
| F3 | Driver collections (purchase with `source = DRIVER_COLLECTION`), daily/monthly/annual roll-ups | F1, D4 | Per-driver totals reconcile to the underlying purchases |
| F4 | Direct agreement purchases | F1, D3 | Agreement purchases report separately from driver collections |
| F5 | "No Purchase" / "No Sale" day markers | F1 | A no-purchase day is excluded from totals but present in the daily-completeness report (BR-22) |
| F6 | Export sales with container repeater and capacity validation | F1, E6 | Drums exceeding container capacity are rejected (BR-16); the sale reduces UCO stock and posts COGS |
| F7 | UEO purchases and local sales with tanker | F1, F6 | Same behaviour on the UEO item; UEO stock screen shows purchased vs recovered split |

### Stage G — Finance

| # | Feature | Depends on | Done when |
|---|---|---|---|
| G1 | Expenses with category, attachment, account selection | B4, A8 | Expense hits the right expense account and the right cash/bank account |
| G2 | Salaries: monthly grid, advances, remaining, payment | D5, B4 | Advance then payment nets correctly; unpaid remainder sits in Salaries Payable |
| G3 | Owner's drawings | B4 | Appears in equity movement and the drawings report, and **nowhere** in expenses (BR-12) |
| G4 | Weight fee refund pipeline: status transitions, bulk claim, refund receipt posting | F2, B4 | Paid → Claimed → Received reconciles against the bank ledger; a short refund books the shortfall to expense (BR-20, BR-21) |
| G5 | Refund aging report with configurable threshold | G4 | Slips stuck in Claimed past the threshold are listed and flagged |
| G6 | Bank statement import (CSV/OFX) into `bank_statement_lines` | B6 | Re-importing the same statement creates no duplicates |
| G7 | Bank reconciliation: auto-match, manual match, reconciliation statement | G6 | Book balance → outstanding items → statement balance ties out |
| G8 | AR/AP aging (0–30 / 31–60 / 60+) | D2 | Aging totals equal the AR and AP control account balances |

### Stage H — Reporting

| # | Feature | Depends on | Done when |
|---|---|---|---|
| H1 | `ReportContract` abstraction — one class drives web, PDF, Excel, and print | B7 | A single report renders identically in all four outputs |
| H2 | PDF export with letterhead from settings | H1, A8 | A report prints legibly on A4 |
| H3 | Excel export, chunked, frozen header, totals row | H1 | A 20,000-row report exports without exhausting memory |
| H4 | Queued export with download notification for large reports | H3 | A report over 5,000 rows queues and notifies on completion |
| H5 | UCO report set | H1, F6 | Every UCO report in §6.8 renders and reconciles to the ledger |
| H6 | UEO report set | H1, F7 | As above |
| H8 | Inventory reports: on hand, movements, valuation, low stock | H1, C4 | Valuation equals the inventory control accounts |
| H9 | Finance reports: expenses, salaries, drawings, ledgers, P&L | H1, G3 | P&L net profit ties to the equity movement for the period |
| H10 | `monthly_summaries` table and incremental maintenance | H9 | A nightly rebuild produces identical figures to the incremental values |
| H11 | Dashboard: four cards per §6.2, Redis-cached, invalidated on posting | H10 | Every dashboard figure equals the corresponding report, to the cent |
| H12 | Year-over-year comparison and multi-year trend views | H10 | Multi-year query meets the §9 target |

### Stage I — Integrity, alerts, operations

| # | Feature | Depends on | Done when |
|---|---|---|---|
| I1 | `integrity:check` — every invariant in §4.11 | H10 | Deliberately seeded drift is detected and reported for each invariant |
| I2 | Notification engine + the eight rules in §6.10, deduplicated | I1 | Each rule fires once per condition per day, no duplicates |
| I3 | In-app notification centre with unread count | I2, A6 | Alerts are visible and dismissible |
| I4 | Backup job: `pg_dump` + attachments, dated, encrypted, off-box copy | A1 | A backup completes and is written to both destinations |
| I5 | Restore: Administrator, maintenance mode, confirmation | I4 | A backup restores into a clean environment with zero row-count drift |
| I6 | `backup:verify` — automated weekly restore into a scratch database | I5 | A corrupted backup is detected without human involvement |
| I7 | Scheduler wiring for all jobs in §13 | I2, I4 | All jobs run on schedule and log their outcome |

### Stage J — Hardening and cut-over

| # | Feature | Depends on | Done when |
|---|---|---|---|
| J1 | Performance pass: indexes, query plans, cursor pagination, cache tuning | H12 | The §9 targets are met on a seeded three-year dataset |
| J2 | Security pass: CSP, headers, TLS, permission audit, dependency scan | A5 | The §10 checklist is fully satisfied |
| J3 | E2E suite (Playwright) covering the flows in §11 | H11 | All flows pass against a production-like build |
| J4 | Field-level RBAC verification: profit hidden from Data Entry payloads | A4, H9 | The report JSON for that role contains no profit fields |
| J5 | Spreadsheet data migration and reconciliation to the opening entry | B8 | Migrated balances match the accountant's signed-off figures |
| J6 | User manuals per role, admin runbook (backup, restore, update, rebuild) | I7 | A rebuild from bare hardware succeeds by following the runbook alone |
| J7 | UAT against §14 | J1–J6 | All 16 acceptance criteria signed off |

### Dependency shape

```
  A (foundation)
      │
      ├──────────────┬───────────────┐
      ▼              ▼               ▼
  B (ledger)      D (masters)    A7 activity log
      │              │
      ├──► C (inventory)
      │        │
      ▼        ▼
       E (document machinery)
              │
      ┌───────┴────────┐
      ▼                ▼
  F (divisions)     G (finance)
      └───────┬────────┘
              ▼
          H (reporting)
              │
              ▼
       I (integrity & ops)
              │
              ▼
        J (hardening & cut-over)
```

Stages A, B, C, E, H, and J are strictly sequential on the critical path. Within F and G, individual features can be built in any order their own dependencies allow, and all of Stage G is independent of Stage F except G4, which needs the weight fee form from F2.

---

## 13. Environment & operations

```yaml
# docker-compose.yml (shape)
services:
  app:      { build: ., depends_on: [db, redis], volumes: ["./storage:/app/storage"] }
  web:      { image: nginx:alpine, ports: ["80:80", "443:443"], depends_on: [app] }
  db:       { image: postgres:16, volumes: ["pgdata:/var/lib/postgresql/data"] }
  redis:    { image: redis:7 }
  worker:   { build: ., command: "php artisan queue:work --tries=3" }
  scheduler:{ build: ., command: "php artisan schedule:work" }
  backup:   { build: ./ops/backup, volumes: ["./backups:/backups", "//NAS/orcms:/offsite"] }
```

**Scheduled jobs:**

| Time | Job |
|---|---|
| Hourly | `notifications:scan` |
| 01:00 | `backup:run` — `pg_dump -Fc` + attachment sync, dated, encrypted |
| 01:30 | `integrity:check` — every invariant in §4.11 (control accounts, stock, document balances, cache drift) |
| 02:00 | `summaries:rebuild` — recompute the previous day's `monthly_summaries` rows |
| Weekly Sun | `backup:verify` — restore the newest dump into a scratch database and assert row counts |

**Retention:** nightly backups for 30 days, weekly for 12 months, monthly forever (matching the indefinite-retention requirement).

**Update procedure:** `git pull` → `docker compose build` → `php artisan down` → `migrate --force` → `docker compose up -d` → `php artisan up`. Roll back by redeploying the previous image tag and restoring the pre-migration dump.

---

## 14. Acceptance criteria

The system is accepted when all of the following hold on production data:

1. Both divisions record their full document set, and each division's operational reports reconcile to its journal postings.
2. Dashboard figures equal the underlying reports for the same period, to the cent.
3. Stock on hand equals opening + purchases − sales − adjustments for every item, verified for a full month.
4. Owner's drawings appear in the drawings report and equity movement, and nowhere in expenses.
7. Trial balance balances; P&L net profit ties to the equity movement for the period.
8. Weight fee refund lifecycle (paid → claimed → received) reconciles to the bank ledger, and the aging report flags anything past the threshold.
9. AR/AP aging totals equal the sum of party outstanding balances.
10. Every role sees exactly the permission matrix in §6.1, verified by test.
11. Every report exports to PDF and Excel and prints legibly on A4.
12. The activity log contains an entry for every create/update/delete performed during UAT.
13. Performance targets in §9 are met on the seeded 3-year dataset.
14. A backup taken during UAT restores into a clean environment with zero row-count drift.
15. `integrity:check` runs clean against the full UAT dataset — every control account ties to its subsidiary ledger and no cache has drifted (§4.11).
16. The opening-balance journal entry is reviewed, signed off by the accountant, and reproduces the agreed cut-over cash, bank, stock, and party balances exactly.

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Single office server fails | Total outage | Nightly off-box backups, documented 4-hour rebuild runbook, spare-hardware plan |
| Spreadsheet migration carries bad opening balances | Wrong balances from day one | Opening-balance journal reviewed and signed off by the accountant before go-live |
| Fiscal-year lock decision deferred (§16 Q1) | Rework in the reporting layer | Build the lock mechanism now; the *policy* is a settings toggle |
| Weighted-average costing disputed by the auditor | Restated gross profit | Confirm the costing method with the auditor before feature C3, while no postings exist |
| Concurrent accountants editing the same document | Lost updates | Optimistic locking via the `version` column (§4.1 rule 6); conflicting saves are rejected with a diff |
| Late/backdated entries silently corrupt moving-average COGS | Wrong gross profit, unexplainable to the auditor | Explicit recost policy (§4.4.2), permission-gated, logged as `RECOST`, adjustment posted rather than history rewritten |
| Cached balances drift from the ledger unnoticed | Reports quietly wrong for months | Every cache has a stated invariant and a nightly assertion (§4.11); drift raises a `SEVERE` alert and badges the figure in the UI |

---

## 16. Open questions for the stakeholder

1. **Locked years (SRS §6.1).** Are closed fiscal years read-only, with corrections via adjustment entries? *Recommended: yes.* Assumed **yes** in this plan; the mechanism is built either way and the policy is a setting.
2. **Inventory costing method.** Weighted moving average is assumed. Confirm with the auditor before feature C3 is built — changing it afterwards means restating every posting.
3. **Multi-currency.** Export sales are to foreign buyers — are they invoiced in local currency or foreign currency? Foreign currency adds an additional feature group — exchange rates, period-end revaluation, and FX gain/loss accounts. **Hedge taken:** `journal_lines` and every sale document carry nullable `currency char(3)` and `fx_rate numeric(14,6)` columns from day one, defaulting to the base currency. If the answer turns out to be "foreign", the work is new logic and two accounts — not a migration across every historical row.
4. **Tax/VAT.** No VAT or sales tax appears in either document. Confirm none is required beyond the government weight fee.
5. **Container and tanker capacity.** Confirm the standard capacity in drums, so BR-16 has a default.
6. **Opening balances.** What is the cut-over date, and who supplies opening cash, bank, stock, and party balances?
7. **Owner count.** Is there a single owner, or do drawings need to be tracked per owner?

---

## 17. Requirement traceability

| Requirement | Source | Covered in |
|---|---|---|
| Web-based centralized ERP | Bold §1 | §2, §3 |
| Two divisions, shared accounting | Bold §1 | §1, §4, §5 |
| Role-based auth (Admin/Accountant/Auditor) | Bold §2, SRS §3 | §6.1 |
| Four dashboard summaries | Bold §3 | §6.2 |
| UCO supplier / purchase / driver / agreement / export | Bold §4, SRS §4.2–4.7 | §4.6, §6.3 |
| UEO purchase / local sale | Bold §5 | §4.7, §6.4 |
| Two inventory categories + auto-movement rules | Bold §7 | §4.4, §5, §6.6 |
| Expenses, salaries, drawings, cash, bank, weight fee | Bold §8, SRS §4.9–4.14 | §4.9, §6.7 |
| Master records with history and outstanding balance | Bold §9, SRS §4.12 | §4.3, §6.3 |
| Reports with PDF/Excel/print and filters | Bold §10, SRS §4.15 | §6.8 |
| Activity log, Admin-only deletion | Bold §11, SRS §4.16 | §4.10, §6.9 |
| Notifications (stock, payments, salary, contract, backup) | Bold §12, SRS §4.17 | §6.10 |
| Non-functional: security, responsiveness, speed, audit, backup, integrity, scalability | Bold §13, SRS §5 | §9, §10, §11, §13 |
| Indefinite historical retention, year-over-year reporting | SRS §4.15, §5.1 | §4.1, §6.8, §13 |
| Bank reconciliation | SRS §4.14 | §6.7 |
| Refund aging report | SRS §4.11 | §6.7 |
| AR/AP aging | SRS §4.12 | §6.8 |
| Container/tanker capacity validation | SRS §4.7 | BR-16, §8 |
| No-purchase / no-sale day markers | SRS §4.3, §4.6 | BR-22, §4.6 |
| Driver vacations | SRS §4.2 | BR-23, §4.3 |
| Field-level RBAC (hide profit) | SRS §5.3 | §6.1 |
| 2FA | SRS §3, §5.3 | §6.1, §10 |
