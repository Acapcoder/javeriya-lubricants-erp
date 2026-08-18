-- 009 — driver types, driver advances, and the fields intake actually needs
--
-- Drivers fall into two operationally different groups:
--
--   IN_HOUSE    our own driver, our own truck. They are given money up front
--               (a quota/advance) and go out to collect. The advance is an
--               ASSET we hold against them until oil arrives — not an expense.
--
--   OUTSOURCED  an independent driver with their own truck. They bring oil and
--               we pay them for it, exactly like any other supplier. No advance
--               is ever issued.
--
-- Conflating the two is the mistake this migration exists to prevent: money
-- given to an in-house driver has not been spent yet, while money paid to an
-- outsourced driver has.

CREATE TYPE driver_type_t AS ENUM ('IN_HOUSE', 'OUTSOURCED');

ALTER TABLE drivers
  ADD COLUMN driver_type driver_type_t NOT NULL DEFAULT 'IN_HOUSE',
  -- Running balance of money issued but not yet acquitted by delivered oil.
  -- A reconciled cache (§4.11): must equal the 1250 control account per driver.
  ADD COLUMN advance_balance numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN notes text;

-- Outsourced drivers are paid per delivery, so they carry no advance.
ALTER TABLE drivers
  ADD CONSTRAINT drivers_outsourced_no_advance
  CHECK (driver_type = 'IN_HOUSE' OR advance_balance = 0);

CREATE INDEX drivers_type_idx ON drivers(driver_type) WHERE deleted_at IS NULL;

-- Control account for money out with in-house drivers.
INSERT INTO accounts (code, name, type, subtype, is_control)
VALUES ('1250', 'Driver Advances', 'ASSET', 'RECEIVABLE', true)
ON CONFLICT (code) DO NOTHING;

/* ------------------------------------------------------- purchase intake */

-- How the drums were paid for. Recorded per purchase so the posting engine
-- knows which accounts to credit.
ALTER TABLE purchases
  -- Money settled from an in-house driver's outstanding advance.
  ADD COLUMN advance_used numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN vehicle_number varchar(40),
  ADD COLUMN reference_no varchar(60);

ALTER TABLE purchases
  ADD CONSTRAINT purchases_amounts_non_negative
  CHECK (cash_paid >= 0 AND online_paid >= 0 AND advance_used >= 0 AND balance_due >= 0);

-- Driver advance issues and settlements, so each movement is auditable rather
-- than only visible as a balance.
CREATE TABLE driver_advances (
  id             bigserial PRIMARY KEY,
  doc_no         varchar(30) NOT NULL UNIQUE,
  driver_id      bigint NOT NULL REFERENCES drivers(id),
  issued_on      date NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  account_id     smallint NOT NULL REFERENCES accounts(id),  -- cash/bank it came from
  method_label   varchar(40) NOT NULL,
  notes          text,
  fiscal_year_id int NOT NULL REFERENCES fiscal_years(id),
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX driver_adv_idx ON driver_advances(driver_id, issued_on);
