# Kanakku v2.0 — what changed and how to upgrade

**For the developer.** Read this first if Kanakku v1 is already running. A fresh install needs nothing extra: `./kanakku.sh install` does it all.

## Upgrade an existing install (10 minutes)

```bash
cd /opt/kanakku            # wherever it lives
./kanakku.sh backup        # safety copy first
git pull                   # or copy the new files over
cd server && npm install && cd ..     # updates package-lock.json (2 new packages: nodemailer, qrcode). Commit the lock file.
./kanakku.sh update        # adds INTEGRATIONS_KEY, rebuilds, applies the new tables on start
./kanakku.sh test          # 11 money-logic tests + a full book-keeping run on a throwaway database
```

**LeadOS-VPS setup** (`deploy/docker-compose.vps.yml`): run `docker compose -f deploy/docker-compose.vps.yml up -d --build`. This adds the **kanakku-backup** service, which was missing before, so that setup had no backups at all. Add `INTEGRATIONS_KEY=<random 64 hex>` to `server/.env` yourself (`openssl rand -hex 32`).

Database changes apply automatically on start (`initDb.js` runs `schema.sql` + `seed.sql`, all idempotent). Nothing is deleted. Old entries get `gst_amount = 0`, so history doesn't change until you fix old invoice payments (see below).

### After upgrading: one-time clean-up

1. **Settings → Payment accounts:** set each account's opening balance and the date it applies from (bank statement balance on 12 Sep 2026, or the day you started).
2. **Old invoice payments recorded under v1** count the GST as income. Either leave them (pre-v2 months only), or open each in the Book and fill "GST in this…". Payments recorded from now on are split automatically.
3. **Investor capital** already received under v1 was never put in the Book. Add it as a Book entry (Money in → category **Investor capital**, account RBL), or the bank balance will be short.
4. **WhatsApp:** Autopilot now sends reminders, the brief and statements itself. **Turn the old n8n workflows off** so nobody gets two messages. n8n is optional from now on.
5. **Settings → Integrations → Email:** add SMTP so forgot-password and email alerts work (Hostinger: `smtp.hostinger.com`, port 465).
6. **Settings → Books & security:** pick the auto-close day, and decide whether admins must use 2-step login.

## What was wrong in v1 (fixed)

| Problem | Fix |
|---|---|
| Invoice payments counted the GST as income, so every brand's profit and **the investor's share** were ~18% too high | Each payment stores its GST part (`entries.gst_amount`). P&L and investor share use `amount + tds − gst`. Part payments add up to the invoice GST exactly. |
| TDS deducted by customers left invoices "partial" forever | Payments take `tds_amount`; TDS settles the invoice, counts as income, and is listed in Reports → TDS |
| Book totals were summed from the first 300 rows only | Totals come from the database over every matching entry; the list pages |
| Investor capital, GST paid to government and loans showed as profit/loss | Categories have `in_pnl`; those are outside P&L |
| No backups on the LeadOS-VPS compose file | `kanakku-backup` service added; both setups also back up bill photos; optional off-site copy |
| Saved Razorpay/WhatsApp/AI keys were locked with `JWT_SECRET` (changing it silently wiped them) | Own `INTEGRATIONS_KEY`; old values still read and are re-saved with the new key on start |

## New features

**Books**
- **Transfers** between our own accounts (cash → RBL). They are not income or expense.
- **Opening balances**, plus a live balance per account (Money → Balances, and on Home).
- **GST on expenses** ("GST in this bill"), kept out of cost as input credit.
- **Credit notes** against an invoice. They reduce what's owed first; any remainder is a refund due, which shows in Dues → To pay. Refunds post a Money-out entry with GST reversed.
- **Purchase bills** from vendors: GST input credit (or not claimable), category, split across brands. They appear in Dues → To pay; paying one posts the Book entry.
- **Month lock** (Settings → Books & security). Nothing dated in a closed month can be added, changed or deleted, including by Razorpay sync or recurring entries (they move to the first open day). Autopilot closes last month on the chosen day, but not while entries are waiting to be confirmed.
- **Bill photos / PDFs** on Book entries and documents. Phone photos are shrunk before upload, and the real file type is checked. Files sit in the `uploads` Docker volume and are backed up daily.
- **Bank statement import** (CSV from RBL and most Indian banks), Money → Bank statement:
  - Lines are auto-matched to Book entries (same account, direction and amount, ±4 days).
  - **Auto rules** ("TNEB → EB, Office overheads split") book matching lines by themselves, either as drafts or posted directly.
  - Importing the same statement twice is safe; duplicates are skipped.
