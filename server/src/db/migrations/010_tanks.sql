-- 010 — storage tanks
--
-- Until now stock was a single number per oil type. In the yard it is not: it
-- sits in physical tanks, each with a fixed capacity, and you cannot take in a
-- load with nowhere to put it. Recording which tank a load went into is what
-- makes "can we accept this delivery" answerable, and what makes a physical
-- dip check comparable against the books.
--
-- A tank holds exactly one kind of material. Mixing cooking oil into an engine
-- oil tank is a yard mistake, not a data entry option.

CREATE TABLE tanks (
  id             smallserial PRIMARY KEY,
  code           varchar(20) NOT NULL UNIQUE,      -- T-01, T-02
  name           varchar(80) NOT NULL,
  item_id        smallint NOT NULL REFERENCES inventory_items(id),
  capacity_drums numeric(12,3) NOT NULL CHECK (capacity_drums > 0),
  location       varchar(120),
  -- Below this, the tank is effectively empty for planning purposes (sludge,
  -- unpumpable heel). Reported, never auto-deducted.
  dead_stock     numeric(12,3) NOT NULL DEFAULT 0 CHECK (dead_stock >= 0),
  status         varchar(20) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE|MAINTENANCE|RETIRED
  notes          text,
  version        integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id),
  updated_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (status IN ('ACTIVE','MAINTENANCE','RETIRED')),
  CHECK (dead_stock < capacity_drums)
);
CREATE INDEX tanks_item_idx ON tanks(item_id) WHERE deleted_at IS NULL;

-- Which tank a movement went into or came out of. Nullable, because movements
-- recorded before tanks existed have no tank, and a correction posted against
-- the item as a whole still needs somewhere to live.
ALTER TABLE stock_movements ADD COLUMN tank_id smallint REFERENCES tanks(id);
CREATE INDEX sm_tank_idx ON stock_movements(tank_id, moved_on) WHERE tank_id IS NOT NULL;

ALTER TABLE purchases ADD COLUMN tank_id smallint REFERENCES tanks(id);

-- Physical dip readings, so the book figure can be checked against the tank.
-- A difference is recorded, not silently applied: the correction goes through
-- a stock adjustment so it appears in the ledger like everything else.
CREATE TABLE tank_readings (
  id            bigserial PRIMARY KEY,
  tank_id       smallint NOT NULL REFERENCES tanks(id),
  read_on       date NOT NULL,
  measured      numeric(12,3) NOT NULL CHECK (measured >= 0),
  book_quantity numeric(12,3) NOT NULL,
  difference    numeric(12,3) NOT NULL,
  notes         text,
  adjusted      boolean NOT NULL DEFAULT false,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tank_readings_idx ON tank_readings(tank_id, read_on DESC);
