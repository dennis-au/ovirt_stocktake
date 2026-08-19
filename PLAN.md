# ovirt-inventory Revamp Plan

This plan supersedes the snapshot-only implementation plan. Existing working behavior should remain usable while the app is incrementally revamped into a normalized oVirt/RHV VM inventory, dashboard, history, and risk-analysis system.

## Milestone 0: Baseline And Architecture Alignment [x]

- [x] Capture the current app behavior, API routes, database schema, and test coverage.
- [x] Record the target architecture: React/Vite frontend, Node/Fastify API, backend collectors/workers using official oVirt REST APIs or the official Python SDK, PostgreSQL relational inventory, separate time-series metrics store, encrypted credential storage, and Docker Buildx multiarch builds.
- [x] Document migration strategy from SQLite snapshot storage to PostgreSQL normalized inventory and history.
- [x] Define environment variables for app auth, credential encryption, PostgreSQL, metrics backend, collector cadence, TLS trust, and lab-only insecure TLS.

**Done when:** Current behavior is documented, target architecture is explicit, no secrets are written to files, and baseline `lint`, `typecheck`, `test`, `build`, and Docker Buildx validation pass.

## Milestone 1: PostgreSQL Inventory Schema [x]

- [x] Add migrations for managers, collection runs, data centers, clusters, hosts, storage domains, logical networks, vNIC profiles, VMs, VM ownership metadata, NICs, disks, snapshots, tags, affinity data, events, audit logs, saved views, and exports.
- [x] Add immutable history/change-event tables separate from current inventory tables.
- [x] Add indexes for manager, VM ID, datacenter, cluster, host, storage domain, network, status, owner, application, environment, criticality, tag, last seen, and health score.
- [x] Add migration validation tests and repository tests.

**Done when:** PostgreSQL initializes from migrations, relationships and indexes are tested, current inventory can be replaced idempotently per manager, and history is preserved across sync runs.

## Milestone 2: Secure Managers, RBAC, And Audit [x]

- [x] Keep app login and add RBAC roles for admin, operator, and viewer.
- [x] Store oVirt Manager credentials encrypted at rest and redact secrets from every API response, export, log, and test fixture.
- [x] Add RBAC-aware field visibility for sensitive governance and cost fields.
- [x] Add audit records for login/logout, manager changes, collection runs, saved-view changes, exports, and failed authorization attempts.

**Done when:** Protected endpoints enforce role permissions, credential updates never leak secrets, audit entries are queryable, and tests cover allowed and denied access paths.

## Milestone 3: oVirt Inventory Sync Collector [x]

- [x] Collect data from official oVirt Engine APIs with backend-side read-only requests.
- [x] Normalize data centers, clusters, hosts, VMs, storage domains, disks, NICs, logical networks, vNIC profiles, tags, VM snapshots, affinity data, and events.
- [x] Handle pagination, partial failures, stale or missing guest-agent data, API version differences, TLS/network/auth failures, and per-resource warnings.
- [x] Support authenticated manual collection for one manager and all enabled managers.
- [x] Add configurable scheduled sync cadences for inventory, snapshots/disks/NICs/tags, and events.

**Done when:** Manual and scheduled backend collection populate normalized current inventory and collection history without browser-to-oVirt calls or oVirt write actions.

## Milestone 4: Governance Metadata And Health Score [x]

- [x] Add ownership fields: environment, application, service role, owner, on-call group, cost center, criticality, CMDB CI, ticket reference, lifecycle status, retirement date, and monthly estimated cost.
- [x] Enforce production VM governance checks for owner, environment, application, and criticality.
- [x] Add exception policies for missing metadata, stale guest agent, unknown IP, missing backup, RPO breach, unsupported OS, public exposure, idle VMs, and snapshots older than 3, 7, and 30 days.
- [x] Implement an explainable health score with evidence-linked deductions and recommended actions.

**Done when:** Each VM has a computed health score, every deduction links to stored evidence, production metadata exceptions are visible, and policy tests cover representative healthy and risky VMs.

## Milestone 5: Inventory List, Filters, Saved Views [x]

- [x] Build a server-side paginated VM inventory list.
- [x] Add default columns: name, status, environment, application, owner, criticality, datacenter, cluster, host, OS, vCPU, RAM, CPU P95, RAM P95, storage used/provisioned, backup, snapshot, guest agent, IP address, last seen, and health score.
- [x] Add required filters for infrastructure placement, network, status, HA, governance metadata, OS, guest agent, backup, snapshots, metrics thresholds, dates, lifecycle, missing metadata, missing backup, unknown IP, and idle VM status.
- [x] Add column selection, saved views, and sharable deep links.
- [x] Add CSV, JSON, and Excel export for filtered lists.

