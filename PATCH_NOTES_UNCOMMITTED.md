## Patch Notes (Uncommitted) — ECS0 (Backend)

These notes explain the **current uncommitted changes** in simple terms (for non‑technical readers).

### What changed in this update

- **Fair “pool split” targets for personal dashboards**
  - If someone has a **personal monthly target**, dashboards use that.
  - If they **don’t** have a personal target, the system now:
    - takes the branch monthly target,
    - subtracts the sum of all personal targets already set in that branch,
    - then **splits the remaining amount equally** across active branch users who don’t have a personal target.
  - The API now returns extra fields to explain the math (remaining pool, how many users are unset, and the allocated target).

- **Branch performance overview is more complete**
  - Branch overviews now include **all configured branches**, even if they had **zero receipts** in the selected period.
  - Branch stats now also include **total of personal targets** per branch (and grand total across branches), for reporting.

- **Employee performance reports include “zero activity” users (when filtering by branch)**
  - When a branch is selected, the employee performance report returns **all active users in that branch**, even if they had **0 receipts** in the period.
  - Each user row includes their **effective target** (personal target if set, otherwise allocated from pool).

- **Managers can manage personal targets (with safety rules)**
  - Managers can view users in **their own branch** and update **only** the personal monthly target.
  - Personal targets are capped so the **sum of personal targets cannot exceed** the branch monthly target (prevents impossible targets).

- **NCD filtering works even when stored under Bond**
  - When filtering by “NCD”, the backend now correctly includes:
    - receipts stored as NCD, and
    - receipts stored as Bond where the issuer type is NCD.
