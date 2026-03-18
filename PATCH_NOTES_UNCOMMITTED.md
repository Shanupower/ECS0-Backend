### Uncommitted changes – Backend (ECS0-Backend)

**Scope:** New branch utilities, NCD/Bond schema & export, receipt nesting and stats, FD/insurance/misc fixes, and migration/verification scripts.

- **Branch utilities & normalization** (`config/database.js`)
  - Added `getBranchIdentifiersForFilter` to resolve a branch (key, code, or name) into a canonical list of identifiers for filtering receipts and customers consistently.
  - Added `getCanonicalBranchKey` to map any branch representation (code/name) back to `branches._key`, with a fallback using `normalizeBranchName`.
  - Extended `normalizeBranchName` with aliases (e.g. Yapral → SAINIKPURI, WFH KALPANA → Thirumullaivoyal, CHANDA NAGAR → CHANDANAGAR) to better match messy real‑world branch labels.

- **Core stats and receipts alignment** (`routes/stats.js`, `routes/receipts.js`, `routes/branches.js`, `routes/export.js`)
  - Updated all stats endpoints (summary, by-category, by-day, monthly-cc-si, branches, employees, investor-locations) to:
    - Use the new `INV_AMOUNT_AQL`, `CC_AQL`, `SI_AQL` helpers so investment amount, CC, and SI are computed from the nested receipt tree first, then legacy flat fields.
    - Respect branch access using `getBranchIdentifiersForFilter` so managers/branch users and admins see identical branch-scoped data in list and dashboard views.
    - Add `includePending` support so widgets can optionally include `Pending` and legacy null-status receipts alongside `Completed`.
  - Normalized receipt list and employee-/branch-scoped endpoints so:
    - Filtering by category uses `receipt.product.category` when available, else `receipt.product_category`.
    - Date filters, branch filters, and employee filters match the same semantics across list, summary, and dashboard.
  - Ensured single-receipt fetch and soft delete/restore work against the nested shape while still returning flat aliases for existing consumers (view page, exports, etc.).

- **Nested receipt model & creation** (`routes/receipts.js`, `routes/receipt-drafts.js`, `routes/users.js`)
  - Implemented a single nested receipt document shape:
    - `employee` (code/name/branch), `investor` (ID/name/address/PAN/contact),
    - `product` (category/name/option/folio),
    - `transaction` (type/mode/amount/period/installments and SIP/SWP/STP/switch data),
    - `product_details` for MF, FD, INS, MISC, and BOND/NCD subtrees,
    - `payment` (instrument, bank, entry_mode, channel, reference_no, notes),
    - `calculations` (CC/SI and legacy aliases).
  - Receipt creation now:
    - Validates by product category (MF/FD/INS/BOND/MISC), supports `{{today}}` placeholders, and calculates CC/SI from schemes when not supplied.
    - Builds the nested tree and only then backfills flat fields for backward compatibility (list, export, PDF).
  - Added helpers to normalize legacy receipts into the nested form on read (`withNormalizedDetails`), and to strip SI for non-admin users.
  - Receipt drafts and user-related aggregations were updated to work with the new structure without breaking existing flows.

- **NCD/Bond issuer & scheme management** (`routes/ncd-bonds-schemes.js`)
  - Kept the `ncd_bond_issuers` collection with nested `schemes[]`, but extended per-scheme fields to support the Bond Universe hierarchy and maturity details:
    - New scheme field `instrument_type` (main family: `BOND`, `NCD`, or `GOVT`).
    - Existing `category` and `sub_category` now represent Level 2 (issuer/security type) and Level 3 (product type).
    - Optional `maturity_method` and `maturity_notes` for human-readable maturity logic (from the purple column in the spec).
  - Extended `validateBusinessRules`:
    - Validates `instrument_type` against `['BOND','NCD']` when present.
    - Centralized allowed interest payment frequencies and reuses them for scheme validation.
    - Preserved ISIN/date/coupon/face_value checks.
  - Reworked Excel export for NCD/Bond schemes:
    - Each row now includes:
      - `instrument_type`, `issuer_security_type` (from `category`), `product_type` (from `sub_category`),
      - `maturity_method`, `maturity_notes`,
      - plus existing issuer/scheme/ISIN/coupon/face/issue/maturity/listing/rating/min_investment/frequency/security/options/currency/issue_size/active/CC/SI.
    - New columns added *after* issuer metadata and before the existing CC/SI columns so current import logic remains aligned.
  - Import-from-Excel remains focused on the prior field set (description, rate, dates, listing, rating, min_investment, frequency, security flags, currency, issue_size, CC/SI) and ignores new hierarchy/maturity columns, making them effectively export-only until a round-trip mapping is needed.