**Done when:** Large VM inventories are filtered on the server, saved views restore correctly, deep links reproduce filters and columns, and exports match the visible filtered dataset without secrets.

## Milestone 6: VM Detail Page [x]

- [x] Add VM detail routing from inventory lists, KPI drill-downs, and search results.
- [x] Build tabs for Overview, Performance, Storage and snapshots, Network, Backup and DR, and Events and audit.
- [x] Show identity, ownership, status, placement, OS, IPs, health score, disks, snapshots, NICs, backup posture, metrics, events, and ticket links.
- [x] Show data freshness per tab when sources have different cadences.

**Done when:** Users can open any VM and inspect current state, history, metrics, backup posture, and health evidence without reading raw JSON.

## Milestone 7: Operational Dashboard And Charts [x]

- [x] Add clickable KPIs that open pre-filtered inventory lists.
- [x] Add VM status, metadata exception, HA risk, guest-agent, backup compliance, RPO breach, snapshot age, storage threshold, capacity, idle/oversized/orphaned, migration, host failure, and availability KPIs.
- [x] Add charts for VM status distribution, cluster capacity, storage capacity forecast, allocation vs utilization, VM size distribution, snapshot risk, backup compliance, OS lifecycle, host contention, availability events, and cost attribution.
- [x] Use P95 CPU and memory for capacity and rightsizing views.
- [x] Show per-manager freshness, last collection status, warnings, and errors.

**Done when:** Dashboard KPIs and charts are populated from stored inventory/metrics, every KPI can drill into a matching filtered list, and stale or failed data is obvious.

## Milestone 8: Metrics Pipeline [x]

- [x] Integrate an approved time-series backend or source such as oVirt Data Warehouse, Grafana, Prometheus-compatible APIs, TimescaleDB, or VictoriaMetrics.
- [x] Ingest VM, host, cluster, and storage-domain CPU, memory, disk, network, status transition, uptime, downtime, migration, latency, IOPS, throughput, capacity, backup-age, and snapshot-age metrics.
- [x] Calculate P95 CPU and memory, overcommit ratios, growth rates, and rightsizing indicators.
- [x] Keep time-series data separate from current inventory tables.

**Done when:** Metrics queries power capacity and performance views, P95 calculations are tested, and inventory remains usable when metrics are temporarily unavailable.

## Milestone 9: Backup, DR, Security, And Lifecycle [x]

- [x] Store backup policy, backup status, last successful backup, last attempt, RPO/RTO targets, actual RPO, restore-test evidence, and excluded disks.
- [x] Store OS EOL, last patch timestamp, EDR status, critical vulnerability count, public exposure, lifecycle status, retirement date, and cost estimate.
- [x] Add exception views for backup non-compliance, RPO breaches, restore-test gaps, unsupported OS, critical vulnerabilities, public exposure, and retirement candidates.
- [x] Add placeholders or adapters for future Commvault, CMDB, ticketing, and showback/chargeback integrations.

**Done when:** Backup, security, and lifecycle risk appears in VM health, dashboard KPIs, filters, detail tabs, and exports, with integration gaps clearly marked as unavailable rather than silently empty.

## Milestone 10: Exports, API, And Lab Acceptance [x]

- [x] Provide documented API endpoints for managers, collection runs, current inventory, VM details, filters, saved views, dashboards, exports, metrics summaries, audit logs, and health.
- [x] Generate Excel workbooks, CSV, and JSON exports for selected snapshots, filtered inventory lists, exception views, and VM detail evidence.
- [x] Validate the full flow against `https://lab111/ovirt-engine/` using credentials supplied out of band.
- [x] Run lint, typecheck, unit/API tests, browser tests, production build, and Docker Buildx multiarch build.
- [x] Record redacted validation evidence without usernames, passwords, tokens, authorization headers, or local secrets.

**Done when:** The revamped app can collect lab inventory, display dashboard/list/detail/history views, export data successfully, pass all automated checks, and produce secret-free acceptance notes.

Acceptance note: lab collection succeeded with redacted evidence. The lab currently returned zero VMs, so live VM-detail drilling is covered by automated seeded-data tests and will be rechecked against lab data when VMs are present.

## Milestone 10A: Collection Diagnostics Evidence Expansion [ ]

