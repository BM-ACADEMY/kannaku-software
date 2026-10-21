# Kanakku — Developer Guide

Owner: Afra Ventures Private Limited · Product owner: Kamarudeen B · Accounts user: Karthika
Domain: `kanakku.afraventures.in` (app) · `n8n.afraventures.in` (automations)

This package is a **working codebase**, not a blueprint. Your job is to install, configure, deploy, test against
the acceptance list in `BUILD_PLAN.md`, and fix anything that turns up in real use.

---

## 1. Architecture

```
Browser (React SPA) ──/api──▶ Express API ──▶ PostgreSQL
                                  ▲   │
       Razorpay ──webhook─────────┘   └──▶ Grok (x.ai) — optional
       n8n ──x-internal-key──▶ /api/internal/* ──▶ WhatsApp Cloud API
```

- In production one Node process serves both the API and the built React app (`web/dist`).
- `server/src/routes/*.js` — one router per area. `server/src/lib/*` — shared logic (GST, reports, AI).
- Money is stored as `NUMERIC(14,2)` and returned to JS as numbers. Dates are `DATE` and returned as `YYYY-MM-DD` strings (no timezone drift).
- Nothing is hard-deleted. Book entries are soft-deleted (`deleted_at`), documents are cancelled, and every write goes into `audit_log`.

## 2. Roles

| Role | Can do |
|---|---|
| `admin` | Everything, incl. users, brands, company settings, investor changes, deleting/cancelling |
| `accounts` | Book, invoices, payments, dues, view investors, reports |
| `sales` | Customers, quotations (create/edit/send), see what's due to collect. **No** money totals, Book, P&L, bills or investors |
| `investor` | Only `GET /api/portal/statement` (their own statement) and `/bootstrap`. Everything else is 403 (blocked in `index.js` before any router) |

Enforced on the server (`requireRole`) — the UI only hides what the server already blocks.

## 3. Business rules (please keep these)

1. **GST** — company state is `34` (Puducherry). If the customer's state = 34 → CGST + SGST (half each); otherwise IGST. Rates per line: 0/5/12/18/28. Logic: `server/src/lib/gst.js`.
2. **Document numbers** — `AFV/<BRAND CODE>/<QT|INV>/<FY>/<0001>`, e.g. `AFV/TX/INV/2627/0007`. Separate series per brand, per type, per Indian financial year (Apr–Mar). Generated inside a transaction (`doc_sequences`) so two users can never get the same number. Never reuse or renumber.
3. **Quote → invoice** — converting copies the items into a new invoice with its own number and marks the quote `converted`.
4. **Invoices with payments or credit notes can't be edited or cancelled** — issue a credit note (`POST /deals/documents/:id/credit-note`). A credit note first reduces the invoice balance (`documents.amount_credited`); anything above the balance is a refund due (credit note `balance`), paid with `/refund`.
5. **Money vs profit (v2)** — `entries.amount` is cash that moved. `gst_amount` is the GST inside it, `tds_amount` the TDS a customer kept. **Profit/loss value = amount + tds − gst** (`entry_lines.pnl_amount`). Every report and the investor share use it, so GST is never income or cost. Categories with `in_pnl = false` (investor capital/payout, GST paid, TDS paid, loans) and `type = 'transfer'` are never in P&L. Entries with `status = 'pending'` (autopilot drafts) are in no report until confirmed.
6. **Payments** (`recordPayment` in `routes/deals.js`) — invoice: cash `amount` + `tds_amount` settle the balance; bill: cash paid. The GST share is proportional, and the payment that closes the document takes whatever GST is left, so the total is exact. A non-claimable bill (`itc_eligible = false`) puts no GST aside — it's all cost. A bill with `split` posts its payment split across brands.
6a. **Dues** — unpaid invoices (to collect), unpaid bills and refunds owed on credit notes (to pay) show automatically. The `dues` table is only for things without a document (advances, deposits, loans). Settling a due posts the cash to the Book.
6b. **Month lock** — `settings.books.lock_until`. `assertOpen()` (lib/books.js) refuses any write dated on/before it: entries, payments, documents, credit notes, refunds, contributions, payouts, recurring, bank rules. Razorpay payments dated in a closed month are booked on the first open day with "(paid <date>)" in the note. Reopening is an admin change, logged in `audit_log`.
6c. **Every Book write goes through `lib/ledger.js`** (`insertEntry` / `updateEntry`) — lock check, split, transfer rules, GST/TDS sanity. Don't `INSERT INTO entries` anywhere else.
7. **Shared costs (v1.1)** — bills that belong to the whole office (EB, rent, internet, tools, office expense) are saved once and **split across brands** by a rule (`split_presets`, edited in Settings → Shared cost splits). The entry itself sits on brand `HO` (Afra Common) and the per-brand slices are stored in `entry_allocations` (rounded to the paisa, always adding up to the bill). Every report reads money through the `entry_lines` view, so each brand's P&L carries its own slice and `HO` ends up with nothing unsplit. A category can have a default rule (`categories.default_preset_id`) so picking "Electricity & utilities" switches the split on by itself. Editing a rule never rewrites old entries.
8. **Investors (v1.1)** — profit-share only, no fixed interest. Each investor has their **own % per brand** (`investor_brands`), versioned by `effective_from` (YYYY-MM): raising 14% → 20% from December leaves Sep–Nov untouched. For each month: brand share = brand net profit × that brand's %. Then:
   - `loss_rule = pooled` (default — matches the current signed agreement): add the brand shares, floor the month at 0, so a loss-making brand pulls the month down.
   - `loss_rule = per_brand`: floor each brand at 0 on its own, so a loss-making brand simply gives nothing.
   - `include_shared_costs = true` (default): the brand's slice of shared bills counts as its expense. `false`: only costs posted directly to the brand count.
   Investors with no `investor_brands` rows fall back to the old rule (`profit_share_pct` on every `in_investor_pool` brand). First `payout_from_month − 1` months accrue. Recording a payout posts an `Investor payout` out-entry to `HO`; that category is **excluded from P&L** (distribution, not expense).
