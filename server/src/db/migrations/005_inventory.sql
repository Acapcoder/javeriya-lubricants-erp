-- 005 — the stock ledger
-- IMPLEMENTATION.md §4.4. The second authoritative store.

CREATE TABLE inventory_items (
  id            smallserial PRIMARY KEY,
  code          varchar(20) NOT NULL UNIQUE,   -- UCO | UEO | WASTEWATER | TREATED_WATER
  name          varchar(80) NOT NULL,
  uom           varchar(20) NOT NULL DEFAULT 'DRUM',
  division      division_t NOT NULL,
  low_threshold numeric(12,3) NOT NULL DEFAULT 0,
  -- wastewater carries no cost basis: the company is PAID to take it (BR-07)
  is_valued     boolean NOT NULL DEFAULT true,
  account_id    smallint REFERENCES accounts(id)   -- inventory control account
);

CREATE TABLE stock_movements (
  id             bigserial PRIMARY KEY,
  item_id        smallint NOT NULL REFERENCES inventory_items(id),
  moved_on       date NOT NULL,
  direction      smallint NOT NULL CHECK (direction IN (1, -1)),
  quantity       numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost      numeric(14,4) NOT NULL DEFAULT 0,
  value          numeric(14,2) NOT NULL DEFAULT 0,
  source_type    varchar(60) NOT NULL,
  source_id      bigint NOT NULL,
  is_reversal_of bigint REFERENCES stock_movements(id),
  posting_key    varchar(120) NOT NULL UNIQUE,   -- BR-26
  balance_after  numeric(12,3) NOT NULL,         -- written under row lock (§4.4.1)
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  notes          text
);
CREATE INDEX sm_item_date_idx ON stock_movements(item_id, moved_on, id);
CREATE INDEX sm_source_idx    ON stock_movements(source_type, source_id);

-- Reconciled cache (§4.11): quantity must equal SUM(direction * quantity),
-- value must equal the item's inventory control account balance.
CREATE TABLE stock_balances (
  item_id       smallint PRIMARY KEY REFERENCES inventory_items(id),
  quantity      numeric(12,3) NOT NULL DEFAULT 0,
  value         numeric(14,2) NOT NULL DEFAULT 0,
  avg_unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
