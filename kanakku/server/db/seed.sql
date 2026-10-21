-- Kanakku seed data — Afra Ventures Pvt Ltd
-- Safe to re-run (ON CONFLICT DO NOTHING). Edit brands here or later in Settings → Brands.

INSERT INTO brands (code, name, color, in_investor_pool, sort_order) VALUES
  ('TX',  'BM TechX',                '#2563EB', TRUE,  1),
  ('NPP', 'Namma Pondy Properties',  '#0F766E', TRUE,  2),
  ('AC',  'BM Academy',              '#7C3AED', TRUE,  3),
  ('CT',  'CoreTalents',             '#B45309', TRUE,  4),
  ('TN',  'TravellersNeed',          '#0891B2', TRUE,  5),
  ('DK',  'Dada''s Kitchen',         '#DC2626', FALSE, 6),
  ('VV',  'Velai Vaaippu',           '#16A34A', FALSE, 7),
  ('EC',  'EduConsultants',          '#9333EA', FALSE, 8),
  ('PO',  'ThePlotOne',              '#CA8A04', FALSE, 9),
  ('NR',  'Nera',                    '#1B2A4A', FALSE, 10),
  ('GD',  'GymDesk',                 '#475569', FALSE, 11),
  ('HO',  'Afra Common (shared costs)', '#1B2A4A', FALSE, 99)
ON CONFLICT (code) DO NOTHING;

INSERT INTO categories (name, kind) VALUES
  ('Client payment','in'), ('Advance received','in'), ('Commission','in'),
  ('Course fee','in'), ('Catering order','in'), ('Package booking','in'),
  ('Placement fee','in'), ('Subscription','in'), ('Other income','in'),
  ('Salary','out'), ('Rent','out'), ('Electricity & utilities','out'),
  ('Internet & phone','out'), ('Software & tools','out'), ('Ads & marketing','out'),
  ('Raw material','out'), ('Travel & fuel','out'), ('Vendor payment','out'),
  ('ESI / PF','out'), ('GST paid','out'), ('Office expense','out'),
  ('Investor payout','out'), ('Other expense','out')
ON CONFLICT (name, kind) DO NOTHING;

INSERT INTO accounts (name, kind) VALUES
  ('Cash box','cash'), ('Company bank','bank'), ('Company UPI','upi'), ('Razorpay','gateway')
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('company', '{
     "legal_name": "Afra Ventures Private Limited",
     "short_name": "Afra Ventures",
     "doc_prefix": "AFV",
     "gstin": "34ABGCA7083D1ZS",
     "cin": "U62011PY2026PTC009819",
     "state_code": "34",
     "state_name": "Puducherry",
     "address": "78 Lenin Street, Kosapalayam, Puducherry 605013",
     "email": "hello@afraventures.in",
     "website": "afraventures.in",
     "bank_details": "RBL Bank Ltd, Pondicherry Branch\nCurrent A/c: 408220969669\nName: AFRA VENTURES PRIVATE LIMITED\nIFSC: RATN0000307 · MICR: 605176003 · SWIFT: RATNINBB",
     "invoice_terms": "Payment due within 7 days. Thank you for your business."
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Starting split presets — edit the % in Settings → Shared cost splits to match reality.
INSERT INTO split_presets (name, rules) SELECT 'Office overheads (all running brands)', jsonb_agg(jsonb_build_object('brand_id', id, 'pct', pct))
  FROM (VALUES ('TX',30),('NPP',20),('AC',15),('CT',10),('TN',10),('DK',5),('VV',5),('EC',5)) v(code,pct) JOIN brands b ON b.code=v.code
ON CONFLICT (name) DO NOTHING;
INSERT INTO split_presets (name, rules) SELECT 'Equal — investor pool brands', jsonb_agg(jsonb_build_object('brand_id', id, 'pct', 20))
  FROM brands WHERE code IN ('TX','NPP','AC','CT','TN')
ON CONFLICT (name) DO NOTHING;
UPDATE categories SET default_preset_id = (SELECT id FROM split_presets WHERE name='Office overheads (all running brands)')
  WHERE kind='out' AND name IN ('Rent','Electricity & utilities','Internet & phone','Office expense','Software & tools') AND default_preset_id IS NULL;

-- ── v2.0 ──
INSERT INTO categories (name, kind, in_pnl) VALUES
  ('Investor capital','in',FALSE), ('Loan received','in',FALSE), ('GST refund','in',FALSE),
  ('GST paid','out',FALSE), ('TDS paid','out',FALSE), ('Loan repaid','out',FALSE), ('Refund to customer','out',TRUE)
ON CONFLICT (name, kind) DO NOTHING;
UPDATE categories SET in_pnl=FALSE WHERE name IN ('Investor payout','Investor capital','GST paid','TDS paid','Loan received','Loan repaid','GST refund');
INSERT INTO accounts (name, kind) VALUES ('RBL Current A/c','bank') ON CONFLICT (name) DO NOTHING;
INSERT INTO settings (key, value) VALUES
  ('books', '{"lock_until": null, "autolock_day": 10, "require_admin_2fa": false}'::jsonb),
  ('autopilot', '{
     "enabled": true,
     "jobs": {
       "recurring":      {"on": true,  "at": "06:00"},
       "reminders":      {"on": true,  "at": "10:00", "days_before": 2, "repeat_days": 3},
       "weekly_brief":   {"on": true,  "at": "09:00", "weekday": 1},
       "investor_statements": {"on": true, "at": "11:00"},
       "month_lock":     {"on": true,  "at": "07:00"},
       "bank_autopost":  {"on": true},
       "alerts":         {"on": true,  "at": "08:00", "low_cash_days": 30, "budget_pct": 90, "backup_hours": 36}
     }
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Petty cash / maintenance categories (office-wide by default — switch "Shared cost" off for a one-brand spend)
INSERT INTO categories (name, kind) VALUES
  ('Repairs & maintenance','out'), ('Tea, snacks & pantry','out'), ('Stationery & printing','out')
ON CONFLICT (name, kind) DO NOTHING;
UPDATE categories SET default_preset_id = (SELECT id FROM split_presets WHERE name='Office overheads (all running brands)')
  WHERE kind='out' AND name IN ('Repairs & maintenance','Tea, snacks & pantry','Stationery & printing') AND default_preset_id IS NULL;
INSERT INTO settings (key, value) VALUES
  ('petty_cash', '{"account_id": null, "float": 10000, "low_at": 2000, "approval": {"on": false, "above": 500, "cash_only": true}, "counts": []}'::jsonb)
ON CONFLICT (key) DO NOTHING;
