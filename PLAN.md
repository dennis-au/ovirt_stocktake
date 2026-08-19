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

Improve the admin-only Diagnostics page so production users can provide enough redacted evidence to identify the remaining causes of `partial` inventory runs. This milestone does not change collection status rules; the only collector change is removing unsupported host certificate-expiry retrieval.

### Scope

- Keep the existing Snapshot Age Diagnostics route and admin-only access control.
- Add per-Manager totals for collection status, warning count, error count, populated resource count, and latest collection duration/API version.
- Add redacted error and warning counts grouped by resource category, including top-level resources, hosts, VM snapshots, affinity groups, and other child collections.
- Distinguish snapshot-list failures, snapshot-detail failures, authentication failures, TLS/network failures, timeout failures, HTTP 4xx failures, HTTP 5xx failures, and other failures where the stored evidence supports that classification.
- Show whether each category was collected, empty, partially collected, or failed. The admin Diagnostics page may show configured Manager names, but copied and downloaded reports must use anonymized labels and must not expose Manager URLs, VM names, snapshot names, credentials, tokens, authorization headers, or raw API payloads.
- Include redacted issue samples or stable issue fingerprints with resource category, failure category, HTTP status class when known, and count. Do not include free-form upstream error text unless it has passed explicit redaction.
- Add a reliable report handoff path: Clipboard API when available, a textarea-selection fallback when it is unavailable or denied, and a downloadable redacted JSON report as a final fallback.
- Show clear copy/download success and failure states and preserve the report in a selectable field.
- Keep the current snapshot-date normalization behavior and display valid snapshot-date counts separately from unrelated collection errors.

### Explicitly Deferred

- Do not change the definition of `success`, `partial`, or `failed`.
- Do not change snapshot collection, retry behavior, scheduler behavior, database schema, or Compose packaging beyond removing unsupported host certificate-expiry collection.
- Do not infer a root cause from the current report until the expanded report provides resource-level evidence.

### Implementation Phases

#### Phase 1: Diagnostic Contract

- [x] Define a versioned diagnostics response containing collection totals, per-resource state, categorized issue counts, and safe issue fingerprints. The admin-only UI response includes the configured Manager name for on-screen diagnosis.
- [x] Add classification tests for known issue messages and unknown/malformed issue values, plus report-redaction tests for manager names and sensitive collection details.
- [x] Confirm copied and downloaded reports cannot contain Manager names/URLs, VM names, snapshot names, credentials, tokens, authorization headers, or raw payloads.

**Checkpoint:** An admin can identify the affected Manager and resource category on screen, then share a report that omits sensitive inventory details.

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

**Done when:** The Diagnostics page provides enough redacted per-resource evidence to identify the remaining partial-collection cause, and the report can be copied or downloaded in browser environments that deny clipboard access. No partial-status rules have changed.

## Milestone 11: PostgreSQL Schedule Reconciler [x]

Replace pg-boss queue dispatch with a compact reconciler inside the application process. PostgreSQL remains the source of truth for schedule state and dispatch-run ownership; the app no longer depends on queue workers, dead letters, or pg-boss cron schedules.

### Architecture Decision

- Administrators configure enabled state and 1-to-1440-minute cadences in Settings. PostgreSQL stores each schedule's next run, results, and failure count.
- A reconciler polls every 30 seconds. It claims each overdue schedule atomically using PostgreSQL time, allowing at most one catch-up cycle before advancing the next run.
- Each claimed cycle creates a PostgreSQL dispatch run and calls the same per-Manager backend collection service as manual collection. Managers run sequentially in stable name order.
- Failed or partial Manager collections are terminal for that cycle. They are recorded and skipped until the next configured interval; the reconciler does not retry them or build a backlog.
- Active dispatch runs receive a 30-second heartbeat. A subsequent process recovers a run whose heartbeat is stale for 20 minutes, marks unfinished Managers skipped, records the aggregate result, and permits the next scheduled cycle.
- The Settings page shows the last reconciler heartbeat and calls a schedule overdue when its next run is in the past. Raw backend error text remains unavailable in the UI.
- Manual collection remains independently available and uses the same credential handling, TLS policy, oVirt client, normalization, and persistence paths as scheduled inventory collection.

### Validation Plan

- [x] Prove an overdue inventory schedule is claimed on application startup and enabled Managers collect sequentially.
- [x] Prove a failed Manager is terminal for one cycle and can only run again after a later due interval.
- [x] Prove disabled Managers are skipped and stale dispatch runs recover without queue cancellation.
- [x] Prove reconciler success and failure heartbeats persist in PostgreSQL and surface through the admin scheduler API.
- [ ] Run two application instances against PostgreSQL 16 and prove the conditional schedule claim allows only one dispatch run per due time.
- [ ] Interrupt an active collection in a disposable environment, wait for stale recovery, and confirm known-good inventory remains intact.
- [ ] Validate the Settings heartbeat and overdue indicators in a production-like browser session after deployment.

**Done when:** Scheduled inventory and metrics run through direct sequential backend collection, survive application restarts via PostgreSQL dispatch state, never queue retries for a failed Manager within the same cadence, and visibly report a stale reconciler or overdue schedule.
