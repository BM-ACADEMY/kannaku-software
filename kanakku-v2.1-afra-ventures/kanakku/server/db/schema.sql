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

-- ═════════════════════════════ v2.0 — correct books + autopilot ═════════════════════════════

-- ── Money moves vs profit ──
-- entries.amount      = cash that actually moved (bank / cash / UPI)
-- entries.gst_amount  = GST inside that money (output GST on sales, input GST on purchases) — never profit or cost
-- entries.tds_amount  = TDS the customer deducted (counts as income; it's a tax credit, not lost money)
-- Profit/loss value of an entry = amount + tds_amount - gst_amount
ALTER TABLE entries ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS tds_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
-- Transfers between our own accounts (cash → RBL): never income or expense
ALTER TABLE entries ADD COLUMN IF NOT EXISTS to_account_id INT REFERENCES accounts(id);
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_type_check;
ALTER TABLE entries ADD CONSTRAINT entries_type_check CHECK (type IN ('in','out','transfer'));
-- pending = made by autopilot (recurring / bank import) and waiting for a human to confirm. Ignored by every report.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'posted';
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_status_check;
ALTER TABLE entries ADD CONSTRAINT entries_status_check CHECK (status IN ('posted','pending'));
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_source_check;
ALTER TABLE entries ADD CONSTRAINT entries_source_check CHECK (source IN ('manual','ai','razorpay','invoice','import','recurring','bank','bill','investor','transfer','refund'));
ALTER TABLE entries ADD COLUMN IF NOT EXISTS recurring_id INT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS bill_id INT REFERENCES documents(id);

-- Categories that are not profit or loss (capital in, GST paid to govt, investor payouts, loans)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS in_pnl BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Accounts: opening balance ──
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_date DATE NOT NULL DEFAULT DATE '2026-09-12';

-- ── Documents: credit notes + purchase bills ──
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_doc_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_doc_type_check CHECK (doc_type IN ('quote','invoice','credit_note','bill'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS against_id INT REFERENCES documents(id);   -- credit note → its invoice
ALTER TABLE documents ADD COLUMN IF NOT EXISTS amount_credited NUMERIC(14,2) NOT NULL DEFAULT 0; -- invoice: total of its credit notes
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tds_total NUMERIC(14,2) NOT NULL DEFAULT 0;      -- invoice: TDS deducted by customer
ALTER TABLE documents ADD COLUMN IF NOT EXISTS vendor_ref TEXT;        -- bill: the vendor's own bill number
ALTER TABLE documents ADD COLUMN IF NOT EXISTS itc_eligible BOOLEAN NOT NULL DEFAULT TRUE; -- bill: can we claim the GST?
ALTER TABLE documents ADD COLUMN IF NOT EXISTS split JSONB;            -- bill: shared across brands [{brand_id,pct}]
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories(id); -- bill: expense category
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('draft','sent','accepted','rejected','converted','unpaid','partial','paid','cancelled','issued','refunded'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_kind_check;
ALTER TABLE customers ADD CONSTRAINT customers_kind_check CHECK (kind IN ('customer','vendor','both'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2) NOT NULL DEFAULT 0; -- usual TDS this customer deducts (e.g. 2 or 10)

-- Every report reads money through this view: posted only, transfers excluded,
-- pnl_amount = the profit/loss value (GST out, TDS in), shared costs already split onto brands.
DROP VIEW IF EXISTS entry_lines;
CREATE VIEW entry_lines AS
  SELECT e.id AS entry_id, e.entry_date, e.type, e.category_id, e.deleted_at, a.brand_id,
         a.amount,
         ROUND((e.amount + e.tds_amount - e.gst_amount) * a.amount / NULLIF(e.amount, 0), 2) AS pnl_amount,
         TRUE AS shared
    FROM entries e JOIN entry_allocations a ON a.entry_id = e.id
   WHERE e.status = 'posted' AND e.type <> 'transfer'
  UNION ALL
  SELECT e.id, e.entry_date, e.type, e.category_id, e.deleted_at, e.brand_id,
         e.amount, (e.amount + e.tds_amount - e.gst_amount), FALSE
    FROM entries e
   WHERE e.status = 'posted' AND e.type <> 'transfer'
     AND NOT EXISTS (SELECT 1 FROM entry_allocations a WHERE a.entry_id = e.id);

-- ── Attachments (bill photos, receipts) ──
CREATE TABLE IF NOT EXISTS attachments (
  id         SERIAL PRIMARY KEY,
  entity     TEXT NOT NULL CHECK (entity IN ('entry','document')),
  entity_id  INT NOT NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INT NOT NULL,
  path       TEXT NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments(entity, entity_id);

-- ── Recurring entries (rent, salaries, subscriptions) ──
CREATE TABLE IF NOT EXISTS recurring (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  template    JSONB NOT NULL,          -- same shape as a Book entry (type, amount, brand_id or split, category_id, account_id, party, note, gst_amount)
  frequency   TEXT NOT NULL CHECK (frequency IN ('monthly','weekly','quarterly','yearly')),
  day         INT NOT NULL DEFAULT 1,  -- day of month (monthly/quarterly/yearly) or 1–7 (weekly, Mon=1)
  next_date   DATE NOT NULL,
  end_date    DATE,
  auto_post   BOOLEAN NOT NULL DEFAULT FALSE, -- false = create as "to confirm", true = post straight to the Book
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_run    DATE,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Bank statement import + auto-match ──
CREATE TABLE IF NOT EXISTS bank_lines (
  id          SERIAL PRIMARY KEY,
  account_id  INT NOT NULL REFERENCES accounts(id),
  line_date   DATE NOT NULL,
  description TEXT NOT NULL,
  ref         TEXT,
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0,  -- money out
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0,  -- money in
  balance     NUMERIC(14,2),
  hash        TEXT NOT NULL UNIQUE,              -- stops the same line being imported twice
  status      TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','ignored')),
  entry_id    INT REFERENCES entries(id),
  rule_id     INT,
  import_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_lines_status_idx ON bank_lines(status, line_date);
-- "Whenever the description has SWIGGY, it's Dada's Kitchen · Raw material"
CREATE TABLE IF NOT EXISTS bank_rules (
  id              SERIAL PRIMARY KEY,
  pattern         TEXT NOT NULL,          -- case-insensitive text to find in the description
  direction       TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','in','out')),
  brand_id        INT REFERENCES brands(id),
  split_preset_id INT REFERENCES split_presets(id),
  category_id     INT REFERENCES categories(id),
  party           TEXT,
  auto_post       BOOLEAN NOT NULL DEFAULT FALSE,
  hits            INT NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Budgets ──
CREATE TABLE IF NOT EXISTS budgets (
  brand_id      INT NOT NULL REFERENCES brands(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  income_target NUMERIC(14,2) NOT NULL DEFAULT 0,
  expense_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, month)
);

-- ── Security ──
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;            -- encrypted
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS investor_id INT REFERENCES investors(id); -- role 'investor' sees only this investor
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;     -- bump to log out everywhere
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','accounts','sales','investor'));
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- ── Autopilot ──
CREATE TABLE IF NOT EXISTS autopilot_log (
  id         BIGSERIAL PRIMARY KEY,
  job        TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  summary    TEXT,
  detail     JSONB,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_log_job_idx ON autopilot_log(job, ran_at DESC);
