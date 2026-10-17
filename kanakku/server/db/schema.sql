-- Kanakku — Afra Ventures Pvt Ltd multi-brand finance system
-- PostgreSQL 14+ schema. Run once on a fresh database (npm run db:init does this).


-- ───────────── Core ─────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','accounts','sales')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brands (
  id               SERIAL PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,          -- short code used in doc numbers, e.g. TX
  name             TEXT NOT NULL,
  color            TEXT NOT NULL DEFAULT '#1B2A4A',
  in_investor_pool BOOLEAN NOT NULL DEFAULT FALSE, -- counts toward investor profit-share pool
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('in','out')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (name, kind)
);

CREATE TABLE IF NOT EXISTS accounts (               -- where money sits: cash box, bank, UPI
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  kind   TEXT NOT NULL CHECK (kind IN ('cash','bank','upi','gateway')),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- ───────────── Book (daily cash in/out) ─────────────
CREATE TABLE IF NOT EXISTS entries (
  id          SERIAL PRIMARY KEY,
  entry_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  brand_id    INT NOT NULL REFERENCES brands(id),
  type        TEXT NOT NULL CHECK (type IN ('in','out')),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category_id INT REFERENCES categories(id),
  account_id  INT REFERENCES accounts(id),
  party       TEXT,                                -- who paid / who was paid
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','razorpay','invoice','import')),
  ref         TEXT,                                -- razorpay payment id, cheque no, UTR, etc.
  document_id INT,                                 -- set when entry is a payment against an invoice
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS entries_date_idx  ON entries(entry_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS entries_brand_idx ON entries(brand_id)   WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entries_ref_razorpay ON entries(ref) WHERE source = 'razorpay';

-- ───────────── Deals: customers, quotes, invoices ─────────────
CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  gstin      TEXT,
  state_code TEXT NOT NULL DEFAULT '34',          -- 34 = Puducherry (same state → CGST+SGST)
  address    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id                SERIAL PRIMARY KEY,
  doc_type          TEXT NOT NULL CHECK (doc_type IN ('quote','invoice')),
  number            TEXT NOT NULL UNIQUE,
  brand_id          INT NOT NULL REFERENCES brands(id),
  customer_id       INT NOT NULL REFERENCES customers(id),
  doc_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date          DATE,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','rejected','converted','unpaid','partial','paid','cancelled')),
  place_of_supply   TEXT NOT NULL DEFAULT '34',
  subtotal          NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst              NUMERIC(14,2) NOT NULL DEFAULT 0,
  total             NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid       NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  terms             TEXT,
  converted_from_id INT REFERENCES documents(id),
  last_reminded_at  TIMESTAMPTZ,
  created_by        INT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(doc_type, status);

CREATE TABLE IF NOT EXISTS document_items (
  id          SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position    INT NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  hsn_sac     TEXT,
  qty         NUMERIC(12,2) NOT NULL DEFAULT 1,
  rate        NUMERIC(14,2) NOT NULL DEFAULT 0,
  gst_rate    NUMERIC(5,2)  NOT NULL DEFAULT 18,
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0       -- qty * rate (pre-tax)
);

CREATE TABLE IF NOT EXISTS doc_sequences (           -- per brand / type / financial year counters
  brand_id INT  NOT NULL REFERENCES brands(id),
  doc_type TEXT NOT NULL,
  fy       TEXT NOT NULL,                            -- e.g. 2627
  last_no  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, doc_type, fy)
);

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_document_fk;
ALTER TABLE entries ADD CONSTRAINT entries_document_fk FOREIGN KEY (document_id) REFERENCES documents(id);

-- ───────────── Dues (receivable / payable) ─────────────
CREATE TABLE IF NOT EXISTS dues (
  id               SERIAL PRIMARY KEY,
  brand_id         INT NOT NULL REFERENCES brands(id),
  direction        TEXT NOT NULL CHECK (direction IN ('receivable','payable')),
  party            TEXT NOT NULL,
  phone            TEXT,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  amount_settled   NUMERIC(14,2) NOT NULL DEFAULT 0,
  due_date         DATE,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','written_off')),
  document_id      INT REFERENCES documents(id),
  note             TEXT,
  last_reminded_at TIMESTAMPTZ,
  created_by       INT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Investors (profit-share, no interest) ─────────────
CREATE TABLE IF NOT EXISTS investors (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT,
  email            TEXT,
  profit_share_pct NUMERIC(5,2) NOT NULL DEFAULT 0,  -- % of pooled-brand net profit
  start_date       DATE,
  payout_from_month INT NOT NULL DEFAULT 4,          -- first payout in month N (earlier months accrue)
  statement_day    INT NOT NULL DEFAULT 10,          -- statement due by this day of next month
  notes            TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investor_contributions (
  id          SERIAL PRIMARY KEY,
  investor_id INT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  received_on DATE NOT NULL,
  mode        TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS investor_payouts (
  id          SERIAL PRIMARY KEY,
  investor_id INT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,                        -- YYYY-MM the share relates to
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  paid_on     DATE,
  note        TEXT
);

-- ───────────── Audit ─────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────── Upgrades for databases created by an earlier version ─────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

-- ───────────── Shared-cost splits (v1.1) ─────────────
-- A split preset is a saved rule like "Office overheads: TechX 40%, NPP 25%, Academy 15% …".
CREATE TABLE IF NOT EXISTS split_presets (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  rules  JSONB NOT NULL,              -- [{ "brand_id": 1, "pct": 40 }, …] — must total 100
  active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Category can suggest a preset (EB, Rent, Internet → Office overheads)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS default_preset_id INT REFERENCES split_presets(id);

-- When an entry is shared, its amount is divided here. Entries without rows here belong 100% to entries.brand_id.
CREATE TABLE IF NOT EXISTS entry_allocations (
  id       SERIAL PRIMARY KEY,
  entry_id INT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  brand_id INT NOT NULL REFERENCES brands(id),
  pct      NUMERIC(6,3) NOT NULL,
  amount   NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_alloc_entry_idx ON entry_allocations(entry_id);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS split_preset_id INT REFERENCES split_presets(id);

-- Every report reads money through this view, so shared costs land on the right brands.
DROP VIEW IF EXISTS entry_lines;
CREATE VIEW entry_lines AS
  SELECT e.id AS entry_id, e.entry_date, e.type, e.category_id, e.deleted_at, a.brand_id, a.amount, TRUE AS shared
    FROM entries e JOIN entry_allocations a ON a.entry_id = e.id
  UNION ALL
  SELECT e.id, e.entry_date, e.type, e.category_id, e.deleted_at, e.brand_id, e.amount, FALSE
    FROM entries e WHERE NOT EXISTS (SELECT 1 FROM entry_allocations a WHERE a.entry_id = e.id);

-- ───────────── Investor share per brand (v1.1) ─────────────
-- Each investor can have a different % on each brand. If an investor has no rows here,
-- the old rule applies: investors.profit_share_pct on every brand with brands.in_investor_pool.
-- Rows are versioned by effective_from (YYYY-MM): a change from Dec 2026 never rewrites Sep–Nov.
CREATE TABLE IF NOT EXISTS investor_brands (
  investor_id    INT  NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL CHECK (effective_from ~ '^\d{4}-\d{2}$'),
  brand_id       INT  NOT NULL REFERENCES brands(id),
  share_pct      NUMERIC(5,2) NOT NULL CHECK (share_pct >= 0 AND share_pct <= 100),
  PRIMARY KEY (investor_id, effective_from, brand_id)
);
-- pooled  = losses in one brand reduce the gains of the others in the same month (current agreement)
-- per_brand = each brand's share is counted on its own; a loss-making brand gives 0, not a minus
ALTER TABLE investors ADD COLUMN IF NOT EXISTS loss_rule TEXT NOT NULL DEFAULT 'pooled';
ALTER TABLE investors DROP CONSTRAINT IF EXISTS investors_loss_rule_chk;
ALTER TABLE investors ADD CONSTRAINT investors_loss_rule_chk CHECK (loss_rule IN ('pooled','per_brand'));
-- Whether shared costs split onto pooled brands count against the investor (agree this with the investor)
ALTER TABLE investors ADD COLUMN IF NOT EXISTS include_shared_costs BOOLEAN NOT NULL DEFAULT TRUE;
