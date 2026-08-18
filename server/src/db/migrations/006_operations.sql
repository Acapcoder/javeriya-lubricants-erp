-- 006 — operational documents for all three divisions
-- IMPLEMENTATION.md §4.6, §4.7, §4.8

/* ------------------------------------------------------------ UCO and UEO */

CREATE TABLE purchases (
  id              bigserial PRIMARY KEY,
  doc_no          varchar(30) NOT NULL UNIQUE,
  -- BR-02: a purchase belongs to exactly one oil division, never to WTD
  division        division_t NOT NULL CHECK (division IN ('UCO','UEO')),
  purchase_date   date NOT NULL,
  source          varchar(30) NOT NULL,   -- DRIVER_COLLECTION|DIRECT_AGREEMENT|WALK_IN
  party_id        bigint REFERENCES parties(id),
  agreement_id    bigint REFERENCES agreements(id),
  driver_id       bigint REFERENCES drivers(id),
  collection_area varchar(120),
  drums           numeric(12,3) NOT NULL DEFAULT 0 CHECK (drums >= 0),
  rate_per_drum   numeric(14,2) NOT NULL DEFAULT 0,
  total_amount    numeric(14,2) NOT NULL DEFAULT 0,
  cash_paid       numeric(14,2) NOT NULL DEFAULT 0,
  online_paid     numeric(14,2) NOT NULL DEFAULT 0,
  -- display caches only (design rule 4); authority is the ledger
  balance_due     numeric(14,2) NOT NULL DEFAULT 0,
  payment_status  pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_purchase  boolean NOT NULL DEFAULT false,   -- BR-22
  notes           text,
  fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id),
  version         integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (is_no_purchase = false OR (drums = 0 AND total_amount = 0))
);
CREATE INDEX pur_div_date_idx ON purchases(division, purchase_date);
CREATE INDEX pur_party_idx    ON purchases(party_id, purchase_date);
CREATE INDEX pur_driver_idx   ON purchases(driver_id, purchase_date);

CREATE TABLE weight_fees (
  id                 bigserial PRIMARY KEY,
  purchase_id        bigint NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  fee_paid           boolean NOT NULL DEFAULT false,
  fee_amount         numeric(14,2) NOT NULL DEFAULT 0,
  slip_number        varchar(60),
  attachment_id      bigint REFERENCES attachments(id),
  refund_eligible    boolean NOT NULL DEFAULT true,
  refund_status      refund_t NOT NULL DEFAULT 'PENDING',
  claimed_on         date,
  -- BR-20: the refund may differ from the amount paid
  refund_amount      numeric(14,2) NOT NULL DEFAULT 0,
  refund_received_on date,
  gov_return_status  varchar(20) NOT NULL DEFAULT 'PENDING',
  notes              text
);
CREATE INDEX wf_status_idx   ON weight_fees(refund_status, claimed_on);
CREATE INDEX wf_purchase_idx ON weight_fees(purchase_id);

CREATE TABLE export_sales (
  id                  bigserial PRIMARY KEY,
  doc_no              varchar(30) NOT NULL UNIQUE,
  export_date         date NOT NULL,
  party_id            bigint NOT NULL REFERENCES parties(id),
  destination_country varchar(80),
  container_count     smallint NOT NULL DEFAULT 0,
  drums               numeric(12,3) NOT NULL DEFAULT 0,
  rate_per_drum       numeric(14,2) NOT NULL DEFAULT 0,
  total_amount        numeric(14,2) NOT NULL DEFAULT 0,
  invoice_no          varchar(50),
  payment_method      varchar(40),
  amount_received     numeric(14,2) NOT NULL DEFAULT 0,
  balance_due         numeric(14,2) NOT NULL DEFAULT 0,
  payment_status      pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_sale          boolean NOT NULL DEFAULT false,
  currency            char(3),
  fx_rate             numeric(14,6),
  notes               text,
  fiscal_year_id      int NOT NULL REFERENCES fiscal_years(id),
  version             integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (is_no_sale = false OR (drums = 0 AND total_amount = 0))
);
CREATE INDEX exp_date_idx ON export_sales(export_date);

CREATE TABLE containers (
  id               bigserial PRIMARY KEY,
  container_number varchar(40) NOT NULL,
  capacity_drums   numeric(12,3),          -- BR-16 validation source
  sale_id          bigint REFERENCES export_sales(id) ON DELETE CASCADE,
  drums            numeric(12,3) NOT NULL DEFAULT 0,
  UNIQUE (container_number, sale_id)
);

