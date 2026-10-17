# WhatsApp templates to create in Meta Business Manager

Create these under **WhatsApp Manager → Message templates** on the Afra Ventures WhatsApp Business account.
Language: **English (en)**. Category: **Utility**. Names must match exactly — the n8n workflows use them.

## 1. `afv_payment_reminder` (used by 01_dues_reminders)
Body:
```
Hello {{1}}, this is a gentle reminder that ₹{{2}} is due to {{3}} for {{4}} (due date {{5}}). Please ignore if already paid. Thank you — Afra Ventures
```
Sample values: Ravi · 25,800 · BM TechX · invoice AFV/TX/INV/2627/0007 · 2026-10-21

## 2. `afv_weekly_brief` (used by 02_weekly_cfo_brief)
Body:
```
Hi {{1}}, your weekly Kanakku money brief: {{2}}
```
Sample values: Kamar · In ₹1,83,000 | Out ₹31,300 | Net ₹1,51,700

## 3. `afv_investor_statement` (used by 03_investor_statements)
Body:
```
Dear {{1}}, Afra Ventures profit statement for {{2}}: pooled brands net profit ₹{{3}}; your share ₹{{4}}. Total accrued and unpaid so far: ₹{{5}}. For questions reply to this message.
```
Sample values: Investor · 2026-10 · 1,71,000 · 23,940 · 36,540

Template variables cannot contain new lines, tabs or more than 4 spaces in a row — the workflows already flatten text.