9. **AI entry** — `/api/ai/parse-entry` only returns a draft. The user always confirms before saving. A draft for a shared category with no brand (e.g. "eb 4200 kattinom") opens with the split switched on.

## 4. Environment variables (`server/.env`)

| Var | Needed | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/kanakku` |
| `JWT_SECRET` | yes | 48+ random bytes. App refuses to start with the placeholder |
| `ADMIN_NAME/EMAIL/PASSWORD` | first run | Used once by `npm run db:init` when the users table is empty |
| `CORS_ORIGIN` | prod | `https://kanakku.afraventures.in` |
| `INTERNAL_API_KEY` | for n8n | Same value in the root `.env` for docker-compose |
| `XAI_API_KEY`, `XAI_MODEL` | optional | Grok. Without it the rule-based Tanglish parser is used |
| `RAZORPAY_WEBHOOK_SECRET` | optional | From Razorpay → Webhooks |
| `RAZORPAY_DEFAULT_BRAND` | optional | Brand code for payments with no invoice/brand note (default `HO`) |
| `INTEGRATIONS_KEY` | yes (v2) | Encrypts saved keys and 2-step secrets. 64 hex chars. Separate from `JWT_SECRET` on purpose — never change it after setup (saved keys would need re-typing). `kanakku.sh install/update` creates it |
| `APP_URL` | yes | Used in forgot-password links, e.g. `https://kanakku.afraventures.in` |
| `UPLOAD_DIR` | Docker sets it | Where bill photos are stored (`/app/uploads`, a volume) |
| `BACKUP_DIR` | Docker sets it | Read-only view of backups so Autopilot can alert if they stop |
| `AUTOPILOT` | optional | `off` disables the in-app scheduler (e.g. a second copy of the app). Jobs are safe to run on two copies anyway |
| `SMTP_HOST/PORT/USER/PASS/FROM` | optional | Email; usually set in Settings → Integrations instead |

## 5. Deploy on the Hostinger VPS (Ubuntu 22/24)

**Quick way:** point DNS (`kanakku.afraventures.in`, `n8n.afraventures.in`) at the VPS, copy the folder there, run `sudo ./kanakku.sh install` and answer the questions. It does every step below automatically. The manual steps are kept here for reference and troubleshooting.