Improve the admin-only Diagnostics page so production users can provide enough redacted evidence to identify the remaining causes of `partial` inventory runs. This milestone is diagnostic-only and must not change collection status rules or collector behavior.

### Scope

- Keep the existing Snapshot Age Diagnostics route and admin-only access control.
- Add per-Manager totals for collection status, warning count, error count, populated resource count, and latest collection duration/API version.
- Add redacted error and warning counts grouped by resource category, including top-level resources, hosts, VM snapshots, affinity groups, and other child collections.
- Distinguish snapshot-list failures, snapshot-detail failures, host certificate-detail failures, missing certificate expiry, authentication failures, TLS/network failures, timeout failures, HTTP 4xx failures, HTTP 5xx failures, and other failures where the stored evidence supports that classification.
- Show whether each category was collected, empty, partially collected, or failed, without exposing manager names, Manager URLs, VM names, snapshot names, credentials, tokens, authorization headers, or raw API payloads.
- Include redacted issue samples or stable issue fingerprints with resource category, failure category, HTTP status class when known, and count. Do not include free-form upstream error text unless it has passed explicit redaction.
- Add a reliable report handoff path: Clipboard API when available, a textarea-selection fallback when it is unavailable or denied, and a downloadable redacted JSON report as a final fallback.
- Show clear copy/download success and failure states and preserve the report in a selectable field.
- Keep the current snapshot-date normalization behavior and display valid snapshot-date counts separately from unrelated collection errors.

### Explicitly Deferred

- Do not change the definition of `success`, `partial`, or `failed`.
- Do not downgrade host certificate-detail errors from errors to warnings.
- Do not change host certificate API calls, snapshot collection, retry behavior, scheduler behavior, database schema, or Compose packaging.
- Do not infer a root cause from the current report until the expanded report provides resource-level evidence.

### Implementation Phases

#### Phase 1: Diagnostic Contract

- [x] Define a versioned redacted diagnostics response containing collection totals, per-resource state, categorized issue counts, and safe issue fingerprints.
- [x] Add server-side redaction and classification tests for known issue messages and unknown/malformed issue values.
- [x] Confirm the response cannot contain Manager names/URLs, VM names, snapshot names, credentials, tokens, authorization headers, or raw payloads.

**Checkpoint:** An admin can request a complete report that identifies which resource category caused a partial run without exposing sensitive inventory details.

#### Phase 2: Diagnostics Page Evidence UI

- [x] Add per-Manager resource status rows and grouped issue counts to the Diagnostics page.
- [x] Display total errors separately from snapshot-date issues so valid snapshot dates do not imply a successful full collection.
- [x] Display collection time, API version, duration, status, and redacted category counts in a layout that remains readable at desktop and mobile widths.
- [x] Keep empty, unavailable, partial, and error states visually distinct.

**Checkpoint:** The user can paste one report that shows whether the remaining errors are from hosts, certificates, top-level lists, child resources, network/TLS, authentication, or another category.

#### Phase 3: Report Handoff

- [x] Keep Clipboard API copy as the preferred path.
- [x] Add a browser-compatible text-selection fallback when clipboard permissions are unavailable.
- [x] Add a download fallback for the redacted JSON report.
- [ ] Add browser tests for successful copy, denied/unavailable Clipboard API, selection fallback, download action, and no secret leakage.

**Checkpoint:** The report can be handed off from production even when the browser blocks direct clipboard access.

### Validation Plan

- [x] Unit-test issue categorization, per-resource aggregation, redaction, report versioning, and stable fingerprints.
- [x] API-test admin access, report generation, empty/partial/failed collection evidence, and secret exclusion.
- [ ] Browser-test Diagnostics at desktop and mobile widths, refresh behavior, selectable report text, Clipboard API fallback, download fallback, and no page-level horizontal overflow.
- [x] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Manually collect from `https://lab111/ovirt-engine/` only if credentials are supplied out of band; paste only the redacted report into the next troubleshooting step.

**Done when:** The Diagnostics page provides enough redacted per-resource evidence to identify the remaining partial-collection cause, and the report can be copied or downloaded in browser environments that deny clipboard access. No partial-status or collector behavior has changed.

## Milestone 11: Durable PostgreSQL Job Scheduler [ ]

