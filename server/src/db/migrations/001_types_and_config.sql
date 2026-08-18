-- 001 — enums, users, roles/permissions, fiscal years, settings
-- IMPLEMENTATION.md §4.2

CREATE TYPE division_t   AS ENUM ('UCO', 'UEO', 'WTD');
CREATE TYPE party_type_t AS ENUM ('SUPPLIER', 'CUSTOMER', 'INDUSTRIAL_COMPANY');
CREATE TYPE pay_status_t AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
CREATE TYPE refund_t     AS ENUM ('NOT_ELIGIBLE', 'PENDING', 'CLAIMED', 'RECEIVED');

CREATE TABLE users (
  id                      bigserial PRIMARY KEY,
  name                    varchar(120) NOT NULL,
  email                   varchar(190) NOT NULL UNIQUE,
  password_hash           varchar(255) NOT NULL,
  two_factor_secret       text,
  two_factor_confirmed_at timestamptz,
  two_factor_recovery     jsonb,
  is_active               boolean NOT NULL DEFAULT true,
  failed_attempts         smallint NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  last_login_at           timestamptz,
  password_changed_at     timestamptz NOT NULL DEFAULT now(),
  version                 integer NOT NULL DEFAULT 0,
  created_by              bigint,
  updated_by              bigint,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
CREATE INDEX users_active_idx ON users(is_active) WHERE deleted_at IS NULL;

-- Role / permission model (spatie-equivalent, hand-rolled)
CREATE TABLE roles (
  id          smallserial PRIMARY KEY,
  code        varchar(40) NOT NULL UNIQUE,   -- ADMIN, ACCOUNTANT, MANAGER, AUDITOR, DATA_ENTRY
  name        varchar(80) NOT NULL,
  description text,
  -- §6.3 / SRS §6.3: Manager and Data Entry Operator exist in the framework
  -- but are seeded disabled until the business needs them.
  is_enabled  boolean NOT NULL DEFAULT true,
  is_system   boolean NOT NULL DEFAULT true,
  requires_2fa boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  id       smallserial PRIMARY KEY,
  code     varchar(60) NOT NULL UNIQUE,      -- operations.create, finance.manage, ...
  grp      varchar(40) NOT NULL,
  name     varchar(120) NOT NULL
);

CREATE TABLE role_permissions (
  role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id bigint   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id             varchar(64) PRIMARY KEY,     -- random token id, cookie holds a signed copy
  user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address     inet,
  user_agent     text,
  two_factor_ok  boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  id           bigserial PRIMARY KEY,
  email        varchar(190) NOT NULL,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  succeeded    boolean NOT NULL,
  reason       varchar(60),
  ip_address   inet,
  user_agent   text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_idx ON login_attempts(email, attempted_at DESC);

CREATE TABLE fiscal_years (
  id        serial PRIMARY KEY,
  label     varchar(20) NOT NULL UNIQUE,
  starts_on date NOT NULL,
  ends_on   date NOT NULL,
  is_locked boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  locked_by bigint REFERENCES users(id),
  CHECK (ends_on > starts_on)
);

CREATE TABLE settings (
  key        varchar(80) PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD CONSTRAINT users_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE users ADD CONSTRAINT users_updated_by_fk FOREIGN KEY (updated_by) REFERENCES users(id);
