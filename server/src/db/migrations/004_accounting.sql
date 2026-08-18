-- 004 — chart of accounts and the financial ledger
-- IMPLEMENTATION.md §4.5. This is one of the two authoritative stores.

CREATE TABLE accounts (
  id             smallserial PRIMARY KEY,
  code           varchar(20) NOT NULL UNIQUE,
  name           varchar(120) NOT NULL,
  type           varchar(20) NOT NULL,   -- ASSET|LIABILITY|EQUITY|INCOME|EXPENSE
  subtype        varchar(40),            -- CASH|BANK|AR|AP|INVENTORY|COGS|RECEIVABLE
  parent_id      smallint REFERENCES accounts(id),
  is_postable    boolean NOT NULL DEFAULT true,
  -- Control accounts (AR/AP/Inventory/Fee Receivable) may be posted to only by
  -- domain services. Manual journal entries touching them are rejected (BR-27).
  is_control     boolean NOT NULL DEFAULT false,
  bank_name      varchar(120),
  account_number varchar(60),
  is_active      boolean NOT NULL DEFAULT true,
  CHECK (type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE'))
);
CREATE INDEX accounts_subtype_idx ON accounts(subtype) WHERE is_active;

CREATE TABLE journal_entries (
  id             bigserial PRIMARY KEY,
  entry_no       varchar(30) NOT NULL UNIQUE,
  entry_date     date NOT NULL,
  narration      text,
  source_type    varchar(60) NOT NULL,
  source_id      bigint NOT NULL,
  -- BR-26: a document posts at most once however many times a request is retried
  posting_key    varchar(120) NOT NULL UNIQUE,
  is_reversal_of bigint REFERENCES journal_entries(id),
  is_manual      boolean NOT NULL DEFAULT false,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  posted_by      bigint NOT NULL REFERENCES users(id),
  posted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX je_date_idx   ON journal_entries(entry_date);
CREATE INDEX je_source_idx ON journal_entries(source_type, source_id);
-- an entry can be reversed at most once
CREATE UNIQUE INDEX je_reversal_once_idx ON journal_entries(is_reversal_of)
  WHERE is_reversal_of IS NOT NULL;

CREATE TABLE journal_lines (
  id         bigserial PRIMARY KEY,
  entry_id   bigint NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  -- denormalised from the entry so ledger/aging/P&L queries are index-only
  -- range scans with no join (§9)
  entry_date date NOT NULL,
  account_id smallint NOT NULL REFERENCES accounts(id),
  debit      numeric(14,2) NOT NULL DEFAULT 0,
  credit     numeric(14,2) NOT NULL DEFAULT 0,
  party_id   bigint REFERENCES parties(id),
  division   division_t,
  currency   char(3),          -- null = base currency; forward-compat (§16 Q5)
  fx_rate    numeric(14,6),
  memo       varchar(255),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0))
);
CREATE INDEX jl_account_date_idx ON journal_lines(account_id, entry_date, id);
CREATE INDEX jl_entry_idx        ON journal_lines(entry_id);
CREATE INDEX jl_party_idx        ON journal_lines(party_id, entry_date) WHERE party_id IS NOT NULL;
CREATE INDEX jl_division_idx     ON journal_lines(division, entry_date)  WHERE division IS NOT NULL;

-- BR-25 — balancing is enforced by the DATABASE, not only by the application.
-- Deferred so a multi-line entry is checked once at COMMIT, not after each row.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger AS $fn$
DECLARE
  total_debit  numeric(14,2);
  total_credit numeric(14,2);
BEGIN
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines
   WHERE entry_id = NEW.entry_id;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced: debit % <> credit % (BR-25)',
      NEW.entry_id, total_debit, total_credit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER je_must_balance
  AFTER INSERT OR UPDATE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