```bash
# one-time server setup
sudo apt update && sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
sudo usermod -aG docker $USER && newgrp docker

# DNS: A records  kanakku.afraventures.in → VPS IP,  n8n.afraventures.in → VPS IP

# code
git clone <your repo> /opt/kanakku && cd /opt/kanakku
cp .env.example .env                 # DB_PASSWORD, INTERNAL_API_KEY, WA_PHONE_NUMBER_ID, WA_TOKEN
cp server/.env.example server/.env   # JWT_SECRET, ADMIN_*, CORS_ORIGIN, INTERNAL_API_KEY (same), XAI_*, RAZORPAY_*
docker compose up -d --build
docker compose exec app npm run db:init

# nginx + https
sudo cp deploy/nginx.conf /etc/nginx/sites-available/kanakku
sudo ln -s /etc/nginx/sites-available/kanakku /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kanakku.afraventures.in -d n8n.afraventures.in

# verify
curl https://kanakku.afraventures.in/api/health
```

Updates: `git pull && docker compose up -d --build`. Schema changes go at the bottom of `schema.sql` as
idempotent `ALTER TABLE … IF NOT EXISTS` lines, then `docker compose exec app npm run db:init`.

**Backups** — the `backup` service writes `backups/kanakku_YYYY-MM-DD.sql.gz` daily and keeps 30 days.
Copy that folder off the VPS weekly (Google Drive / another server). Restore:
`gunzip -c backups/kanakku_2026-10-16.sql.gz | docker compose exec -T db psql -U kanakku kanakku`.

## 6. Integrations

### Razorpay
Dashboard → Settings → Webhooks → URL `https://kanakku.afraventures.in/api/webhooks/razorpay`, event `payment.captured`, set a secret → `RAZORPAY_WEBHOOK_SECRET`.
When creating a payment link, add a note **`invoice` = the invoice number** (e.g. `AFV/TX/INV/2627/0007`) → the payment closes that invoice. Or add **`brand` = brand code** (e.g. `TX`) → it lands as income on that brand. Duplicates are ignored by payment id.

### Autopilot (v2 — replaces the n8n workflows)
`lib/autopilot.js` runs inside the app every 5 minutes (India time). Each job runs once a day at its time and claims the day with an atomic `UPDATE settings … WHERE value->>job <> today`, so two app copies never double-send. Settings live in `settings.autopilot`; results in `autopilot_log` (kept 120 days). Jobs: `recurring`, `month_lock`, `alerts`, `weekly_brief`, `reminders`, `investor_statements`, plus the `bank_autopost` switch. "Run now" (`POST /api/autopilot/run/:job`) forces a run. Messages go through `lib/notify.js` (WhatsApp templates + SMTP email) and never throw: failures are logged and retried next day where it matters (investor statements are only marked sent once delivered).

### WhatsApp (Meta Cloud API)
1. Create the 3 templates in `n8n/WHATSAPP_TEMPLATES.md` and wait for approval.
2. Save the Phone number ID and permanent token in **Settings → Integrations → WhatsApp** (or `WA_PHONE_NUMBER_ID` / `WA_TOKEN` in `.env`).
3. Autopilot sends with them. **If the old n8n workflows are active, switch them off.** n8n is now optional. The legacy route: `kanakku.sh install` already imported the workflows (or run `./kanakku.sh n8n-import`). Open `https://n8n.afraventures.in`, create the owner account, run each workflow once manually, then toggle **Active**. Manual import: **Import from file** each JSON in `n8n/workflows/`.

| Workflow | When | Calls |
|---|---|---|
| 01 Dues reminders | daily 10:00 IST | `GET /api/internal/dues-reminders?days=2` → template `afv_payment_reminder` → `POST /api/internal/dues-reminders/mark` (no repeat for 3 days) |
| 02 CFO brief | Monday 09:00 | `GET /api/internal/weekly-brief` → admins with a phone number → `afv_weekly_brief` |
| 03 Investor statement | 5th, 11:00 | `GET /api/internal/investor-statements` (previous month) → `afv_investor_statement` |

`/api/internal/*` requires header `x-internal-key` and is blocked in nginx — n8n reaches it over the Docker network (`http://app:4000`).

### Grok
Optional. Set `XAI_API_KEY`. Used for (a) parsing typed notes into a draft entry, (b) writing the weekly brief. Any Grok failure falls back to the rule parser / plain-number brief, so the app never breaks because of AI.

## 7. API reference (all under `/api`, JSON, `Authorization: Bearer <token>` unless noted)

