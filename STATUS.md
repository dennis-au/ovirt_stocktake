# ovirt-inventory Revamp Status

## Current Focus

Executing `PLAN.md` milestone by milestone for the revamp described in `PROMPT.md`.

Current focus: all revamp milestones in `PLAN.md` are complete. Lab acceptance passed with redacted evidence on August 12, 2026.

## Milestone 0: Baseline And Architecture Alignment

Status: complete.

Completed:

- Captured current app behavior, backend API routes, SQLite schema, and automated test coverage in `IMPLEMENT.md`.
- Recorded the target architecture: React/Vite frontend, Node/Fastify API, backend collectors/workers using official oVirt REST APIs or the official Python SDK, PostgreSQL normalized inventory, separate metrics backend, encrypted credentials, and Docker Buildx multiarch builds.
- Documented the migration strategy from SQLite snapshot storage to PostgreSQL normalized current inventory and immutable history.
- Added revamp target environment variables to `.env.example` for PostgreSQL, metrics backend, collection cadences, and daily full snapshot timing.

Validation:

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 7 files and 44 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- No lab credentials, tokens, or authorization headers were added to docs or config.
- Docker Buildx completed with the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 1: PostgreSQL Inventory Schema

Status: complete.

Completed:

- Add PostgreSQL migrations for normalized current inventory, immutable history/change events, audit logs, saved views, and exports.
- Added a PostgreSQL migration runner with tracked `schema_migrations`.
- Added normalized tables for managers, collection runs, data centers, clusters, hosts, storage domains, logical networks, vNIC profiles, VMs, VM ownership metadata, NICs, disks, VM snapshots, tags, VM tags, affinity data, events, inventory history, resource change events, audit logs, saved views, and exports.
- Added operational indexes for manager, status, placement, storage, network, ownership, application, environment, criticality, cost center, tags, last seen, health score, events, history, saved views, audit logs, and exports.
- Added repository support to replace current VM inventory idempotently for a manager while preserving immutable `inventory_history`.
- Added PostgreSQL schema/repository tests with a PostgreSQL-compatible in-memory engine.

Validation:

- `npm test -- tests/postgres-schema.test.ts`: passed, 3 tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed after fixing TypeScript query/client typings.
- `npm test`: passed, 8 files and 47 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Existing SQLite runtime behavior remains in place during the migration period.
- Added `pg` as a runtime dependency and `pg-mem`/`@types/pg` for schema validation tests.
- No secrets were added.

## Milestone 2: Secure Managers, RBAC, And Audit

Status: complete.

Completed:

- Added admin/operator/viewer session roles and role-based route guards.
- Restricted manager administration to admins while allowing operators to run collection and viewers to read inventory surfaces.
- Added SQLite `audit_logs` persistence and queryable admin-only `/api/audit-logs`.
- Added audit records for login success/failure, logout, manager create/update/delete, collection runs, bulk collection, snapshot saves, Excel exports, and denied authorization attempts.
- Kept oVirt Manager credentials encrypted at rest and out of manager responses, collection responses, audit metadata, snapshot validation, and Excel exports.
- Added RBAC-aware redaction for governance/cost/security exposure fields in snapshot detail responses and Excel exports.

Validation:

- `npm test -- tests/rbac-audit.test.ts`: passed, 8 tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 9 files and 55 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Saved-view mutation audit hooks will attach to the saved-view endpoints when Milestone 5 adds those routes; the audit storage and redaction path are ready now.
- Docker Buildx completed with the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 3: oVirt Inventory Sync Collector

Status: complete.

Completed:

- Expanded backend-side read-only oVirt REST collection to data centers, clusters, hosts, VMs, storage domains, disks, logical networks, vNIC profiles, tags, VM snapshots, affinity groups, and events.
- Kept all oVirt API calls server-side; browser requests still call only `ovirt-inventory`.
- Added VM and cluster child collection for VM snapshots and affinity groups, while preserving pagination and partial-failure behavior.
- Added guest-agent missing-data warnings for running VMs without guest-agent evidence.
- Added `snapshotToInventorySyncInput` normalization into the PostgreSQL inventory model.
- Wired optional PostgreSQL inventory persistence for successful/partial manual collection while preserving existing SQLite snapshot history.
- Added runtime PostgreSQL pool initialization and migrations behind `OVIRT_INVENTORY_DATABASE_URL`.
- Added configurable scheduled backend collection with `OVIRT_INVENTORY_COLLECTOR_ENABLED` and cadence variables; default remains disabled.

Validation:

- `npm test -- tests/collector.test.ts tests/ovirt-normalize.test.ts tests/postgres-schema.test.ts tests/scheduler.test.ts tests/health.test.ts`: passed, 27 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 11 files and 72 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Optional PostgreSQL normalization failures are audited as `inventory.normalization_failed` and do not erase the saved SQLite snapshot.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 4: Governance Metadata And Health Score

Status: complete.

Completed:

- Added governance policy evaluation and transparent VM health-score computation.
- Added evidence-linked health deductions with codes, points, evidence payloads, and recommended actions.
- Enforced production VM metadata checks for owner, environment, application, and criticality.
- Added exception policies for missing metadata, stale or unavailable guest agent, unknown IP, missing/failed backup, RPO breach, unsupported OS, public exposure, critical vulnerabilities, idle/retirement candidates, and snapshot age thresholds over 3, 7, and 30 days.
- Extracted governance metadata from oVirt VM custom properties and tags during normalization.
- Stored computed `health_score` and `health_deductions` in PostgreSQL current VM inventory.

Validation:

- `npm test -- tests/governance.test.ts tests/ovirt-normalize.test.ts tests/postgres-schema.test.ts tests/collector.test.ts`: passed, 20 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 12 files and 75 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Health deductions are available in normalized PostgreSQL inventory first; user-facing list/detail rendering is handled by later milestones.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 5: Inventory List, Filters, Saved Views

Status: complete.

Completed:

- Added PostgreSQL-backed `GET /api/inventory/vms` with server-side pagination, filters, selected columns, RBAC redaction, and default VM inventory columns.
- Added filters for manager, datacenter, cluster, host, storage domain, logical network, vNIC profile, status, HA, environment, owner, application, criticality, cost center, tag, OS, guest agent, backup status, RPO breach, snapshot age, created/last-seen dates, lifecycle status, missing metadata, missing backup, unknown IP, and idle/retirement candidates.
- Added `GET /api/exports/inventory?format=json|csv|excel` for filtered inventory exports.
- Added SQLite-backed saved views at `/api/saved-views` with create/list/update/delete, column/filter/sort state, shared/private visibility, and audit records.
- Preserved secret redaction in inventory responses and exports.

Validation:

- `npm test -- tests/inventory.test.ts`: passed, 9 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 13 files and 84 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- CPU P95 and RAM P95 columns are present as nullable placeholders until Milestone 8 wires the metrics backend.
- Inventory deep links are represented by query parameters; frontend route integration follows with the detail/dashboard UI milestones.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 6: VM Detail Page

Status: complete.

Completed:

- Added `GET /api/inventory/vms/:managerId/:vmId` for VM detail routing from list/drill-down/search links.
- Returned structured detail tabs for Overview, Performance, Storage and snapshots, Network, Backup and DR, and Events and audit.
- Included identity, ownership, status, placement, OS, IPs, health score, disks, snapshots, NICs, backup posture, events, inventory history, and ticket/governance fields.
- Added per-tab freshness values with metrics placeholders marked unavailable until the metrics milestone.
- Applied RBAC redaction to sensitive governance, cost, exposure, and vulnerability fields.
- Avoided raw JSON in the detail response.

Validation:

- `npm test -- tests/inventory.test.ts`: passed, 11 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 13 files and 86 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- The detail API is ready for frontend route wiring; current tests validate the backend contract and RBAC behavior.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 7: Operational Dashboard And Charts

Status: complete.

Completed:

- Added PostgreSQL-backed `GET /api/dashboard/operational`.
- Added KPI objects with drill-down `href` values into filtered `/api/inventory/vms` lists.
- Added KPIs for total VMs, production VMs, missing metadata, HA unavailable, guest-agent issues, backup exceptions, RPO breaches, snapshot age thresholds, idle/retirement candidates, and availability events.
- Added chart-ready datasets for VM status by cluster, storage capacity, backup compliance, snapshot risk, availability events, and admin-only cost attribution.
- Added capacity placeholders that explicitly mark CPU/RAM P95 unavailable until metrics are wired.
- Added per-manager freshness/last collection status with warning and error counts.

Validation:

- `npm test -- tests/inventory.test.ts`: passed, 12 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 13 files and 87 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Chart rendering in the React UI can consume the new operational dashboard contract; the existing snapshot dashboard remains unchanged for compatibility.
- CPU/RAM P95 remain unavailable by design until Milestone 8 introduces a metrics backend.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 8: Metrics Pipeline

Status: complete.

Completed:

