# Kanakku — Afra Ventures finance system

Multi-brand books for **Afra Ventures Private Limited** (GSTIN 34ABGCA7083D1ZS, Puducherry).
One login, every brand: BM TechX, Namma Pondy Properties, BM Academy, CoreTalents, TravellersNeed,
Dada's Kitchen, Velai Vaaippu, EduConsultants, ThePlotOne, Nera, GymDesk and Head Office.

| Tab | What it does |
|---|---|
| **Home** | Today's in/out, month net, money to collect and to pay, brand bars, latest entries |
| **Book** | Daily cash in/out per brand. Type a Tanglish note ("techx 5k vanthuchu ravi gpay") and it fills the entry for you. Office bills (EB, rent, internet) split across brands by a saved rule so each brand carries its own costs |
| **Deals** | Quotation → invoice → payment (with TDS) → credit note → refund; vendor purchase bills with GST input credit. GST worked out automatically. Print/PDF, WhatsApp share, bill photos |
| **Dues** | Unpaid invoices appear by themselves; add other receivables/payables by hand; one-tap WhatsApp reminder; settle → posts to Book |
| **Investors** | Profit-share (no interest). Own % per brand per investor, changes dated so past months never move, pooled or per-brand loss rule, capital tranches, accruals, payouts, monthly statement |
| **Reports** | P&L by brand (GST kept out, TDS counted), budget vs actual, 30/60/90-day cash forecast, GSTR-1 + GSTR-3B sheet for the CA, TDS register |
| **Money** | Live balance per account, **petty cash** (cash box, top-up, weekly count, bills missing, staff-spend approval), bank statement import with auto-matching, and auto rules that sort lines by themselves |
| **Autopilot** | Daily jobs inside the app: recurring entries, reminders, Monday brief, investor statements, month close, alerts — with a log. **To-pay reminders** (rent, EMI, bills) each morning, and a private **Google Calendar link** of everything due |
| **Settings** | Company details on invoices, brands, split rules, categories, accounts & opening balances, books lock, 2-step login, integrations (AI, Razorpay, WhatsApp, email), users & roles (incl. investor logins) |

Autopilot runs inside the app (no n8n needed): reminders, Monday brief, investor statements, recurring entries, month close, alerts. **Upgrading from v1? Read docs/UPGRADE_v2.md.**
Razorpay webhook: captured payments land in the Book automatically and close the matching invoice.

## Stack
React 18 + Vite (`web/`) · Node 20 + Express + PostgreSQL 16 (`server/`) · n8n · Meta WhatsApp Cloud API · Razorpay webhook · Grok (x.ai) for Tanglish parsing and the weekly brief (optional — a built-in parser works without a key).

## Plug and run (one command)

Needs only **Docker** (Docker Desktop on Windows/Mac, or any Ubuntu server). On Windows run the commands in **Git Bash** or **WSL**.

```bash
unzip kanakku-afra-ventures.zip && cd kanakku
chmod +x kanakku.sh
./kanakku.sh install          # on the VPS: sudo ./kanakku.sh install
```

It asks for: the domain (blank = run on this computer), the admin name/email/password, and optional Grok, Razorpay and WhatsApp keys. Then it does everything else by itself:

- generates the database password, login secret and n8n key, and writes both `.env` files
- builds the app, starts PostgreSQL + app + n8n + daily backups
- creates the tables, brands, categories, split rules, Afra company and RBL bank details, and your admin login
- imports the 3 WhatsApp workflows into n8n
- on a server with a domain: sets up nginx and free HTTPS (Let's Encrypt) for `kanakku.<domain>` and `n8n.<domain>`

Open the address it prints and log in.

| Command | Does |
|---|---|
| `./kanakku.sh update` | backup → rebuild → restart (data kept, DB changes applied automatically) |
| `./kanakku.sh status` / `logs` | what's running / live logs |
| `./kanakku.sh backup` / `restore FILE` | backup now / restore one |
| `./kanakku.sh smoke` | end-to-end test (creates sample records) |
| `./kanakku.sh reset-pass` | new password for any user |
| `./kanakku.sh n8n-import` | re-import the old n8n workflows (optional — Autopilot replaces them) |
| `./kanakku.sh test` | automatic money-logic tests + full book-keeping run on a throwaway database |
| `./kanakku.sh offsite-setup` | copy backups to Google Drive every 6 hours |

### Developing without Docker
```bash
cd server && cp .env.example .env   # set DATABASE_URL to a local Postgres, JWT_SECRET, ADMIN_*
npm install && npm run db:init && npm run dev      # API on :4000
cd ../web && npm install && npm run dev            # UI on :5173 (proxies /api)
```

## Folder map
```
server/   API — src/routes (one file per tab), src/lib (db, gst, ai, reports), db/schema.sql, db/seed.sql
web/      React UI — src/pages (one file per tab), src/components/ui.jsx, src/styles.css
n8n/      workflows/ (3 importable workflows) + WHATSAPP_TEMPLATES.md
kanakku.sh  install / update / backup / restore / logs in one script
deploy/   nginx.conf
docs/     UPGRADE_v2.md (what changed in v2 + upgrade steps), DEV_GUIDE.md (rules/deploy/API), USER_GUIDE.md (for the team), BUILD_PLAN.md (acceptance tests)
server/test/  npm test — money logic + full database run
```