- **FD & insurance schemes** (`routes/fd-schemes.js`, `routes/insurance-schemes.js`)
  - FD issuers/schemes:
    - Added and wired `rate_slabs` with CC/SI at slab level, with fallbacks to scheme-level CC/SI.
    - Enhanced validations around tenure ranges, payout frequency, and active flags.
    - Export/import flows extended to handle the richer FD slab model without breaking existing FD booking.
  - Insurance issuers/products:
    - Introduced `ppt_slabs` (premium payment term slabs) with CC/SI and mapped them in receipt CC/SI calculation.
    - Ensured Life/Health products carry richer coverage/tax metadata while preserving the legacy `products[]` shape.

- **Leads, customers, branches, users** (`routes/leads.js`, `routes/customers.js`, `routes/branches.js`, `routes/users.js`)
  - Harmonized branch-based filtering using `getBranchIdentifiersForFilter` and `getCanonicalBranchKey` across:
    - Customer lists and relationship manager views.
    - Branch dashboards and lead/issue ownership.
  - Tightened access rules for employees/managers/branch users vs admins so list and dashboard scope match.

- **Misc and export** (`routes/misc-services.js`, `routes/export.js`, `routes/stats.js`)
  - Misc services:
    - Implemented `price_ranges` with CC/SI per range and wired them into CC/SI calculation at receipt creation.
  - Exports:
    - Updated mutual-fund, FD, insurance, NCD/Bond, and misc exports to read from the nested structures first and fall back to legacy fields.
    - Ensured sheet names and headers avoid Excel’s reserved characters.

- **Migration and verification scripts** (`scripts/*.js`)
  - Added multiple scripts to migrate and verify data:
    - `migrate-receipts-legacy-to-nested.js` – transforms legacy receipts into the new nested structure, with careful backfills of MF/FD/INS fields.
    - `migrate-branches.js`, `branch-customer-counts.js`, `normalize-receipt-branches.js` – rationalize branch codes/names and counts across receipts and customers.
    - `migrate-amcs-amc-category.js`, `sync-fd-slab-cc-si.js` – normalize AMC categories and sync FD CC/SI from slabs.
    - `verify-dashboard-stats.js`, `verify-dashboard-totals.js`, `fix-receipt-product-category.js` – cross-check and correct stats and product categories against the new model.

---

### Uncommitted changes – Frontend (ECS0)

**Scope:** New receipt experience (multi-step), NCD/Bond + Govt schemes alignment, dashboards, UI kit, theming, validation, and TypeScript config.

- **Core app & API** (`src/App.jsx`, `src/api.js`, `src/utils/validators.js`)
  - Introduced a redesigned receipt creation flow (multi-step wizard) and wired it into routing.
  - Added rich, typed API helpers for:
    - Receipts (list, create, duplicate-check, drafts),
    - Stats (summary, by-category, by-day, monthly CC/SI, branches, employees, investor locations),
    - Scheme management for MF/FD/INS/NCD-Bond/Misc services.
  - Extended validators to support the new nested receipt shape (dates, amounts, IDs, product categories).

- **New shared UI kit** (`src/components/ui/*`, `src/styles.css`, `tailwind.config.js`)
  - Added a small component library (Button, Card, Table, Input, Select, Switch, SegmentedControl, Toast, Skeleton, Drawer, etc.) with theme-aware styling.
  - Centralized design tokens and Tailwind config to support light/dark modes and dashboard-specific theming.

- **Multi-step receipt wizard** (`src/components/MultiStepReceipt.jsx`, `src/components/receipt-steps/*`, `src/pages/CreateReceipt.tsx`)
  - Implemented a 7-step multi-step receipt wizard:
    - Employee → Investor → Product Type → Issuer/Scheme → Investment Type/Details → Final review → Preview.
  - Added dedicated steps per product type:
    - MF: AMC and scheme pickers, investment type, SIP/SWP/STP/switch capture.
    - FD + Govt FD: issuer/scheme pickers, rate-slab-driven FD details (booking date, tenure, payout frequency, maturity).
    - Insurance: issuer/product selection, policy, PPT/riders, coverage, premium capture.
    - NCD/Bond: issuer, scheme, and transaction details wired to the backend NCD/Bond routes.
    - MISC: misc services with price/CC/SI logic.
  - Added preset support (per-employee/per-branch) so users can quickly reuse common receipt configurations, gated by product type (MF/FD/BOND/INS/MISC).
  - Implemented duplicate-check handling against the backend before creation and a failure-report path (with optional screenshot capture) when saves fail.