| Method & path | Role | Purpose |
|---|---|---|
| `POST /auth/login` | public | `{email,password}` → `{token,user}` |
| `GET /auth/me` · `POST /auth/change-password` | any | session / own password |
| `GET /bootstrap` | any | brands, categories, accounts, company settings |
| `POST /brands` · `PUT /brands/:id` | admin | manage brands |
| `POST /categories` · `PUT /categories/:id` | admin, accounts / admin | add category · set its default split rule |
| `POST /presets` · `PUT /presets/:id` | admin | shared-cost split rules `{name, rules:[{brand_id,pct}]}` (must total 100) |
| `PUT /settings/company` | admin | invoice header details |
| `GET/POST /users` · `PUT /users/:id` | admin | team access |
| `GET /entries?from&to&brand_id&type&q` | admin, accounts | Book list + totals |
| `POST /entries` · `PUT /entries/:id` · `DELETE /entries/:id` | accounts / admin | Book CRUD (soft delete, admin). Shared cost: send `split:[{brand_id,pct}]` + optional `split_preset_id` and no `brand_id` |
| `POST /ai/parse-entry` | admin, accounts | `{text}` → draft entry |
| `GET/POST /deals/customers` · `PUT /deals/customers/:id` | any | customers |
| `GET /deals/documents?doc_type&status&brand_id&q` · `GET /deals/documents/:id` | any | quotes & invoices |
| `POST /deals/documents` · `PUT /deals/documents/:id` | any (sales: quotes only) | create/edit with items |
| `POST /deals/documents/:id/status` | any | quote: draft/sent/accepted/rejected |
| `POST /deals/documents/:id/convert` | admin, accounts | quote → invoice |
| `POST /deals/documents/:id/payments` | admin, accounts | record payment → Book |
| `POST /deals/documents/:id/cancel` | admin | cancel (no payments) |
| `GET /dues?status=open|all` · `POST /dues` · `PUT /dues/:id` | any / accounts | dues |
| `POST /dues/:id/settle` · `/write-off` · `/reminded` | accounts / admin | settle → Book |
| `GET /investors` · `POST` · `PUT /:id` | accounts (view) / admin | investors. Body takes `brands:[{brand_id,share_pct}]`, `brands_effective_from` (YYYY-MM), `loss_rule`, `include_shared_costs` |
| `POST /investors/:id/contributions` · `/payouts` | admin | capital in / profit paid |
| `GET /investors/:id/statement?month=YYYY-MM` | admin, accounts | monthly share table with per-brand breakdown and share history |
| `GET /reports/dashboard` | any (sales gets reduced view) | home screen |
| `GET /reports/pnl?from&to&brand_id` | admin, accounts | P&L + trend |
| `GET /reports/gst?month=YYYY-MM` | admin, accounts | GST sales register |
| `POST /deals/documents/:id/credit-note` · `/refund` | admin, accounts | credit note against an invoice · pay back a refund |
| `GET /reports/gstr?month` · `/tds?from&to` · `/forecast?days` · `GET/PUT /budget` · `POST /budget/copy` | admin, accounts (budget edit: admin) | GST returns sheet · TDS register · cash forecast · budgets |
| `GET /accounts` | admin, accounts | accounts with opening and live balance |
| `GET/PUT /settings/books` | admin (read: accounts) | month lock, auto-close day, require admin 2-step |
| `POST /entries/confirm` `{ids}` | admin, accounts | confirm autopilot drafts |
| `POST /bank/preview` · `/import` · `GET /bank/lines` · `/lines/:id/candidates` · `POST /lines/:id/create|link|ignore|unlink` · `/reconcile` · `/rules` CRUD | admin, accounts | bank statement import + matching + rules |
| `GET/POST/PUT/DELETE /recurring` · `POST /recurring/run` | admin, accounts | recurring entries |
| `GET/POST /attachments/:entity/:id` · `GET/DELETE /attachments/file/:id` | admin, accounts (delete: admin) | bill photos / PDFs (base64 JSON upload, 8 MB) |
| `GET/PUT /autopilot` · `POST /autopilot/run/:job` | admin (read: accounts) | autopilot settings, log, run now |
| `POST /auth/login/otp` · `/forgot` · `/reset` · `/2fa/setup` · `/2fa/enable` · `/2fa/disable` · `/logout-all` | public / logged in | 2-step login, password reset, log out everywhere |
| `GET /calendar/feed/:token.ics` | private token, no login | iCalendar feed of payments due (Google Calendar "From URL") |
| `GET/POST /calendar/settings` · `GET /calendar/upcoming?days` | admin (upcoming: accounts too) | calendar link on/off/new, what's due |
| `GET /petty` · `PUT /petty/settings` · `POST /petty/topup` · `POST /petty/count` | admin, accounts (settings: admin) | petty cash status, float/low/approval settings, top-up transfer, cash count |
| `GET /portal/statement?month` | investor | own statement only |
| `POST /webhooks/razorpay` | signature | Razorpay |
| `/internal/*` | x-internal-key | n8n only |


