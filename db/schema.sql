-- Tractor supply console schema.
-- Tables 1-5 are the five tables on the system design whiteboard:
--   customer_orders, supply_orders, customers, production_pipeline, inventory_parts.
-- The rest hold the provided dataset, the catalog, the worker queue and model output.

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

-- The provided dataset, loaded row for row from data/market_signals.csv.
CREATE TABLE market_signals (
  id                     SERIAL PRIMARY KEY,
  date                   DATE NOT NULL,          -- shifted so the last row is the day before the planning date
  source_date            DATE NOT NULL,          -- the date as it appears in the CSV
  tractor_model          TEXT NOT NULL,
  demand_units           INT NOT NULL,
  supplier               TEXT NOT NULL,
  supplier_delay_days    INT NOT NULL,
  component_failure_rate NUMERIC(6,4) NOT NULL,
  inventory_levels       INT NOT NULL,
  warehouse_location     TEXT NOT NULL,
  inflation_rate         NUMERIC(5,2) NOT NULL,
  market_trend_index     NUMERIC(4,2) NOT NULL
);
CREATE INDEX market_signals_model_date ON market_signals (tractor_model, date);

-- Catalog
CREATE TABLE tractor_models (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  horsepower  INT NOT NULL,
  list_price  NUMERIC(12,2) NOT NULL,
  build_days  INT NOT NULL
);

CREATE TABLE suppliers (
  code      TEXT PRIMARY KEY,           -- 'Supplier A' .. 'Supplier E', as in the dataset
  slug      TEXT NOT NULL UNIQUE,       -- 'a' .. 'e', used in the mock supplier API path
  name      TEXT NOT NULL
);

CREATE TABLE warehouses (
  code  TEXT PRIMARY KEY,               -- 'CA','FL','IL','NY','TX', as in the dataset
  name  TEXT NOT NULL
);

CREATE TABLE parts (
  sku             TEXT PRIMARY KEY,
  tractor_model   TEXT NOT NULL REFERENCES tractor_models(code),
  category        TEXT NOT NULL,
  name            TEXT NOT NULL,
  qty_per_tractor INT NOT NULL,
  standard_cost   NUMERIC(12,2) NOT NULL
);

CREATE TABLE part_suppliers (
  sku               TEXT NOT NULL REFERENCES parts(sku),
  supplier          TEXT NOT NULL REFERENCES suppliers(code),
  unit_price        NUMERIC(12,2) NOT NULL,
  nominal_lead_days INT NOT NULL,
  PRIMARY KEY (sku, supplier)
);

-- 3. customers
CREATE TABLE customers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  state      TEXT NOT NULL REFERENCES warehouses(code),
  segment    TEXT NOT NULL,             -- dealer | fleet | co-op
  since      DATE NOT NULL
);

-- 1. customer_orders. The order form writes here: customer_id, tractor model, quantity, id.
CREATE TABLE customer_orders (
  id             SERIAL PRIMARY KEY,
  customer_id    INT NOT NULL REFERENCES customers(id),
  tractor_model  TEXT NOT NULL REFERENCES tractor_models(code),
  quantity       INT NOT NULL CHECK (quantity > 0),
  warehouse      TEXT NOT NULL REFERENCES warehouses(code),
  ordered_at     DATE NOT NULL,
  requested_date DATE NOT NULL,         -- the delivery date the customer asked for
  promised_date  DATE,
  fulfilled_date DATE,
  status         TEXT NOT NULL CHECK (status IN ('open','in_production','fulfilled','cancelled'))
);
CREATE INDEX customer_orders_requested ON customer_orders (requested_date);
CREATE INDEX customer_orders_status ON customer_orders (status);

-- 4. production_pipeline. One row per order that is scheduled to be built.
CREATE TABLE production_pipeline (
  customer_order_id INT PRIMARY KEY REFERENCES customer_orders(id),
  stage             TEXT NOT NULL CHECK (stage IN ('awaiting_parts','scheduled','assembly','qa','ready')),
  stage_entered_at  DATE NOT NULL,
  scheduled_start   DATE NOT NULL,
  scheduled_finish  DATE NOT NULL
);

-- 2. supply_orders. date_ordered, promised_date and fulfilled_date are the whiteboard's columns.
CREATE TABLE supply_orders (
  id                SERIAL PRIMARY KEY,
  sku               TEXT NOT NULL REFERENCES parts(sku),
  supplier          TEXT REFERENCES suppliers(code),   -- null until the worker places it
  warehouse         TEXT NOT NULL REFERENCES warehouses(code),
  quantity          INT NOT NULL CHECK (quantity > 0),
  unit_price        NUMERIC(12,2),
  customer_order_id INT REFERENCES customer_orders(id),
  date_ordered      DATE NOT NULL,
  promised_date     DATE,
  fulfilled_date    DATE,
  status            TEXT NOT NULL CHECK (status IN ('queued','placed','fulfilled','failed')),
  source            TEXT NOT NULL DEFAULT 'history',   -- history | order_form | selected_orders | recommendation | chatbot
  external_ref      TEXT,
  note              TEXT
);
CREATE INDEX supply_orders_status ON supply_orders (status);
CREATE INDEX supply_orders_sku ON supply_orders (sku);

-- Worker queue for supply orders (Postgres-backed, claimed with FOR UPDATE SKIP LOCKED).
CREATE TABLE supply_jobs (
  id              SERIAL PRIMARY KEY,
  supply_order_id INT NOT NULL REFERENCES supply_orders(id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  log             JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supply_jobs_pending ON supply_jobs (status, run_after);

CREATE TABLE worker_heartbeats (
  worker     TEXT PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed  INT NOT NULL DEFAULT 0
);

-- On-hand stock per part per warehouse at the app's as-of date.
CREATE TABLE inventory (
  sku       TEXT NOT NULL REFERENCES parts(sku),
  warehouse TEXT NOT NULL REFERENCES warehouses(code),
  on_hand   INT NOT NULL,
  PRIMARY KEY (sku, warehouse)
);

-- 5. inventory_parts. One row per received lot; broken / broken_date from the whiteboard
--    are broken_quantity, broken_date and the stage the failure was found at.
CREATE TABLE inventory_parts (
  id              SERIAL PRIMARY KEY,
  sku             TEXT NOT NULL REFERENCES parts(sku),
  supplier        TEXT NOT NULL REFERENCES suppliers(code),
  warehouse       TEXT NOT NULL REFERENCES warehouses(code),
  supply_order_id INT REFERENCES supply_orders(id),
  quantity        INT NOT NULL,
  received_date   DATE NOT NULL,
  broken_quantity INT NOT NULL DEFAULT 0,
  broken_date     DATE,
  broken_stage    TEXT CHECK (broken_stage IN ('receiving','assembly','field'))
);
CREATE INDEX inventory_parts_sku_supplier ON inventory_parts (sku, supplier);

-- Output of the four models, one row per model per run.
CREATE TABLE model_runs (
  id       SERIAL PRIMARY KEY,
  model    TEXT NOT NULL CHECK (model IN ('demand','supplier_delay','component_failure','inventory_strategy')),
  as_of    DATE NOT NULL,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics  JSONB NOT NULL,
  output   JSONB NOT NULL
);
CREATE INDEX model_runs_latest ON model_runs (model, ran_at DESC);

-- The weekly job's written summary shown on the dashboard.
CREATE TABLE weekly_briefs (
  id           SERIAL PRIMARY KEY,
  as_of        DATE NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  author       TEXT NOT NULL,            -- 'template' or 'llm:<provider>/<model>'
  body         TEXT NOT NULL,
  facts        JSONB NOT NULL
);
