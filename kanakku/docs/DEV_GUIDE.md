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
| `sales` | Customers, quotations (create/edit/send), see what's due to collect. **No** money totals, Book, P&L or investors |

Enforced on the server (`requireRole`) — the UI only hides what the server already blocks.

## 3. Business rules (please keep these)

1. **GST** — company state is `34` (Puducherry). If the customer's state = 34 → CGST + SGST (half each); otherwise IGST. Rates per line: 0/5/12/18/28. Logic: `server/src/lib/gst.js`.
2. **Document numbers** — `AFV/<BRAND CODE>/<QT|INV>/<FY>/<0001>`, e.g. `AFV/TX/INV/2627/0007`. Separate series per brand, per type, per Indian financial year (Apr–Mar). Generated inside a transaction (`doc_sequences`) so two users can never get the same number. Never reuse or renumber.
3. **Quote → invoice** — converting copies the items into a new invoice with its own number and marks the quote `converted`.
4. **Invoices with payments can't be edited or cancelled** — issue a credit note instead (credit notes are a phase-2 item).
5. **Payment on an invoice** creates a Book `in` entry linked by `document_id`, updates `amount_paid` and status `unpaid → partial → paid`.
6. **Dues** — unpaid invoices are shown as receivables automatically (not copied into `dues`). The `dues` table is only for things without an invoice (advances, vendor bills, loans to collect). Settling a due posts the cash to the Book.
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

### WhatsApp (Meta Cloud API) + n8n
1. Create the 3 templates in `n8n/WHATSAPP_TEMPLATES.md` and wait for approval.
2. Put `WA_PHONE_NUMBER_ID` and a permanent `WA_TOKEN` (System User token) in the root `.env`.
3. `kanakku.sh install` already imported the workflows (or run `./kanakku.sh n8n-import`). Open `https://n8n.afraventures.in`, create the owner account, run each workflow once manually, then toggle **Active**. Manual import: **Import from file** each JSON in `n8n/workflows/`.

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
| `POST /webhooks/razorpay` | signature | Razorpay |
| `/internal/*` | x-internal-key | n8n only |


## 8. Testing

- `npm run smoke` (server folder, API running) walks: login → AI parse → entry → customer → quote → convert → partial payment → dues → investor + statement → P&L → GST → dashboard.
- Then go through the acceptance list in `BUILD_PLAN.md` in the browser, on a phone too.
- Before go-live: create the real users, delete test data (`TRUNCATE entries, documents, document_items, customers, dues, investors, investor_contributions, investor_payouts, doc_sequences, audit_log RESTART IDENTITY CASCADE;`), and set the bank details in Settings so they print on invoices.

## 9. Phase 2 (not in this package)
Credit notes · purchase bills + input tax credit · GSTR-1 JSON export · bank statement import (CSV) · attachments (bill photos) · multi-company (if ABM Groups or another entity ever needs its own books) · PDF emailed straight from the server.
