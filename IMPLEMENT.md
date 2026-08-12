# ovirt-inventory Implementation Notes

## Current Baseline

The current implementation is a React, TypeScript, and Vite frontend served by a Node/Fastify API. The API currently uses SQLite through `better-sqlite3`.

Implemented user behavior:

- app login, logout, and session refresh;
- manager registry with encrypted oVirt Manager username/password storage;
- authenticated manual collection for one Manager or all enabled Managers;
- backend-side oVirt collection through official REST endpoints;
- snapshot persistence and history;
- dashboard totals and per-manager freshness;
- Excel export for latest or selected snapshots.

Implemented backend API:

- `GET /api/health`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/session`
- `GET /api/managers`
- `POST /api/managers`
- `PATCH /api/managers/:id`
- `DELETE /api/managers/:id`
- `POST /api/managers/:id/collect`
- `POST /api/collect`
- `GET /api/collection-runs`
- `GET /api/collection-runs/:id`
- `POST /api/snapshots`
- `GET /api/snapshots`
- `GET /api/snapshots/latest`
- `GET /api/snapshots/:id`
- `GET /api/dashboard`
- `GET /api/exports/excel?snapshotId=...`
- `GET /api/exports/snapshot?format=json|csv|excel&snapshotId=...`
- `GET /api/audit-logs`
- `GET /api/inventory/vms`
- `GET /api/inventory/vms/:managerId/:vmId`
- `GET /api/dashboard/operational`
- `GET /api/exports/inventory?format=json|csv|excel`
- `GET /api/exports/vm-detail?format=json|csv|excel&managerId=...&vmId=...`
- `GET /api/metrics/vms/:managerId/:vmId`
- `GET /api/exceptions`
- `GET /api/exports/exceptions?format=json|csv|excel&type=...`
- `GET /api/integrations/status`
- `GET /api/saved-views`
- `POST /api/saved-views`
- `PATCH /api/saved-views/:id`
- `DELETE /api/saved-views/:id`

Current SQLite schema:

- `app_metadata`: schema version metadata.
- `app_sessions`: hashed app session tokens, role, and expiry.
- `managers`: Manager name, URL, enabled flag, encrypted username, encrypted password, and timestamps.
- `snapshots`: immutable collected snapshot payloads, resource JSON, warnings, errors, collection status, duration, and timestamps.
- `audit_logs`: sanitized audit records for auth, authorization, manager changes, collection, exports, saved views, and normalization failures.
- `saved_views`: saved filter/column/sort state for inventory views.

Current automated coverage:

- health/database metadata;
- app auth and protected endpoints;
- manager CRUD and credential redaction;
- credential encryption/decryption;
- backend oVirt REST collector normalization, pagination, auth/network error handling, and read-only method checks;
- snapshot validation, save/list/detail/latest behavior, and secret-key rejection in payloads;
- dashboard aggregation from latest usable snapshots;
- RBAC and audit behavior;
- PostgreSQL migrations, normalized current inventory replacement, and immutable history;
- operational inventory filters, detail, dashboard, exceptions, saved views, and exports;
- metrics sample ingestion and P95 summary queries;
- Excel/CSV/JSON workbook and export route behavior.

## API Surface

Authentication and session:

- `POST /api/login`: app login using configured app credentials.
- `POST /api/logout`: clear the active app session.
- `GET /api/session`: return authenticated user and role when a session is active.

Manager registry and collection:

- `GET /api/managers`: list redacted Manager records.
- `POST /api/managers`: admin-only create with encrypted saved credentials.
- `PATCH /api/managers/:id`: admin-only metadata or credential update.
- `DELETE /api/managers/:id`: admin-only delete.
- `POST /api/managers/:id/collect`: admin/operator manual backend oVirt collection for one Manager.
- `POST /api/collect`: admin/operator manual backend oVirt collection for all enabled Managers.
- `GET /api/collection-runs`: list PostgreSQL collection run summaries, optionally filtered by `managerId`.
- `GET /api/collection-runs/:id`: return one collection run with redacted warnings and errors.

Snapshots and legacy dashboard/export:

- `POST /api/snapshots`: admin/operator snapshot save path retained for compatibility.
- `GET /api/snapshots`, `GET /api/snapshots/latest`, `GET /api/snapshots/:id`: snapshot history and details.
- `GET /api/dashboard`: legacy snapshot dashboard.
- `GET /api/exports/excel?snapshotId=...`: snapshot Excel export.
- `GET /api/exports/snapshot?format=json|csv|excel&snapshotId=...`: selected or latest snapshot export with RBAC redaction.

Normalized inventory and operations:

- `GET /api/inventory/vms`: PostgreSQL-backed paginated VM inventory list with server-side filters and selected columns.
- `GET /api/inventory/vms/:managerId/:vmId`: structured VM detail tabs without raw JSON.
- `GET /api/dashboard/operational`: KPI and chart-ready operational dashboard data with drill-down links.
- `GET /api/exports/inventory?format=json|csv|excel`: filtered inventory export.
- `GET /api/exports/vm-detail?format=json|csv|excel&managerId=...&vmId=...`: VM detail evidence export across tabs, freshness, and health deductions.
- `GET /api/metrics/vms/:managerId/:vmId`: time-series metric summary with P95 and rightsizing when samples exist.
- `GET /api/exceptions`: backup, RPO, restore-test, OS EOL, vulnerability, public exposure, lifecycle, and snapshot exceptions.
- `GET /api/exports/exceptions?format=json|csv|excel&type=...`: exception view export with RBAC redaction.
- `GET /api/integrations/status`: explicit unavailable states for future Commvault, CMDB, ticketing, and showback/chargeback adapters.

Workflow state and audit:

- `GET /api/saved-views`, `POST /api/saved-views`, `PATCH /api/saved-views/:id`, `DELETE /api/saved-views/:id`: saved inventory views.
- `GET /api/audit-logs`: admin-only sanitized audit records.

## Revamp Target Architecture

The revamp target is an operational VM inventory and risk dashboard for multiple oVirt/RHV Managers.

Target runtime components:

- React/Vite frontend for dashboards, VM inventory list, saved views, VM details, and exports.
- Node/Fastify API for auth, RBAC, manager administration, inventory queries, saved views, exports, audit, and collection orchestration.
- Backend collector or worker using official oVirt Engine REST APIs. A separate collector service may use the official Python SDK if that milestone chooses it.
- PostgreSQL relational store for normalized current inventory, ownership/CMDB mappings, immutable inventory history, collection runs, saved views, audit logs, and export metadata.
- Separate metrics backend for time-series CPU, memory, disk, network, availability, backup-age, snapshot-age, capacity, and forecast data.
- Docker image built with Docker Desktop Buildx for `linux/amd64` and `linux/arm64`.

Target collection flow:

1. Authenticated browser calls `ovirt-inventory`.
2. API checks session and RBAC.
3. API records a collection run or schedules a worker run.
4. Backend loads the Manager record and decrypts the saved oVirt credential only in memory.
5. Backend authenticates to oVirt and performs read-only collection.
6. Collector normalizes data centers, clusters, hosts, VMs, NICs, disks, storage domains, snapshots, networks, tags, affinity data, and events.
7. API/worker writes current inventory idempotently, appends history/change events, records warnings/errors, and updates freshness.
8. Browser receives only redacted status and inventory DTOs.

The browser must never call oVirt Managers directly, and it must never receive decrypted credentials, bearer tokens, authorization headers, or token request bodies.

## Migration Strategy

The migration should preserve existing snapshot behavior while introducing PostgreSQL in reviewable slices.

1. Add PostgreSQL configuration and migration runner while leaving existing SQLite paths usable for the current app.
2. Add normalized PostgreSQL tables for current inventory and immutable history.
3. Build repository interfaces for the new inventory model.
4. Backfill from existing SQLite snapshots into normalized PostgreSQL tables where possible.
5. Move read APIs to PostgreSQL-backed repositories behind compatible DTOs.
6. Move dashboard/export data sources from snapshot JSON to normalized inventory and metrics queries.
7. Retain legacy SQLite snapshot export until PostgreSQL export parity is validated.
8. Remove SQLite runtime dependency only after all data paths and tests no longer depend on it.

Rollback rule: each migration must be additive or safely reversible until the cutover milestone explicitly retires the old storage path.

## Target Data Boundaries

Relational inventory in PostgreSQL:

- managers, credentials metadata, collection runs;
- data centers, clusters, hosts, storage domains, logical networks, vNIC profiles;
- VMs, VM ownership metadata, tags, affinity data;
- child NIC, disk, and snapshot records;
- current health scores and evidence;
- immutable change events and audit records;
- saved views, field visibility policies, and export jobs.

Time-series metrics outside the normalized inventory schema:

- VM CPU/memory/disk/network usage;
- host and cluster capacity;
- storage-domain capacity, IOPS, throughput, latency, and growth;
- availability events, migration counts, backup age, and snapshot age;
- P95 CPU and memory calculations for capacity and rightsizing.

## Environment Variables

Current variables:

- `OVIRT_INVENTORY_HOST`
- `OVIRT_INVENTORY_PORT`
- `OVIRT_INVENTORY_DB_PATH`
- `OVIRT_INVENTORY_SESSION_SECRET`
- `OVIRT_INVENTORY_SESSION_TTL_HOURS`
- `OVIRT_INVENTORY_ENCRYPTION_KEY`
- `OVIRT_INVENTORY_ADMIN_USERNAME`
- `OVIRT_INVENTORY_ADMIN_PASSWORD_HASH`
- `OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS`
- `NODE_EXTRA_CA_CERTS`

Revamp target variables:

- `OVIRT_INVENTORY_DATABASE_URL`: PostgreSQL connection string.
- `OVIRT_INVENTORY_DATABASE_SSL`: `true` or `false`.
- `OVIRT_INVENTORY_METRICS_BACKEND`: `none`, `prometheus`, `victoriametrics`, `timescaledb`, `grafana`, or another approved adapter.
- `OVIRT_INVENTORY_METRICS_URL`: metrics backend URL when enabled.
- `OVIRT_INVENTORY_COLLECTOR_ENABLED`: enable or disable scheduled collector workers.
- `OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES`: VM/host/cluster/status cadence target.
- `OVIRT_INVENTORY_EXTENDED_SYNC_MINUTES`: snapshot/disk/NIC/tag cadence target.
- `OVIRT_INVENTORY_EVENT_SYNC_MINUTES`: event/audit collection cadence target.
- `OVIRT_INVENTORY_METRICS_SYNC_MINUTES`: metrics collection cadence target.
- `OVIRT_INVENTORY_BACKUP_SYNC_MINUTES`: backup status cadence target.
- `OVIRT_INVENTORY_FULL_SNAPSHOT_HOUR`: daily full historical snapshot hour.

## Security Rules

- Use only read-only oVirt API calls in the revamp MVP.
- Decrypt oVirt credentials only inside backend collection or worker execution.
- Never log, export, fixture, snapshot, or return decrypted credentials, bearer tokens, authorization headers, token request bodies, or local secrets.
- Keep insecure oVirt TLS disabled except for explicit lab validation.
- Prefer trusted CA configuration for oVirt Manager certificates.
- Keep lab credentials, local `.env` files, local database files, and generated exports out of git.
