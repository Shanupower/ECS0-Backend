# What’s New – Update for Everyone

This note is for staff and managers (non-technical). It describes recent improvements in plain language.

---

## Receipts

### SIP: “Daily” frequency option
When you create a **SIP (Systematic Investment Plan)** receipt, you can now choose **Daily** as the investment frequency (in addition to Weekly, Monthly, Quarterly, and Annual). Use the same “Frequency” dropdown; no other steps change.

### New receipt creation flow
- Receipt entry is now a **step-by-step wizard**: choose employee, investor, product type, scheme, investment details, then review and save.
- **Product types** are clearly separated: Mutual Funds, FD, Government schemes, Insurance, NCD/Bond, and Misc services. Each type has its own screens and validations.
- **Government schemes** are a dedicated option (e.g. Post Office) with the same ease of use as regular FD.
- **Bonds / NCD**: you can select issuer and scheme, enter transaction type (Purchase/Redemption), units, amount, and application details (including Form 15G/15H where applicable).
- **Presets**: you can reuse recent or saved configurations per employee or branch to speed up repeat entries.
- The system checks for **duplicate receipts** before saving and lets you report issues (with optional screenshot) if something goes wrong.

### How receipts are stored
- Receipts now use a **unified structure** (employee, investor, product, transaction, payment, calculations). Old receipts continue to work; the app can read both old and new formats.
- **Commission (CC/SI)** is calculated from scheme or slab data when possible, and is shown correctly in lists, dashboards, and exports.

---

## Branches and access

- **Branch names** are normalized (e.g. alternate names like “Yapral” map to the correct branch) so reports and filters stay consistent.
- **Managers and branch users** see the same branch-scoped data in lists and dashboards as admins see for that branch; access rules are aligned everywhere.
- **Customer and lead lists** respect branch and relationship-manager filters in the same way across the app.

---

## Schemes and products

### NCD/Bond schemes
- NCD/Bond schemes support **instrument type** (Bond, NCD, Govt), **issuer/security type**, and **product type** for clearer reporting.
- **Maturity** can be described with optional notes. Excel export includes these new columns; existing imports still work.

### FD and Insurance
- **FD**: rate slabs can carry their own CC/SI; validations for tenure, payout frequency, and active flags are improved.
- **Insurance**: premium payment term (PPT) slabs with CC/SI are supported; life and health products keep coverage and tax-related metadata.

### Misc services
- Misc services support **price ranges** with CC/SI per range, used in receipt calculations.

---

## Dashboards and reports

- **Main dashboard** uses the new receipt structure for totals, category breakdowns, and time-based views. Categories include Mutual Funds, FD, Govt FD, Insurance, Bonds/NCD, and Misc.
- **Branch dashboard** shows the same categories and branch-level totals in a consistent way.
- **Target vs actual** (personal and branch) is available where targets are configured.
- **CSV/Excel export** for receipts uses the updated data and includes the new NCD/Bond and category fields where relevant.

---

## Look and feel

- **Layout**: navigation, header, and content areas are consistent and work on different screen sizes.
- **Dark mode**: you can switch between light and dark theme; the choice is remembered.
- **New UI components** (buttons, cards, tables, inputs, etc.) are used across the app for a consistent, modern look.

---

## Data and system health

- **Migration scripts** are available to move old receipts into the new structure, align branch codes, fix product categories, and sync FD/AMC data. These are run by an administrator when needed.
- **Verification scripts** check that dashboard totals and stats match the database; they are used for audits and after migrations.
- A **recheck and regenerate** script can run these checks and regenerate all receipt PDFs, then push updates. See `scripts/recheck-db-regenerate-pdfs-push.sh`.

---

*Full technical details (files, APIs, and implementation notes) are in `PATCH_NOTES_UNCOMMITTED.md`.*