CREATE TABLE local_sales (
  id              bigserial PRIMARY KEY,
  doc_no          varchar(30) NOT NULL UNIQUE,
  sale_date       date NOT NULL,
  party_id        bigint NOT NULL REFERENCES parties(id),
  tanker_number   varchar(40),
  drums           numeric(12,3) NOT NULL DEFAULT 0,
  rate_per_drum   numeric(14,2) NOT NULL DEFAULT 0,
  total_amount    numeric(14,2) NOT NULL DEFAULT 0,
  invoice_no      varchar(50),
  payment_method  varchar(40),
  amount_received numeric(14,2) NOT NULL DEFAULT 0,
  balance_due     numeric(14,2) NOT NULL DEFAULT 0,
  payment_status  pay_status_t NOT NULL DEFAULT 'UNPAID',
  is_no_sale      boolean NOT NULL DEFAULT false,
  notes           text,
  fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id),
  version         integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (is_no_sale = false OR (drums = 0 AND total_amount = 0))
);
CREATE INDEX loc_date_idx ON local_sales(sale_date);

CREATE TABLE tankers (
  id             bigserial PRIMARY KEY,
  tanker_number  varchar(40) NOT NULL,
  capacity_drums numeric(12,3),
  sale_id        bigint REFERENCES local_sales(id) ON DELETE CASCADE,
  drums          numeric(12,3) NOT NULL DEFAULT 0
);

/* ------------------------------------------------------- Water Treatment */

CREATE TABLE wastewater_receptions (
  id                 bigserial PRIMARY KEY,
  doc_no             varchar(30) NOT NULL UNIQUE,
  reception_date     date NOT NULL,
  party_id           bigint NOT NULL REFERENCES parties(id),
  vehicle_number     varchar(40),
  drums              numeric(12,3) NOT NULL CHECK (drums > 0),
  treatment_fee_rate numeric(14,2) NOT NULL DEFAULT 0,
  total_fee          numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid        numeric(14,2) NOT NULL DEFAULT 0,
  -- BR-06: this is SERVICE INCOME. The company is owed money, never owes it.
  balance_due        numeric(14,2) NOT NULL DEFAULT 0,
  payment_status     pay_status_t NOT NULL DEFAULT 'UNPAID',
  invoice_no         varchar(50),
  notes              text,
  fiscal_year_id     int NOT NULL REFERENCES fiscal_years(id),
  version            integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX wwr_date_idx  ON wastewater_receptions(reception_date);
CREATE INDEX wwr_party_idx ON wastewater_receptions(party_id, reception_date);

CREATE TABLE treatment_batches (
  id              bigserial PRIMARY KEY,
  batch_no        varchar(30) NOT NULL UNIQUE,
  batch_date      date NOT NULL,
  operator_id     bigint REFERENCES employees(id),
  drums_processed numeric(12,3) NOT NULL CHECK (drums_processed > 0),
  processing_cost numeric(14,2) NOT NULL DEFAULT 0,
  status          varchar(20) NOT NULL DEFAULT 'DRAFT',   -- DRAFT|COMPLETED|REVERSED
  completed_at    timestamptz,
  notes           text,
  fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id),
  version         integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (status IN ('DRAFT','COMPLETED','REVERSED'))
);
CREATE INDEX batch_date_idx ON treatment_batches(batch_date);

CREATE TABLE treatment_outputs (
  id             bigserial PRIMARY KEY,
  batch_id       bigint NOT NULL REFERENCES treatment_batches(id) ON DELETE CASCADE,
  item_id        smallint NOT NULL REFERENCES inventory_items(id),
  quantity       numeric(12,3) NOT NULL CHECK (quantity > 0),
  allocated_cost numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (batch_id, item_id)
);

CREATE TABLE treated_water_sales (
  id              bigserial PRIMARY KEY,
  doc_no          varchar(30) NOT NULL UNIQUE,
  sale_date       date NOT NULL,
  party_id        bigint NOT NULL REFERENCES parties(id),
  drums           numeric(12,3) NOT NULL CHECK (drums > 0),
  rate_per_drum   numeric(14,2) NOT NULL DEFAULT 0,
  total_amount    numeric(14,2) NOT NULL DEFAULT 0,
  invoice_no      varchar(50),
  payment_method  varchar(40),
  amount_received numeric(14,2) NOT NULL DEFAULT 0,
  balance_due     numeric(14,2) NOT NULL DEFAULT 0,
  payment_status  pay_status_t NOT NULL DEFAULT 'UNPAID',
  notes           text,
  fiscal_year_id  int NOT NULL REFERENCES fiscal_years(id),
  version         integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX tws_date_idx ON treated_water_sales(sale_date);
