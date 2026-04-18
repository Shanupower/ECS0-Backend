## Patch Notes (Uncommitted) — ECS0 (Backend)

These notes explain the **current uncommitted changes** in simple terms (for non‑technical readers).

### What changed in this update

- **FD interest rate matching is more reliable**
  - When calculating the FD rate, **payout frequency** is compared in a forgiving way (for example, small differences in spelling or capital letters no longer block a match).
  - A rate slab is treated as **available** unless it is explicitly marked inactive—so “missing” active flags behave the same as on the booking screen.

- **Cleaner internal handling of tenure units**
  - **Days vs months** for FD tenure is handled in one consistent place on the server, so behaviour stays aligned across validation and rate calculation.