### Bank statements
`lib/bankcsv.js` finds the transactions table in any Indian net-banking CSV (header lines above it, DD/MM/YYYY or 16-Oct-2026 dates, Withdrawal/Deposit or Amount + Dr/Cr columns). Each line gets a hash (account, date, text, amounts, running balance), so re-importing overlapping statements skips duplicates. `lib/reconcile.js` matches lines to entries (same account or no account, same direction, same amount, ±4 days; a reference match wins, and a tie is left for a person), then applies `bank_rules`. Rule entries are `pending` unless the rule is auto-post and Autopilot's `bank_autopost` is on.

### Petty cash & approvals
`lib/petty.js` holds the rule: `needsApproval(cfg, {role, type, amount, accountKind})` is true only for non-admin, money-out, over the limit, and (if `cash_only`) paid from a `cash` account. `routes/entries.js` applies it on create and on edit (a staff edit of a pending or changed-amount entry sends it back to pending); `POST /entries/confirm` refuses `approval_required` rows unless the user is admin and stamps `approved_by/at`. Pending entries are in no balance, P&L or investor figure. "Bills missing" = cash-account money-out, last 60 days, no `attachments` row, `no_bill = false`. The cash box is `settings.petty_cash.account_id`, else the first active `cash` account.

### Reminders & calendar
`lib/upcoming.js` is the single list of money due (used by the `pay_reminders` Autopilot job and by `lib/ics.js`). The feed is all-day events with stable UIDs (`doc-<id>`, `due-<id>`, `rec-<id>-<date>`) so calendar apps update instead of duplicating; text is RFC 5545-escaped and folded at 75 bytes. Set `APP_URL` so the copied link has the public domain. The feed path must not be behind login in nginx (it is under `/api`, already proxied).

### Email (SMTP)
Settings → Integrations → Email. Hostinger: `smtp.hostinger.com`, port 465, full mailbox address + password. Gmail: an App Password. "Test" sends to the logged-in admin.

## 8. Testing

- `npm test` (or `./kanakku.sh test` in Docker):
  - `test/money.test.js` — pure logic: GST, GSTIN check digit, splits to the paisa, payment GST shares, bank CSV, 2-step codes (RFC vector), GSTR-1/3B, recurring dates, forecast.
  - `test/books.db.test.js` — creates `<db>_test`, runs real flows (TDS payment, part payments, credit note, split bill with input credit, transfer, capital, P&L, balances, Book totals, month lock, bank matching + rules, recurring catch-up, dated investor shares), then drops it. Needs a DB user that can create databases (the Docker one can). Set `TEST_DATABASE_URL` to use a database you made yourself.
- `npm run smoke` (server folder, API running) walks: login → AI parse → entry → customer → quote → convert → partial payment → dues → investor + statement → P&L → GST → dashboard.
- Then go through the acceptance list in `BUILD_PLAN.md` in the browser, on a phone too.
- Before go-live: create the real users, delete test data (`TRUNCATE entries, documents, document_items, customers, dues, investors, investor_contributions, investor_payouts, doc_sequences, audit_log RESTART IDENTITY CASCADE;`), and set the bank details in Settings so they print on invoices.

## 9. Not in this package
GSTR-1 JSON upload file (the CSV is for the CA) · e-invoicing / IRN (only above ₹5 Cr) · multi-company books · PDF emailed straight from the server · Tamil labels.

See **docs/UPGRADE_v2.md** for the v2 change list and the upgrade steps for an existing install.