- **GSTR-1 working sheet**: B2B, B2C large, B2C small, credit notes (registered/unregistered), HSN summary (B2B/B2C), and documents issued per series. **GSTR-3B summary** sets input credit off in the legal order. One CSV for the CA. It warns about missing HSN codes and vendors without a GSTIN.
- **GSTIN check digit** is validated, and the state is taken from the GSTIN.

**Autopilot** (new page, runs inside the app, no n8n needed)
- **Recurring entries:** rent, salaries (split per brand), subscriptions. They arrive as drafts to confirm, or post directly, and missed periods catch up. A period is never made twice, and closed months are skipped.
- **Jobs**, each with on/off, a time, a last-result line and "Run now":
  - payment reminders (WhatsApp)
  - Monday brief (WhatsApp + email)
  - investor statements on each investor's day (retries the next day if it couldn't be delivered)
  - month close
  - alerts: cash may run out, brand over budget, backups stopped, vendor bills overdue
- A job claims its run with an atomic update, so two copies of the app never send twice. Every run is logged (Autopilot → What it did).

**Reports**
- **Budget vs actual** per brand per month, with "copy to the next 11 months".
- **Cash-flow forecast** for 30/60/90 days. It shows the day-by-day balance, the lowest point, the first day money would run out, and what's coming in and out.
- **TDS register.**

**Security**
- **2-step login** (Google/Microsoft Authenticator, RFC 6238, no extra service). "Admins must use it" is an option.
- **Forgot password:** an emailed one-time link, valid 30 minutes and single use. The answer is the same whether or not the email exists.
- **Log out everywhere.** A changed password, role or disabled account logs out all devices immediately (`token_version`, re-checked every 30 s).
- **Investor login** (role `investor`): sees only their own statement. Every other API answers 403.
- Rate limits on login, the code step, and forgot/reset.

- **To-pay reminders + Google Calendar (v2.1).** `lib/upcoming.js` lists what is due (unpaid bills/invoices/credit notes, dues with a due date, every coming date of active recurring entries; category *Loan repaid* = EMI). Autopilot job `pay_reminders` (09:30, `days_before` 3) sends one message to admins with overdue items and those due today, tomorrow and in N days. `GET /api/calendar/feed/<token>.ics` is a private iCalendar feed (no login, random 48-hex token, constant-time compare, 404 when off) that Google/Apple/Outlook subscribe to; on/off, include-incoming, days ahead and New link under Autopilot → *Coming up & calendar*.

**Tests:** `npm test` runs `server/test/money.test.js` (pure logic, runs anywhere) and `server/test/books.db.test.js` (creates `<db>_test`, runs real flows, drops it). In Docker it's `./kanakku.sh test`.

## Files

```
server/src/lib/   books.js (lock, GST share, balances) · ledger.js (one way to write an entry) · gstr.js · forecast.js
                  bankcsv.js · reconcile.js · recurring.js · autopilot.js · notify.js · secrets.js · totp.js
                  upcoming.js · ics.js
server/src/routes/ bank.js · recurring.js · attachments.js · autopilot.js · portal.js · calendar.js  (+ big changes in deals, entries, auth, meta, reports)
web/src/pages/    Money.jsx · Autopilot.jsx · Portal.jsx  (+ Book, Deals, Reports, Settings, Login, Dashboard rebuilt)
web/src/components/ Attachments.jsx · TwoStep.jsx
server/test/      money.test.js · books.db.test.js
```

## Not done (on purpose)

- **Tamil labels.** The screens are English. A Tamil switch is a translation pass over every page — ask if you want it.
- **E-invoicing (IRN)** is only needed above ₹5 crore turnover.
- **Direct GST portal filing.** The CA files from the CSV.
- **Payroll (ESI/PF calculation).** Salaries come in as recurring entries split by brand; the payroll itself stays in your payroll system.