- **NCD/Bond flow integration** (`src/components/receipt-steps/StepNCDBondIssuer.jsx`, `StepNCDBondScheme.jsx`, `StepNCDBondDetails.jsx`, `src/components/MultiStepReceipt.jsx`)
  - Issuer selection:
    - `StepNCDBondIssuer` lists active NCD/Bond issuers from the backend, with search and “recent issuers” shortcuts.
  - Scheme selection:
    - `StepNCDBondScheme` loads NCD/Bond schemes for the selected issuer and shows:
      - Scheme name, `category` (issuer/security type), `sub_category` (product type), description, ISIN, coupon, face value, tenure, listing, rating.
    - Respects the new backend hierarchy by reading `category` and `sub_category` and reflecting them in the UI.
  - Transaction details:
    - `StepNCDBondDetails` collects transaction type (Purchase/Redemption), units, amount, dates, application number, and Form 15G/15H.
    - Builds `bondData` including:
      - `bond_issuer_key`, `bond_issuer_name`, `bond_issuer_type`,
      - `bond_scheme_id`, `bond_scheme_name`, `bond_category`, `bond_sub_category`,
      - ISIN, coupon, face value, issue/maturity dates, units, amount, application, 15G/15H.
    - `buildNCDBondReceipt` in `MultiStepReceipt.jsx` converts this into the final payload with:
      - `product_category: 'BOND'`,
      - flat bond fields expected by `routes/receipts.js` so the backend can populate `product_details.bond` inside the nested receipt tree.

- **Government schemes tab in receipt creation** (`src/components/receipt-steps/StepProductType.jsx`, `StepFDIssuer.jsx`, `StepFDDetails.jsx`, `src/components/MultiStepReceipt.jsx`)
  - Added `GOVT_FD` as a first-class product type label (“Government schemes”).
  - Reused the FD issuer/scheme components with `governmentOnly` filter:
    - `StepFDIssuer` filters issuers to type `Government(Post Office)` when in GOVT_FD mode.
    - `StepFDDetails` uses `isGovtScheme` to adjust copy and validations; FD booking/maturity logic is reused.
  - The GOVT_FD branch in `MultiStepReceipt`:
    - Produces `product_category: 'GOVT_FD'`,
    - Maps FD issuer/scheme/amount into the payload so `routes/receipts.js` stores it under `product_details.fd`,
    - Keeps the GOVT_FD receipts visible as a separate category in stats and dashboards.

- **Receipt viewing & transactions** (`src/pages/ReceiptViewPage.jsx`, `src/pages/ReceiptsPage.jsx`, `src/pages/TransactionsPage.jsx`)
  - `ReceiptViewPage`:
    - Updated to read from the normalized nested receipt structure returned by the backend.
    - Added a dedicated “Bond / NCD Details” section triggered when `product_category` is `BOND` or `NCD`, showing issuer, scheme, ISIN, coupon, dates, and amounts.
  - `ReceiptsPage` and `TransactionsPage`:
    - Use the backend’s normalized `product_category` and nested fields to display consistent receipt lists.
    - Category filters include `BOND` and `GOVT_FD`, matching the backend stats category codes.

- **Dashboards & stats alignment** (`src/pages/DashboardPage.jsx`, `src/pages/BranchDashboard.jsx`, `src/components/CSVExport.jsx`)
  - `DashboardPage`:
    - Uses backend stats endpoints (summary, by-category, by-day, monthly-cc-si, branch stats, employee performance, investor locations) which now derive amounts from the nested receipt tree.
    - Normalizes category labels via `CATEGORY_LABELS`:
      - `BOND: 'BOND'`, `NCD: 'Bonds/NCD'`, `GOVT_FD: 'Govt FD'`, etc., so charts and widgets stay human-readable.
    - Adds target vs actual bars for personal and branch targets using user/branch targets from the backend.
  - `BranchDashboard`:
    - Maps `BOND` neatly to “Bonds” in branch-level overviews, while respecting all other category codes.
  - CSV export:
    - Surfaced a dashboard CSV export component that queries backend export endpoints (MF/FD/INS/NCD-Bond/Misc), which now include hierarchy/maturity fields for NCD/Bonds.

- **Layout & theming improvements** (`src/components/Layout.jsx`, `src/components/DarkModeToggle.jsx`, `src/components/DashboardLayout.jsx`, `src/index.css`, `src/theme/theme.css`)
  - Implemented a consistent, modern dashboard layout with:
    - Responsive navigation, header, and content containers.
    - Dark mode toggle with persisted preference stored client-side.
    - Updated typography, spacing, and color tokens to match the new UI kit.

- **TypeScript, configs, and misc** (`tsconfig.json`, `tsconfig.node.json`, `src/hooks/useReceiptForm.ts`, new `create-receipt` components)
  - Added base TS config and node TS config for new TS components (`CreateReceipt.tsx`, `useReceiptForm.ts`).
  - Introduced a typed hook for managing the receipt form state and validation across steps.
  - Scaffolding for a new `create-receipt` component set that sits on top of the multi-step flow and uses the shared UI kit.

