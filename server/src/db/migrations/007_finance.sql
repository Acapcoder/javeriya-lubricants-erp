-- 007 — expenses, salaries, drawings, payments, bank statements, summaries
-- IMPLEMENTATION.md §4.9

CREATE TABLE expense_categories (
  id         smallserial PRIMARY KEY,
  name       varchar(80) NOT NULL UNIQUE,
  account_id smallint NOT NULL REFERENCES accounts(id),
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE expenses (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  expense_date   date NOT NULL,
  category_id    smallint NOT NULL REFERENCES expense_categories(id),
  description    text,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  -- which cash/bank account was credited; method_label is display only
  account_id     smallint NOT NULL REFERENCES accounts(id),
  method_label   varchar(40) NOT NULL,
  attachment_id  bigint REFERENCES attachments(id),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX exp_cat_date_idx ON expenses(category_id, expense_date);

CREATE TABLE salaries (
  id             bigserial PRIMARY KEY,
  employee_id    bigint NOT NULL REFERENCES employees(id),
  period_month   date NOT NULL,     -- first day of the salary month
  salary_amount  numeric(14,2) NOT NULL DEFAULT 0,
  advance_amount numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount    numeric(14,2) NOT NULL DEFAULT 0,
  remaining      numeric(14,2) NOT NULL DEFAULT 0,
  payment_date   date,
  account_id     smallint REFERENCES accounts(id),
  method_label   varchar(40),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (employee_id, period_month)
);

-- BR-12: drawings reduce owner's equity and are NEVER company expenses.
CREATE TABLE owner_drawings (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  drawing_date   date NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id     smallint NOT NULL REFERENCES accounts(id),
  method_label   varchar(40) NOT NULL,
  purpose        varchar(160),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE payments (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  payment_date   date NOT NULL,
  direction      varchar(10) NOT NULL CHECK (direction IN ('IN','OUT')),
  party_id       bigint REFERENCES parties(id),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id     smallint NOT NULL REFERENCES accounts(id),
  method_label   varchar(40) NOT NULL,
  reference_no   varchar(60),
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX pay_party_idx ON payments(party_id, payment_date);

-- One payment may settle several documents; the unallocated remainder
-- stays visible as a party credit rather than being forced onto an invoice.
CREATE TABLE payment_allocations (
  id          bigserial PRIMARY KEY,
  payment_id  bigint NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  target_type varchar(60) NOT NULL,
  target_id   bigint NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, target_type, target_id)
);
CREATE INDEX pa_target_idx ON payment_allocations(target_type, target_id);

-- IMPORTED from the bank. NOT a ledger — the bank ledger is a query over
-- journal_lines. Keeping these separate is what makes reconciliation a
-- comparison between two genuinely independent records.
CREATE TABLE bank_statement_lines (
  id              bigserial PRIMARY KEY,
  account_id      smallint NOT NULL REFERENCES accounts(id),
  statement_ref   varchar(60),
  txn_date        date NOT NULL,
  description     text,
  amount          numeric(14,2) NOT NULL,
  matched_line_id bigint REFERENCES journal_lines(id),
  matched_at      timestamptz,
  matched_by      bigint REFERENCES users(id),
  UNIQUE (account_id, statement_ref, txn_date, amount, description)
);
CREATE INDEX bsl_unmatched_idx ON bank_statement_lines(account_id, txn_date)
  WHERE matched_line_id IS NULL;

-- Reconciled cache (§4.11): rebuilt nightly from the ledger; a differing
-- rebuild is itself the alert.
CREATE TABLE monthly_summaries (
  id          bigserial PRIMARY KEY,
  division    division_t,
  year        smallint NOT NULL,
  month       smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  purchases   numeric(14,2) NOT NULL DEFAULT 0,
  sales       numeric(14,2) NOT NULL DEFAULT 0,
  cogs        numeric(14,2) NOT NULL DEFAULT 0,
  expenses    numeric(14,2) NOT NULL DEFAULT 0,
  gross_profit numeric(14,2) NOT NULL DEFAULT 0,
  net_profit  numeric(14,2) NOT NULL DEFAULT 0,
  rebuilt_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (division, year, month)
);
