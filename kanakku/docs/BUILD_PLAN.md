# Kanakku — Build & go-live plan (7 working days)

The code is written. These days are for setup, testing with real data, fixes and training.

| Day | Work | Done when |
|---|---|---|
| 1 | Repo on GitHub (private). Run locally. Read DEV_GUIDE. `npm run smoke` passes | Smoke test prints "All good." |
| 2 | VPS: Docker, DNS, nginx, HTTPS, `db:init`. Real admin + Karthika (accounts) + sales users | `https://kanakku.afraventures.in` login works on phone and laptop |
| 3 | Settings: company bank details, check brand list/codes/colours, investor pool flags. Enter the October opening entries | Kamar confirms invoice header and brand list |
| 4 | Deals: real customers, 2–3 real quotations → invoices, partial and full payments, print to PDF, WhatsApp share | Printed invoice checked by the CA (GST lines, GSTIN, HSN/SAC) |
| 5 | Razorpay webhook (test mode first, then live). Grok key. Tanglish entry tested with Karthika's real notes | A test Razorpay payment closes an invoice by itself |
| 6 | WhatsApp templates approved; import the 3 n8n workflows; run each manually; activate | Reminder, brief and statement received on a test phone |
| 7 | Backups verified (restore into a scratch DB). Wipe test data. 30-min training for Kamar & Karthika using USER_GUIDE | Live from the next day |

## Acceptance checklist (tick all before handover)

**Login & roles**
- [ ] Wrong password shows an error; 30+ attempts in 15 min are blocked
- [ ] Sales user cannot see Book, P&L, Investors, Settings — and the API returns 403 if tried directly
- [ ] Accounts user cannot open Settings or add investors

**Book**
- [ ] Add / edit an entry; admin can delete; totals match a manual sum
- [ ] Typing `techx 5k vanthuchu ravi gpay` fills: Money in, ₹5,000, BM TechX, Company UPI
- [ ] Typing `dk 1200 vegetables cash kuduthen` fills: Money out, ₹1,200, Dada's Kitchen, Raw material, Cash box
- [ ] Filters by date, brand, in/out and search all work

**Shared costs**
- [ ] Book → Money out → category "Electricity & utilities" → split switches on with the Office overheads rule; slices add up to the bill exactly
- [ ] Typing `eb 4200 kattinom` opens the entry already split
- [ ] P&L by brand shows each brand's slice; Afra Common shows ₹0 for split bills
- [ ] Editing a split rule in Settings does not change entries already saved
- [ ] Filtering the Book by one brand shows only that brand's slice of a shared bill

**Deals**
- [ ] Quote for a Puducherry customer shows CGST 9% + SGST 9%; for a Tamil Nadu customer shows IGST 18%
- [ ] Numbers run AFV/TX/QT/2627/0001, 0002… separately per brand; a new series starts on 1 April
- [ ] Convert quote → invoice; quote shows "converted"
- [ ] Partial payment → status "partial" and a Book entry appears; balance payment → "paid"
- [ ] Invoice with a payment cannot be edited or cancelled
- [ ] Print / PDF looks right on A4; amount in words is correct

**Dues**
- [ ] Unpaid invoice appears under "To collect" without adding it manually
- [ ] Manual payable → Settle → Book shows Money out
- [ ] Remind opens WhatsApp with the right text and number

**Investors**
- [ ] Two capital tranches add up; for one month, each brand's net × its % matches a hand calculation
- [ ] Change one brand's % "from next month" → this month's statement stays the same, next month uses the new %
- [ ] Pooled: a loss in CoreTalents reduces the month's share. Per-brand: it counts as zero
- [ ] Switching "shared office costs" to Not deducted raises the share by exactly the pooled brands' slices
- [ ] Months before the first payout month show "accrues"; payout reduces the balance and posts a Head Office out-entry
- [ ] That payout does NOT reduce P&L

**Reports**
- [ ] P&L by brand equals Book totals for the same dates (excluding investor payouts)
- [ ] GST register totals equal the sum of that month's invoices; CSV opens in Excel

**v2 — money must be right**
- [ ] Invoice ₹60,000 + 18% paid as ₹64,800 + TDS ₹6,000 → invoice "paid", P&L income ₹60,000 (not ₹70,800), Reports → TDS shows ₹6,000
- [ ] Bill ₹8,500 + GST ₹1,530 paid → P&L cost ₹8,500; GST returns shows ₹1,530 input credit
- [ ] Credit note on an unpaid invoice reduces its balance; on a paid one it shows under Dues → To pay; Refund posts a Money-out
- [ ] Transfer cash → RBL: balances move, P&L doesn't
- [ ] Investor capital entry: bank balance goes up, P&L doesn't
- [ ] Book with more than 200 entries: totals at the top don't change when you "Show more"
- [ ] Close September → a September entry can't be added, edited or deleted; reopening is in the Activity log
- [ ] Import an RBL CSV twice → second time "already imported"; matched lines link to their entries; a "Remember" rule sorts next month's line by itself
- [ ] Recurring rent (post directly) + salary (to confirm) appear on their days; nothing appears twice
- [ ] GSTR-3B "pay in cash" = output GST − input credit, checked by the CA for one month
- [ ] 2-step login on for an admin; forgot-password email arrives and the link works once only
- [ ] Investor login sees only their statement; any other page/API is refused
- [ ] `./kanakku.sh test` passes on the server

**Automations**
- [ ] Razorpay test payment with note `invoice` = an invoice number marks it paid; repeat webhook is ignored
- [ ] n8n reminder sends once and not again for 3 days
- [ ] Monday brief reaches admin numbers; investor statement reaches the investor on the 5th
