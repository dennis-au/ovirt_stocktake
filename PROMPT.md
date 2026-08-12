# ovirt-inventory Revamp Prompt

## Goal

Revamp `ovirt-inventory` into an authenticated operational VM inventory and risk dashboard for multiple oVirt/RHV Managers.

The app should answer four operational questions:

1. What VMs exist, where do they run, and who owns them?
2. Which VMs are unhealthy, unprotected, or operationally risky?
3. Where are CPU, memory, and storage capacity constraints emerging?
4. Which resources are idle, oversized, orphaned, or ready for retirement?

Users should be able to:

- log in to `ovirt-inventory`;
- register multiple oVirt Managers with encrypted saved credentials;
- trigger collection manually and run approved scheduled sync cadences;
- collect through backend-side official oVirt Engine REST API calls, or the official Python SDK if a dedicated collector service is selected;
- inspect normalized current inventory, history, and change events;
- search and filter VM inventory at server side;
- save views, share deep links, and choose visible columns;
- open VM detail pages with focused tabs;
- view clickable dashboard KPIs and charts;
- review explainable health score deductions and recommended actions;
- export selected data to Excel, CSV, and JSON.

The target data model should include:

- oVirt infrastructure: data centers, clusters, hosts, storage domains, logical networks, vNIC profiles, tags, affinity data, and events.
- VMs: immutable VM ID, name, notes, created/last-seen timestamps, status, placement, HA, migration, CPU topology, memory, guest OS, guest-agent freshness, BIOS/secure boot, and boot order.
- VM ownership and governance: environment, application, service role, owner, on-call group, cost center, criticality, CMDB CI, ticket reference, lifecycle status, retirement date, and normalized tags.
- NICs as child records: MAC, vNIC profile, logical network, VLAN, interface type, link state, IP addresses, filters, QoS, and port mirroring.
- Disks and snapshots as child records: provisioned and actual size, storage domain, format, interface, bootable/shareable flags, backup inclusion, disk profile, direct LUN, encryption, snapshot age, size, creator, status, and ticket reference.
- Backup, security, and lifecycle fields: backup policy/status, backup/RPO/RTO timestamps and targets, restore-test evidence, OS EOL, patch timestamp, EDR status, critical vulnerability count, public exposure, and estimated monthly cost.

Production VMs must have `owner`, `environment`, `application`, and `criticality`. Missing required metadata should appear as governance exceptions.

Keep inventory state separate from time-series performance data. Store normalized current inventory, inventory history, ownership mappings, audit logs, and saved views in PostgreSQL. Store CPU, memory, disk, network, availability, backup-age, snapshot-age, and capacity metrics in a time-series store or approved metrics backend.

Dashboard requirements:

- clickable KPIs that open pre-filtered inventory lists;
- VM status distribution by cluster or host;
- production VM count and production metadata exceptions;
- HA-enabled VMs and HA-enabled VMs currently unavailable;
- guest-agent unavailable or stale VMs;
- VMs missing owner, environment, application, or cost center;
- backup compliance, failed jobs, missing protection, and RPO breaches;
- snapshots older than 3, 7, and 30 days;
- cluster CPU and memory allocation, utilization, P95 demand, and overcommit;
- storage domains above 70%, 80%, and 90% consumption;
- idle, oversized, orphaned, and retirement-candidate VMs;
- migration, host failure, and availability events over the last 24 hours and 7 days;
- freshness and collection errors for each oVirt Manager.

Recommended visualizations include VM status stacked bars, cluster capacity bars with thresholds, storage capacity forecast lines, allocation vs utilization grouped bars, VM size distribution scatter plots, snapshot-risk ranked bars, backup-compliance stacked bars, OS lifecycle bars, host-contention heatmaps, availability event time series, and cost-attribution charts. Use P95 CPU and memory for capacity and rightsizing analysis.

Inventory list requirements:

- default columns: name, status, environment, application, owner, criticality, datacenter, cluster, host, OS, vCPU, RAM, CPU P95, RAM P95, storage used/provisioned, backup, snapshot, guest agent, IP address, last seen, and health score;
- required filters: datacenter, cluster, host, storage domain, logical network, vNIC profile, VM status, HA status, environment, owner, application, criticality, cost center, tag, OS family/version, guest-agent status, backup status, backup age, RPO breach, restore-test status, snapshot presence/age/size, CPU/memory/disk/network thresholds, creation date, last boot, last seen, lifecycle status, missing metadata, missing backup, unknown IP, and idle VM status;
- saved views, sharable deep links, column selection, server-side filtering, CSV/JSON export, Excel export, and RBAC-aware field visibility.

VM detail pages should use tabs:

1. Overview: identity, ownership, status, cluster/host, OS, IPs, and health score.
2. Performance: CPU, memory, disk, and network time-series metrics.
3. Storage and snapshots: disks, storage domains, provisioned vs actual size, and snapshots.
4. Network: NICs, vNIC profiles, logical networks, MACs, IP addresses, and security indicators.
5. Backup and DR: protection policy, job history, RPO/RTO, and restore-test evidence.
6. Events and audit: status changes, migrations, configuration changes, API sync history, and ticket links.

Health score must be transparent and evidence-linked:

- start at 100;
- subtract for backup/RPO breach, critical vulnerability or unsupported OS, expired or oversized snapshot, stale or unavailable guest agent, capacity contention, and missing owner/environment/application metadata;
- show each deduction with evidence and a recommended action.

Collection cadence targets:

- VM, host, cluster, and status inventory: 5 to 15 minutes;
- snapshot, disk, NIC, and tag inventory: 15 to 60 minutes;
- events and audit records: 1 to 5 minutes or event-driven;
- performance metrics: 1 to 5 minutes;
- backup status: 15 to 60 minutes, with higher frequency around backup windows;
- full historical inventory snapshot: daily.

## Non-goals

- Do not create, update, delete, start, stop, migrate, resize, snapshot, or otherwise mutate oVirt resources in the revamp MVP.
- Do not auto-delete snapshots, auto-retire VMs, or auto-resize resources. Surface evidence, estimate impact, require approval, and record a change ticket before future remediation.
- Do not make the browser call oVirt Managers directly.
- Do not return decrypted oVirt credentials, bearer tokens, authorization headers, or password-grant bodies to the browser.
- Do not store decrypted credentials or tokens in PostgreSQL, time-series storage, browser storage, logs, snapshots, exports, docs, or test fixtures.
- Do not mix time-series performance metrics into the normalized current-inventory schema.
- Do not claim dashboards are real-time when they reflect collected data. Always display freshness.
- Do not implement Commvault, CMDB, ticketing, showback/chargeback, or approval workflows beyond MVP placeholders unless their milestone is explicitly selected.
- Do not require public internet access at runtime.
- Do not enable insecure TLS in production.
- Do not commit lab credentials, local database files, generated exports, or `.env` files.
