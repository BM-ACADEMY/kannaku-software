# Kanakku — how to use it (for Kamar, Karthika and the team)

Open **kanakku.afraventures.in** on phone or laptop and log in with your email.

## Every day — Book
- Any money that comes in or goes out → **Book → + New entry**, or just type it in the box at the top the way you'd say it:
  - `techx 5k vanthuchu ravi gpay`
  - `dk 1200 vegetables cash kuduthen`
  - `npp commission 1.5L received bank`
  - `salary 18000 kuduthen tx`
- It fills the form for you. **Check brand, amount and in/out, then Save.** Nothing is saved until you press Save.
- Wrong entry? Click it and edit. Only admin can delete.
- **Office bills (EB, rent, internet, tools):** choose Money out and the category — **Shared cost** switches on by itself and splits the bill across brands by the Office overheads rule. Change the % for that one bill if needed. Each brand's P&L then shows its own share of the bill.
  - `eb 4200 kattinom` · `office rent 15500 kuduthen` — these open already split.
  - A bill for only one brand (e.g. `techx hosting 3000 paid`) stays on that brand.

- **Moving money between our own accounts** (cash deposited into RBL) → **Transfer**. It's not income or expense.
- **A bill with GST** (internet, software, supplies): put the GST part in "GST in this bill" — we claim it back, so it isn't a cost.
- **Customer kept TDS?** Put it in "TDS the customer kept". It still counts as our income and we claim it in the tax return.
- **Bill photo:** open the entry → **+ Add photo / PDF** (on the phone it opens the camera).
- **To confirm** tab: rent, salaries and bank lines that Autopilot prepared. Check them, then **Confirm** (tick all to confirm many at once).

## Quotations and invoices — Deals
1. **+ New quotation** → pick brand and customer (**+** to add a new customer with their state and GSTIN).
2. Add lines with rate and GST %. Tax is worked out by itself — Puducherry customers get CGST+SGST, other states IGST.
3. Save → **WhatsApp** to send it, or **Print / PDF**.
   - **Print / PDF:** in the print window choose *Save as PDF* (the file is named after the invoice number), paper **A4**, and untick *Headers and footers* so the web address and date don't print in the margins. Long invoices run over several pages with the column titles repeated. To send the PDF on WhatsApp, save it, then attach it in the chat.
4. Customer agrees → **Convert to invoice**.
5. Money received → **Record payment**. It goes into the Book by itself. Part payments are fine. If the customer kept TDS, enter it — Kanakku fills the usual % for that customer.
6. Discount or mistake after invoicing? Open the invoice → **Credit note**. It reduces what they owe; if they'd already paid, it shows as a refund to pay.
7. **Purchase bills** tab: enter vendor bills (with their bill number and GST). They show under Dues → To pay; **Pay bill** when you pay.

Razorpay payments with the invoice number in the notes are recorded automatically.

## Petty cash, repairs and small spends
- **Enter every cash spend in Book** with *Paid from: Cash box*. Category: **Repairs & maintenance**, **Tea, snacks & pantry**, **Stationery & printing**, **Travel & fuel** or **Office expense**. Office-wide ones split across brands by themselves; for one brand only, untick *Shared cost* and pick the brand.
- **Money → Petty cash** shows the cash box balance, what was spent this month by category, bills missing, and past cash counts.
- **Top up:** when you take cash out of the bank, press **Top up** (it's a transfer, not an expense). It suggests the amount to bring the box back to its float.
- **Count the cash** once a week: type what's in the box. If it differs from the Book, admins get a message and you can find the missing entry.
- **Bills missing:** every cash spend should have a bill photo (open the entry → *+ Add photo / PDF*). If there truly is no bill (tea, auto fare), tick **No bill / receipt** instead — the CA sees those separately.
- **Staff approval (admin turns it on in Petty cash → Settings):** money out entered by staff over the limit (e.g. ₹500, cash only) waits in **Book → To confirm**. It doesn't count until an admin presses **Approve**. Admins get a WhatsApp/email.
- **Alerts:** each morning at 8 you're told if the cash box is below the warning level, and on Mondays about cash spends over a week old with no bill photo.

## Dues
- **To collect** — unpaid invoices show up here on their own, plus anything you add by hand (advances, etc.).
- **To pay** — vendor bills, rent due, anything we owe.
- **Remind** opens WhatsApp with a polite reminder. Reminders also go out automatically every morning at 10.
- **Settle** when the money moves — it is added to the Book.

## Investors (admin)
- Add capital each time money comes in (**+ Capital received**).
- Each investor has **their own % per brand** (e.g. TechX 20%, NPP 14%, blank for brands they're not in). When the % changes, pick the month it starts from — old months stay as they were.
- The statement shows each month's profit and share; tap a month to see it brand by brand. Early months build up until the first payout month.
- **+ Payout** when you pay the share. A statement goes to the investor on WhatsApp on the 5th of every month.

## Money
- **Balances**: what's in each account right now (RBL, cash, UPI).
- **Bank statement**: download the RBL statement as CSV, import it. Kanakku matches lines it already knows. For the rest, press **Sort** → choose brand/category → tick **Remember** so next month it does it by itself.

## Autopilot
Runs by itself every day: makes recurring entries, sends payment reminders, the Monday brief, investor statements, closes last month, and warns if cash may run short or a brand goes over budget. **What it did** shows every run. Set up rent and salaries under **Recurring entries**.

**Loans and rent — reminders and Google Calendar**
- Rent, EB, salaries: add each one once under **Recurring entries** (day of month, amount, brand or split). 
- Loan EMI: same, with category **Loan repaid** (it shows as *EMI*). The money you borrowed is booked once as **Loan received**. Neither is profit or loss.
- Every morning at 9:30 Autopilot sends admins one WhatsApp/email: what to pay **today, tomorrow, in 3 days**, plus anything overdue (bills, EMIs, rent, refunds, money you owe).
- **Coming up & calendar** tab shows everything due in the next 7–90 days.
- **Google Calendar:** turn on *Calendar link* → Copy → open calendar.google.com on a computer → left side *Other calendars* **+** → **From URL** → paste → Add calendar. Payments show as all-day events (🔴 pay, 🟢 collect). Then in that calendar's settings set *Event notifications* (e.g. 1 day before, 9 am) to get phone alerts. Google refreshes the calendar itself every few hours.
- The link is private. If it leaks, press **New link** — the old one stops working.

## P&L
Pick This month / Last month / This FY or any dates. Profit is shown **without GST** (that's the government's money). Other tabs: **Budget** (targets per brand), **Cash forecast** (will we run short?), **GST returns** (GSTR-1 + 3B — **Download for CA** every month), **TDS**.

## Settings (admin)
Company details and bank account printed on invoices, brands, **shared cost split rules** (how EB/rent are divided), which categories split automatically, and team logins.

## Your login
Bottom-left (your name): change password, **2-step login** (a code from Google Authenticator after your password — recommended for admins), **Log out everywhere** (lost phone). Forgot your password? Use **Forgot password?** on the sign-in screen.

**Rule of thumb:** if money moved, it must be in the Book the same day — and once a month is closed, it can't be changed.
