# TODO

## Resolve the ExcelJS `uuid` security advisory

- **Status:** Open
- **Detected:** August 14, 2026
- **Severity:** Moderate
- **Affected dependency:** `uuid` versions earlier than `11.1.1`, pulled in through `exceljs`.

`npm audit` reports a missing buffer-bounds check when UUID v3, v5, or v6 functions receive a caller-provided buffer. The application uses `exceljs` for Excel exports; the advisory was already present before the Docker Compose deployment work.

Do not run `npm audit fix --force` automatically. The proposed remediation changes the `exceljs` version in a potentially breaking way and could affect Excel export behavior.

Before closing this item:

1. Identify an `exceljs` upgrade path that removes the vulnerable `uuid` dependency without an incompatible downgrade.
2. Run the Excel export tests and manually verify CSV, JSON, and Excel exports still work.
3. Re-run `npm audit --audit-level=moderate` and record the result in the release validation notes.