- Added metrics backend configuration for `none`, `postgres`, `timescale`, `timescaledb`, `prometheus`, `victoriametrics`, and `grafana`.
- Added separate PostgreSQL/Timescale-compatible `metric_samples` time-series table and index.
- Added metric sample ingestion/upsert repository support for VM, host, cluster, and storage-domain metrics.
- Added VM metric summary queries for CPU P95, memory P95, disk IOPS P95, network Mbps P95, availability, and rightsizing.
- Added `GET /api/metrics/vms/:managerId/:vmId` with unavailable-state behavior when no metrics are present or no PostgreSQL store is configured.
- Kept metrics storage separate from current inventory tables.

Validation:

- `npm test -- tests/metrics.test.ts tests/postgres-schema.test.ts`: passed, 10 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 files and 94 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- External Prometheus/Grafana/VictoriaMetrics adapters share the config boundary but are not contacted during tests.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 9: Backup, DR, Security, And Lifecycle

Status: complete.

Completed:

- Confirmed backup/DR, security, lifecycle, and cost fields are stored in normalized PostgreSQL inventory and extracted from VM custom properties.
- Added `/api/exceptions` for backup non-compliance, RPO breaches, restore-test gaps, unsupported OS, critical vulnerabilities, public exposure, retirement candidates, and snapshot risk.
- Added `/api/integrations/status` placeholders for Commvault, CMDB, ticketing, and showback/chargeback, explicitly marked unavailable.
- Fed backup/security/lifecycle risk into health scores, operational dashboard KPIs, inventory filters, VM detail, exception views, and exports.
- Applied RBAC redaction to sensitive exception evidence.

Validation:

- `npm test -- tests/inventory.test.ts`: passed, 14 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 files and 96 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.

Notes:

- Integration placeholders are explicit unavailable states; they do not silently return empty backup/CMDB/ticketing/showback data.
- Docker Buildx reported the expected cache-only warning because no `--push` or `--load` output was requested.

## Milestone 10: Exports, API, And Lab Acceptance

Status: complete.

Completed:

- Documented the implemented API endpoints and export surfaces in `IMPLEMENT.md`.
- Added `GET /api/collection-runs` and `GET /api/collection-runs/:id` for PostgreSQL collection run summaries and details.
- Added `GET /api/exports/snapshot?format=json|csv|excel&snapshotId=...` while keeping the existing `GET /api/exports/excel?snapshotId=...` route.
- Added `GET /api/exports/exceptions?format=json|csv|excel&type=...`.
- Added `GET /api/exports/vm-detail?format=json|csv|excel&managerId=...&vmId=...` for tab/freshness/health evidence export.
- Added focused API/export tests for collection runs, selected snapshot JSON/CSV export, exception export, and VM detail evidence export.
- Preserved RBAC redaction and secret-free audit metadata for new export routes.

Validation:

- `npm test -- tests/inventory.test.ts tests/excel.test.ts`: passed, 2 files and 24 focused tests.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed, 14 files and 99 tests.
- `npm run build`: passed.
- `docker buildx build --platform linux/amd64,linux/arm64 .`: passed using Docker Desktop Buildx.
- In-app Browser smoke against a temporary local server: passed. Confirmed app login, dashboard, managers, snapshot history, system status, and empty-state UI.

Lab acceptance:

- `https://lab111/ovirt-engine/api` was reachable and returned HTTP 401 without credentials, which confirms the API endpoint responds.
- Manual lab collection succeeded with the corrected authentication profile supplied out of band.
- Redacted collector result: status `success`, API version `4.8`, 0 warnings, 0 errors.
- Redacted lab resource counts: 1 data center, 1 cluster, 0 hosts, 0 VMs, 1 storage domain, 0 disks, 1 network, 1 vNIC profile, 1 tag, 0 VM snapshots, 0 affinity groups, and 446 events in the full app-flow smoke.
- Full app-flow smoke passed in memory: app login, encrypted manager create, manual backend collection, snapshot history, legacy dashboard, operational dashboard, VM inventory list, collection-run list, and Excel snapshot export.
- No username, password, token, authorization header, password-grant body, `.env` file, repository database, or generated export was written to the repository.

Browser validation:

- In-app Browser smoke passed against a temporary local server on port 3311.
- Browser smoke used only test app login credentials and did not enter lab oVirt credentials in the browser.
- Live lab VM detail could not be exercised because the lab inventory currently returned 0 VMs; seeded automated tests cover VM detail tabs and evidence export.

Notes:

- Docker Buildx completed with the expected cache-only warning because no `--push` or `--load` output was requested.
- The Docker build's production `npm prune --omit=dev` step reported two moderate npm audit warnings; the build still exited successfully. No force upgrade was applied during this milestone.