Replace the process-local `setInterval` inventory and metrics schedulers with a durable PostgreSQL-backed job system. The selected module is [pg-boss](https://pgboss.io/), using the PostgreSQL service already required by the Compose deployment. The target version must be verified at implementation time; the reviewed baseline is pg-boss 12.x, which requires Node.js 22.12+ and PostgreSQL 13+.

### Architecture Decision

- Use pg-boss instead of `node-cron`, Bree, Agenda, or BullMQ.
- pg-boss fits the existing Node.js and PostgreSQL stack, supports durable jobs, database-coordinated workers, retries with exponential backoff, dead-letter handling, cron schedules, and multi-instance execution without adding Redis or MongoDB.
- Let an administrator configure each collection cadence in the Settings page. Settings must expose enabled/disabled controls and numeric intervals from 1 to 1440 minutes for inventory and capacity metrics collection, with the saved value becoming the scheduler's source of truth.
- Do not translate every interval directly to `*/N` cron because arbitrary intervals do not map reliably across hour and day boundaries.
- Run one durable one-minute dispatcher schedule. The dispatcher checks application-owned `next_run_at` values using PostgreSQL time and enqueues work only when a cadence is due.
- Use separate schedule state for inventory and capacity metrics. A delayed or restarted worker performs at most one catch-up dispatch, then advances `next_run_at`; it must not create a burst for every missed interval.
- Fan scheduled inventory work out into one job per enabled Manager. A slow or unavailable Manager must not block collection for other Managers.
- Keep manual Manager collection available through the existing API and shared collection service. Manual and scheduled collection must use identical credential decryption, URL normalization, TLS policy, oVirt request code, snapshot persistence, and normalization logic.
- Treat a returned snapshot with `status: failed` as a failed job attempt. A worker must not mark a scheduled job successful merely because a failed snapshot row was saved.
- PostgreSQL is required for durable scheduling. If PostgreSQL or pg-boss is unavailable, manual collection and existing successful inventory remain available, while scheduler health reports a clear unavailable state.

### Queue And Job Model

- Queue `inventory-dispatch`: runs once per minute and evaluates whether inventory collection is due.
- Queue `inventory-manager-collect`: one job per enabled Manager, keyed by Manager ID to prevent overlapping queued or active work for the same Manager.
- Queue `metrics-dispatch`: runs once per minute and evaluates whether capacity metrics collection is due.
- Queue `metrics-manager-collect`: one job per enabled Manager, with per-Manager overlap prevention.
- Queue `scheduler-dead-letter`: stores terminally failed inventory and metrics jobs for operator review and controlled redrive.
- Job payloads contain only stable identifiers and scheduling metadata. Credentials, tokens, decrypted passwords, and authorization headers must never be stored in pg-boss payloads or outputs.
- Store application schedule state in PostgreSQL with at least: job type, enabled state, interval minutes, next run, last queued time, last started time, last completed time, last result, last error summary, consecutive failures, and updated time.

### Failure And Concurrency Policy

- Default to one active inventory job per Manager and one active metrics job per Manager.
- Use bounded worker concurrency across different Managers so one unreachable Manager does not serialize or block the estate.
- Apply an end-to-end job deadline and request-level timeouts. Timed-out work must fail cleanly, release its worker lease, and become retryable.
- Retry transient DNS, network, TLS, HTTP 429, and HTTP 5xx failures with bounded exponential backoff and jitter.
- Do not retry invalid credentials, disabled Managers, malformed Manager URLs, or permanent validation failures until configuration changes.
- Record `success`, `partial`, and `failed` outcomes from the collected snapshot. Only `success` and approved `partial` results count as successful job completion.
- Preserve the last known-good current inventory when jobs fail. Failed attempts remain visible as collection evidence.
- Use worker heartbeats and graceful shutdown. Container termination must stop accepting jobs, allow bounded active work to finish, and return unfinished work to the queue for retry.

### Observability

- Extend health reporting with scheduler backend, worker status, database connectivity, queue depth, active jobs, retrying jobs, dead-letter count, last dispatcher heartbeat, next due time, and last successful collection.
- Record one audit event when work is queued and one when each Manager job finishes. Audit metadata includes job ID, Manager ID, scheduled/manual source, attempt number, duration, snapshot ID, status, warning count, and error count.
- Replace the misleading `collection.scheduled_completed` result with aggregate `success`, `partial`, or `failed` status based on Manager job outcomes.
- Expose redacted scheduler state through an admin-only API for troubleshooting. Do not expose pg-boss connection strings, payloads containing secrets, or raw authorization failures.
- Keep completed and failed job retention bounded. Document operator procedures for inspecting, retrying, and deleting dead-letter jobs.

### Implementation Phases

#### Phase 1: PostgreSQL Job Foundation

- [ ] Add pg-boss and pin a reviewed compatible version.
- [ ] Add application-owned schedule-state migration, required indexes, and rollback-safe migration tests.
- [ ] Add a scheduler service that owns pg-boss startup, queue creation, event handlers, and graceful shutdown.
- [ ] Add Settings-page controls for inventory and capacity metrics collection: enabled state and an administrator-editable interval of 1 to 1440 minutes.
- [ ] Keep scheduler backend and worker concurrency as deployment configuration rather than user-facing Settings controls.

**Checkpoint:** pg-boss initializes against PostgreSQL, starts and stops cleanly, and no collection jobs run yet.

#### Phase 2: Inventory Scheduling

- [ ] Extract or reuse a single per-Manager collection service shared by manual and worker execution.
- [ ] Implement the durable inventory dispatcher and one job per enabled Manager.
- [ ] Make Settings-page interval or enabled-state updates change schedule state atomically without restarting an in-memory timer, and show the next scheduled collection time after saving.
- [ ] Add retry classification, job deadlines, overlap prevention, audit events, and dead-letter handling.
- [ ] Keep the legacy scheduler available behind a temporary rollout flag, but never allow both backends to enqueue production jobs simultaneously.

**Checkpoint:** scheduled and manual collection produce equivalent results for the same Manager, and one failed Manager does not block another.

#### Phase 3: Metrics Scheduling

- [ ] Move capacity metrics dispatch and per-Manager collection onto pg-boss.
- [ ] Keep inventory and metrics queues isolated so metrics backlog cannot delay inventory snapshots.
- [ ] Validate that metrics continue writing only to the approved metrics backend and do not mix time-series samples into snapshot storage.

**Checkpoint:** inventory and metrics schedules run independently with separate concurrency, retries, and health state.

#### Phase 4: Cutover And Cleanup

- [ ] Deploy pg-boss schema and workers with job execution disabled, then validate health and queue access.
- [ ] Enable durable scheduling for a controlled soak period and confirm no duplicate Manager collections.
- [ ] Disable and remove `server/scheduler.ts` and `server/metrics-scheduler.ts` after the soak period passes.
- [ ] Remove the temporary legacy backend flag and update Compose, README, operations notes, and release artifacts.

**Done when:** Scheduled inventory and metrics survive process restarts, avoid duplicate or overlapping Manager jobs, isolate Manager failures, retry transient faults, expose accurate health, and pass multi-instance and crash-recovery tests.

### Validation Plan

- [ ] Unit-test cadence calculations, database-time due checks, catch-up behavior, retry classification, redaction, and aggregate status.
- [ ] Integration-test pg-boss against PostgreSQL 16 rather than relying only on mocks.
- [ ] Start two worker instances against one database and prove that only one job runs for a Manager and due time.
- [ ] Stop a worker after job acquisition, restart it, and prove the job is recovered without duplicate snapshot persistence.
- [ ] Save a new interval or enabled state through the Settings page and prove the next due time changes without an application restart or duplicate schedule.
- [ ] Simulate one successful and one unreachable Manager and prove both produce independent outcomes.
- [ ] Prove failed snapshots retry and never produce a false successful scheduler audit result.
- [ ] Verify manual collection remains functional while the durable scheduler is disabled or degraded.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `docker buildx build --platform linux/amd64,linux/arm64 .`.

### Alternatives Considered

- Graphile Worker: strong PostgreSQL-backed reliability, retries, recurring jobs, and optional backfill, but its crontab-oriented configuration is less direct for the existing dynamically editable numeric interval.
- BullMQ: mature scheduling and retry support, but it adds Redis and another stateful service to the Compose and operations footprint.
- `node-cron` or Bree: suitable for process-local timing, but they do not by themselves provide the durable database-owned job state, multi-instance coordination, retries, and dead-letter workflow required here.
- `pg_cron`: durable inside PostgreSQL, but it is an extension and is better suited to SQL execution than invoking and supervising the existing Node collection service.

### Rollback

- Keep the legacy scheduler code behind a temporary backend flag during rollout.
- A rollback disables pg-boss workers and re-enables the legacy scheduler; it must not delete pg-boss schema or job history during the incident.
- Before rollback, pause pg-boss queues or remove active schedules so both implementations cannot collect the same Manager concurrently.
- Remove the legacy path only after the durable scheduler has completed the agreed soak period with restart, failure, and multi-instance evidence.
