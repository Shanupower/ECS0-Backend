## Patch Notes (Uncommitted) — ECS0 (Backend)

These notes explain the **current uncommitted changes** in simple terms (for non‑technical readers).

### What changed

- **New “Date basis” option for reports**
  - Dashboards and lists can now calculate totals using either:
    - **Receipt date** (the date on the receipt), or
    - **Transaction date** (cheque/date of payment when available, otherwise it falls back safely).
  - This affects branch stats, global stats, and transaction/receipt lists.

- **Fixed Deposit tenure now supports “Days” as well as “Months”**
  - FD rate slabs can be defined using **days** (example: 7–14 days) or **months** (example: 12–24 months).
  - Rate calculation now matches the slab based on the selected unit (days vs months).
  - The FD rate slab Excel export/import has been updated to include the tenure unit and the correct min/max fields for that unit.

- **Receipt PDF improvements**
  - Product labels are clearer (Bond vs NCD are shown separately).
  - Mutual Fund receipts can display special AMC categories like **SIF / PMS / AIF / Gift City Funds** when applicable.
  - For Government Schemes where the issuer is Post Office, the PDF shows **“Post Office”**.
  - FD receipts can show tenure properly for **days** or **months**.
  - “Employee Details” is moved to the end of the PDF, after the payment section.

- **User management improvements (Admin)**
  - Users now include:
    - **Phone number**
    - **Personal monthly target**
  - Admins get tools to:
    - **Audit branch mapping** (find users missing branch details or mapped incorrectly)
    - **Fix missing branch codes** (optional “dry run” supported)
  - Creating/updating users now validates branch mapping more strictly (prevents wrong/blank branch assignments for roles that require a branch).

- **Fixed a few data consistency issues**
  - FD receipts created/edited now keep deposit amounts and category detection consistent even when the receipt uses the newer nested data shape.
