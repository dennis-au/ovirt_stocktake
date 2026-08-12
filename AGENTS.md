# ovirt-inventory Agent Instructions

## Environment

- Build `ovirt-inventory` as an authenticated operational inventory web app for oVirt/RHV estates.
- Keep the current app stack unless a milestone explicitly changes it: React, TypeScript, and Vite frontend with a Node/Fastify API.
- Revamp storage from snapshot-only SQLite toward PostgreSQL for normalized current inventory, ownership/CMDB mappings, inventory history, change events, audit logs, saved views, and export metadata.
- Keep performance metrics separate from relational inventory data. Use a time-series store such as TimescaleDB, VictoriaMetrics, Prometheus-compatible storage, or an approved existing metrics source.
- Collect data from multiple oVirt Managers through official oVirt Engine REST APIs. A dedicated worker may use the official Python SDK if that milestone chooses a separate collector service. The browser calls `ovirt-inventory`; backend services or workers call oVirt.
- Never make the browser call oVirt Managers directly and never return decrypted oVirt credentials to the browser.
- Store oVirt Manager credentials encrypted at rest. Decrypt only in backend memory for an active collection request or worker run.
- Support manual refresh and configurable sync cadences for inventory, events, metrics, backup status, and daily full historical snapshots.
- Use read-only oVirt API access. The only non-GET oVirt request should be authentication/token exchange unless a future approved workflow explicitly adds write actions.
- Model oVirt/RHV resources as first-class entities: data centers, clusters, hosts, VMs, NICs, logical networks, vNIC profiles, disks, storage domains, VM snapshots, tags, events, affinity data, and collection runs.
- Model governance and lifecycle metadata for VMs: owner, environment, application, service role, on-call group, cost center, criticality, CMDB CI, ticket reference, backup policy/status, security posture, lifecycle status, retirement date, and showback cost.
- Use guest-agent availability as a first-class health signal because hostname, IP, OS, and graceful operations depend on it.
- Export data to Excel, CSV, and JSON without secrets.
- Build and validate container images with Docker Desktop Buildx for `linux/amd64` and `linux/arm64`.
- Prefer trusted oVirt Manager CA certificates through runtime trust configuration such as `NODE_EXTRA_CA_CERTS`. Any insecure TLS flag must remain default-off, lab-only, and clearly documented.
- The lab validation target is `https://lab111/ovirt-engine/`. Credentials are supplied out of band and must not be committed, logged, exported, or echoed into docs.

## Validation

- Run the smallest relevant validation for each milestone before moving to the next one.
- Run the full suite before marking a revamp milestone done:
  - `npm run lint`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `docker buildx build --platform linux/amd64,linux/arm64 .`
- Add or update package scripts before considering related work complete.
- Add database migration tests for schema changes, required indexes, foreign keys, and rollback-safe migration behavior.
- Unit-test credential encryption/decryption, URL normalization, oVirt response normalization, policy evaluation, health-score deductions, saved-view parsing, dashboard aggregation, and workbook/CSV/JSON export generation.
- API-test authentication/session handling, RBAC-aware field visibility, manager CRUD, credential updates without secret leakage, collection run creation, current inventory reads, history reads, detail pages, saved filters, dashboards, and exports.
- Collector tests must cover pagination, partial collection failures, stale guest-agent data, missing fields, tags, snapshots older than policy thresholds, and read-only oVirt method enforcement.
- Browser tests should cover login, dashboard KPIs, server-side inventory filtering, saved views, deep links, VM detail tabs, manual collection, history, and export downloads.
- Metrics validation must prove inventory state and time-series metrics remain separated, and that dashboards use P95 CPU/memory where required.
- Manual lab validation should confirm collection from `https://lab111/ovirt-engine/` with redacted evidence. Do not store passwords, bearer tokens, or authorization headers in artifacts.

## Workflow

1. Inspect `git status --short --branch` before editing. Preserve unrelated user changes and never restore deleted legacy files unless explicitly asked.
2. Work milestone by milestone. Keep each change small, reviewable, and independently valid.
3. Stop and ask before production access, secrets, destructive actions, schema resets with data loss, or ambiguous requirement choices.
4. Never commit lab credentials, tokens, session secrets, local databases, generated exports, `.env` files, or screenshots containing secrets.
5. Keep route handlers thin: validate input, check session/RBAC, call a service/repository, and return redacted DTOs.
6. Keep collectors idempotent and read-only. Record collection status, duration, warnings, errors, source manager, and source API version.
7. Keep normalized current inventory separate from immutable history/change events and separate again from time-series metrics.
8. Treat failed or partial collection as evidence to display; never delete earlier known-good inventory just because a later run fails.
9. Make freshness visible in every dashboard and detail view that depends on collected data.
10. Preserve explainability: health scores, governance exceptions, backup gaps, snapshot risk, and capacity alerts must link to the data that caused them.
11. Use server-side filtering and pagination for large inventories. Avoid client-only filtering for operational datasets.
12. Keep exports and logs redacted. No credential, token, or password-grant request body may appear in snapshots, exports, browser storage, logs, tests, or docs.
