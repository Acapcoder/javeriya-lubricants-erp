-- 003 — parties, agreements, drivers, employees
-- IMPLEMENTATION.md §4.3
-- NOTE: parties has no opening_balance column (design rule 9). Cut-over balances
-- are posted as an opening journal entry so the party ledger and the AR/AP
-- control account can never disagree.

CREATE TABLE parties (
  id                bigserial PRIMARY KEY,
  code              varchar(20) NOT NULL UNIQUE,   -- SUP-0001 / CUS-0001 / IND-0001
  type              party_type_t NOT NULL,
  name              varchar(160) NOT NULL,
  company           varchar(160),
  contact_person    varchar(120),
  phone             varchar(40),
  email             varchar(190),
  address           text,
  division          division_t,                    -- null = serves multiple divisions
  credit_terms_days smallint NOT NULL DEFAULT 0,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX parties_type_idx ON parties(type) WHERE deleted_at IS NULL;
CREATE INDEX parties_name_idx ON parties(lower(name));

CREATE TABLE agreements (
  id             bigserial PRIMARY KEY,
  party_id       bigint NOT NULL REFERENCES parties(id),
  agreement_no   varchar(50) NOT NULL UNIQUE,
  agreement_date date NOT NULL,
  expires_on     date,                              -- drives CONTRACT_EXPIRY notification
  division       division_t NOT NULL,
  rate_per_drum  numeric(14,2),
  payment_terms  varchar(120),
  notes          text,
  is_active      boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX agreements_expiry_idx ON agreements(expires_on) WHERE is_active;

CREATE TABLE drivers (
  id             bigserial PRIMARY KEY,
  code           varchar(20) NOT NULL UNIQUE,
  name           varchar(120) NOT NULL,
  phone          varchar(40),
  vehicle_number varchar(40),
  license_number varchar(60),
  salary         numeric(14,2),
  joining_date   date,
  status         varchar(20) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE|ON_LEAVE|INACTIVE
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE driver_vacations (
  id        bigserial PRIMARY KEY,
  driver_id bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on   date NOT NULL,
  reason    text,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX driver_vac_idx ON driver_vacations(driver_id, starts_on, ends_on);

CREATE TABLE employees (
  id           bigserial PRIMARY KEY,
  code         varchar(20) NOT NULL UNIQUE,
  name         varchar(120) NOT NULL,
  designation  varchar(80),
  base_salary  numeric(14,2) NOT NULL DEFAULT 0,
  joining_date date,
  is_active    boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
