import { randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import type { PostgresQueryable } from "./migrate.js";

export type CollectionRunStatus = "success" | "partial" | "failed" | "running";

export interface InventorySyncInput {
  managerId: string;
  collectionRunId?: string;
  status: CollectionRunStatus;
  apiVersion?: string;
  startedAt: string;
  completedAt?: string;
  warnings?: unknown[];
  errors?: unknown[];
  resources: {
    dataCenters?: DataCenterRecord[];
    clusters?: ClusterRecord[];
    hosts?: HostRecord[];
    storageDomains?: StorageDomainRecord[];
    logicalNetworks?: LogicalNetworkRecord[];
    vnicProfiles?: VnicProfileRecord[];
    vms?: VmRecord[];
    affinityGroups?: AffinityGroupRecord[];
    events?: EventRecord[];
  };
}

export interface ReplaceInventoryResult {
  collectionRunId: string;
  vmCount: number;
}

export interface DataCenterRecord {
  dataCenterId: string;
  name: string;
  status?: string;
  raw?: unknown;
}

export interface ClusterRecord {
  clusterId: string;
  dataCenterId?: string;
  name: string;
  cpuType?: string;
  version?: string;
  raw?: unknown;
}

export interface HostRecord {
  hostId: string;
  clusterId?: string;
  name: string;
  status?: string;
  maintenance?: boolean;
  raw?: unknown;
}

export interface StorageDomainRecord {
  storageDomainId: string;
  dataCenterId?: string;
  name: string;
  status?: string;
  storageType?: string;
  totalBytes?: number;
  usedBytes?: number;
  availableBytes?: number;
  raw?: unknown;
}

export interface LogicalNetworkRecord {
  networkId: string;
  dataCenterId?: string;
  name: string;
  vlanId?: number;
  raw?: unknown;
}

export interface VnicProfileRecord {
  vnicProfileId: string;
  networkId?: string;
  name: string;
  qos?: string;
  portMirroring?: boolean;
  raw?: unknown;
}

export interface VmRecord {
  vmId: string;
  name: string;
  description?: string;
  comment?: string;
  createdAt?: string;
  status?: string;
  statusDetail?: string;
  clusterId?: string;
  clusterName?: string;
  dataCenterId?: string;
  dataCenterName?: string;
  hostId?: string;
  hostName?: string;
  preferredHost?: string;
  migrationPolicy?: string;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  uptimeSeconds?: number;
  haEnabled?: boolean;
  haPriority?: number;
  watchdogType?: string;
  watchdogAction?: string;
  migrationCount30d?: number;
  vcpus?: number;
  sockets?: number;
  coresPerSocket?: number;
  threadsPerCore?: number;
  cpuProfile?: string;
  cpuPinning?: string;
  numaPinning?: string;
  memoryMb?: number;
  maxMemoryMb?: number;
  guaranteedMemoryMb?: number;
  memoryBallooning?: boolean;
  hugepages?: string;
  osType?: string;
  guestOsName?: string;
  guestOsVersion?: string;
  kernelVersion?: string;
  hostname?: string;
  fqdn?: string;
  guestAgentStatus?: string;
  guestAgentVersion?: string;
  lastGuestAgentUpdate?: string;
  biosType?: string;
  secureBoot?: boolean;
  bootOrder?: unknown[];
  healthScore?: number;
  healthDeductions?: unknown[];
  environment?: string;
  application?: string;
  serviceRole?: string;
  owner?: string;
  onCallGroup?: string;
  costCenter?: string;
  criticality?: string;
  cmdbCiId?: string;
  ticketReference?: string;
  backupPolicy?: string;
  backupStatus?: string;
  lastBackupSuccessAt?: string;
  lastBackupAttemptAt?: string;
  rpoTargetHours?: number;
  rpoActualHours?: number;
  rtoTargetHours?: number;
  lastRestoreTestAt?: string;
  backupExcludedDisks?: unknown[];
  osEolDate?: string;
  lastPatchAt?: string;
  edrStatus?: string;
  vulnerabilityCriticalCount?: number;
  publicIp?: string;
  lifecycleStatus?: string;
  retireDate?: string;
  monthlyEstimatedCost?: number;
  tags?: string[];
  nics?: VmNicRecord[];
  disks?: VmDiskRecord[];
  snapshots?: VmSnapshotRecord[];
  raw?: unknown;
}

export interface VmNicRecord {
  nicId: string;
  name: string;
  macAddress?: string;
  vnicProfileId?: string;
  vnicProfile?: string;
  logicalNetwork?: string;
  vlanId?: number;
  interfaceType?: string;
  linked?: boolean;
  ipv4Addresses?: string[];
  ipv6Addresses?: string[];
  networkFilter?: string;
  qos?: string;
  portMirroring?: boolean;
  raw?: unknown;
}

export interface VmDiskRecord {
  diskId: string;
  alias: string;
  storageDomainId?: string;
  storageDomain?: string;
  diskFormat?: string;
  provisionedSizeGib?: number;
  actualSizeGib?: number;
  interface?: string;
  bootable?: boolean;
  shareable?: boolean;
  backupIncluded?: boolean;
  diskProfile?: string;
  directLun?: string;
  encrypted?: boolean;
  raw?: unknown;
}

export interface VmSnapshotRecord {
  snapshotId: string;
  description?: string;
  createdAt?: string;
  status?: string;
  snapshotType?: string;
  ageDays?: number;
  sizeGib?: number;
  creator?: string;
  ticketReference?: string;
  raw?: unknown;
}

export interface AffinityGroupRecord {
  affinityGroupId: string;
  name: string;
  enforcing?: boolean;
  positive?: boolean;
  vmIds?: string[];
  raw?: unknown;
}

export interface EventRecord {
  eventId: string;
  eventTime: string;
  severity?: string;
  resourceType?: string;
  resourceId?: string;
  message: string;
  raw?: unknown;
}

interface TransactionClient extends PostgresQueryable {
  release?: () => void;
}

export type ConnectablePostgres = PostgresQueryable & {
  connect?: () => Promise<TransactionClient>;
};

export async function replaceCurrentInventory(db: ConnectablePostgres, input: InventorySyncInput): Promise<ReplaceInventoryResult> {
  return withTransaction(db, async (client) => {
    const collectionRunId = input.collectionRunId ?? randomUUID();
    const completedAt = input.completedAt ?? null;
    const durationMs = input.completedAt ? Date.parse(input.completedAt) - Date.parse(input.startedAt) : null;
    const lastSeenAt = input.completedAt ?? input.startedAt;

    await client.query(
      `
        INSERT INTO collection_runs (
          id, manager_id, status, api_version, started_at, completed_at, duration_ms, warnings, errors
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      `,
      [
        collectionRunId,
        input.managerId,
        input.status,
        input.apiVersion ?? null,
        input.startedAt,
        completedAt,
        durationMs,
        stringifyJson(input.warnings ?? []),
        stringifyJson(input.errors ?? [])
      ]
    );

    await clearCurrentInventory(client, input.managerId);
    await insertInfrastructure(client, input, lastSeenAt);

    for (const vm of input.resources.vms ?? []) {
      await insertVm(client, input.managerId, vm, lastSeenAt);
      await insertVmOwnership(client, input.managerId, vm);
      await insertVmTags(client, input.managerId, vm);
      await insertVmChildren(client, input.managerId, vm, lastSeenAt);
      await appendHistory(client, {
        managerId: input.managerId,
        collectionRunId,
        resourceType: "vm",
        resourceId: vm.vmId,
        collectedAt: lastSeenAt,
        payload: vm
      });
    }

    await insertAffinityGroups(client, input, lastSeenAt);
    await insertEvents(client, input);

    return {
      collectionRunId,
      vmCount: input.resources.vms?.length ?? 0
    };
  });
}

async function withTransaction<T>(db: ConnectablePostgres, work: (client: TransactionClient) => Promise<T>): Promise<T> {
  const client: TransactionClient = db.connect ? await db.connect() : db;
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release?.();
  }
}

async function clearCurrentInventory(client: PostgresQueryable, managerId: string): Promise<void> {
  const tables = [
    "affinity_group_vms",
    "affinity_groups",
    "vm_tags",
    "vm_snapshots",
    "vm_disks",
    "vm_nics",
    "vm_ownership",
    "vms",
    "vnic_profiles",
    "logical_networks",
    "storage_domains",
    "hosts",
    "clusters",
    "data_centers"
  ];

  for (const table of tables) {
    await client.query(`DELETE FROM ${table} WHERE manager_id = $1`, [managerId]);
  }
}

async function insertInfrastructure(client: PostgresQueryable, input: InventorySyncInput, lastSeenAt: string): Promise<void> {
  for (const item of input.resources.dataCenters ?? []) {
    await client.query(
      `
        INSERT INTO data_centers (manager_id, data_center_id, name, status, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [input.managerId, item.dataCenterId, item.name, item.status ?? null, lastSeenAt, stringifyJson(item.raw ?? item)]
    );
  }

  for (const item of input.resources.clusters ?? []) {
    await client.query(
      `
        INSERT INTO clusters (manager_id, cluster_id, data_center_id, name, cpu_type, version, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        input.managerId,
        item.clusterId,
        item.dataCenterId ?? null,
        item.name,
        item.cpuType ?? null,
        item.version ?? null,
        lastSeenAt,
        stringifyJson(item.raw ?? item)
      ]
    );
  }

  for (const item of input.resources.hosts ?? []) {
    await client.query(
      `
        INSERT INTO hosts (manager_id, host_id, cluster_id, name, status, maintenance, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        input.managerId,
        item.hostId,
        item.clusterId ?? null,
        item.name,
        item.status ?? null,
        item.maintenance ?? null,
        lastSeenAt,
        stringifyJson(item.raw ?? item)
      ]
    );
  }

  for (const item of input.resources.storageDomains ?? []) {
    await client.query(
      `
        INSERT INTO storage_domains (
          manager_id, storage_domain_id, data_center_id, name, status, storage_type,
          total_bytes, used_bytes, available_bytes, last_seen_at, raw_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      `,
      [
        input.managerId,
        item.storageDomainId,
        item.dataCenterId ?? null,
        item.name,
        item.status ?? null,
        item.storageType ?? null,
        item.totalBytes ?? null,
        item.usedBytes ?? null,
        item.availableBytes ?? null,
        lastSeenAt,
        stringifyJson(item.raw ?? item)
      ]
    );
  }

  for (const item of input.resources.logicalNetworks ?? []) {
    await client.query(
      `
        INSERT INTO logical_networks (manager_id, network_id, data_center_id, name, vlan_id, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [input.managerId, item.networkId, item.dataCenterId ?? null, item.name, item.vlanId ?? null, lastSeenAt, stringifyJson(item.raw ?? item)]
    );
  }

  for (const item of input.resources.vnicProfiles ?? []) {
    await client.query(
      `
        INSERT INTO vnic_profiles (manager_id, vnic_profile_id, network_id, name, qos, port_mirroring, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        input.managerId,
        item.vnicProfileId,
        item.networkId ?? null,
        item.name,
        item.qos ?? null,
        item.portMirroring ?? null,
        lastSeenAt,
        stringifyJson(item.raw ?? item)
      ]
    );
  }
}

async function insertVm(client: PostgresQueryable, managerId: string, vm: VmRecord, lastSeenAt: string): Promise<void> {
  await client.query(
    `
      INSERT INTO vms (
        manager_id, vm_id, name, description, comment, created_at, last_seen_at, status, status_detail,
        cluster_id, cluster_name, data_center_id, data_center_name, host_id, host_name, preferred_host,
        migration_policy, last_started_at, last_stopped_at, uptime_seconds, ha_enabled, ha_priority,
        watchdog_type, watchdog_action, migration_count_30d, vcpus, sockets, cores_per_socket,
        threads_per_core, cpu_profile, cpu_pinning, numa_pinning, memory_mb, max_memory_mb,
        guaranteed_memory_mb, memory_ballooning, hugepages, os_type, guest_os_name, guest_os_version,
        kernel_version, hostname, fqdn, guest_agent_status, guest_agent_version, last_guest_agent_update,
        bios_type, secure_boot, boot_order, health_score, health_deductions, raw_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22,
        $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33, $34,
        $35, $36, $37, $38, $39, $40,
        $41, $42, $43, $44, $45, $46,
        $47, $48, $49::jsonb, $50, $51::jsonb, $52::jsonb
      )
    `,
    [
      managerId,
      vm.vmId,
      vm.name,
      vm.description ?? null,
      vm.comment ?? null,
      vm.createdAt ?? null,
      lastSeenAt,
      vm.status ?? null,
      vm.statusDetail ?? null,
      vm.clusterId ?? null,
      vm.clusterName ?? null,
      vm.dataCenterId ?? null,
      vm.dataCenterName ?? null,
      vm.hostId ?? null,
      vm.hostName ?? null,
      vm.preferredHost ?? null,
      vm.migrationPolicy ?? null,
      vm.lastStartedAt ?? null,
      vm.lastStoppedAt ?? null,
      vm.uptimeSeconds ?? null,
      vm.haEnabled ?? null,
      vm.haPriority ?? null,
      vm.watchdogType ?? null,
      vm.watchdogAction ?? null,
      vm.migrationCount30d ?? null,
      vm.vcpus ?? null,
      vm.sockets ?? null,
      vm.coresPerSocket ?? null,
      vm.threadsPerCore ?? null,
      vm.cpuProfile ?? null,
      vm.cpuPinning ?? null,
      vm.numaPinning ?? null,
      vm.memoryMb ?? null,
      vm.maxMemoryMb ?? null,
      vm.guaranteedMemoryMb ?? null,
      vm.memoryBallooning ?? null,
      vm.hugepages ?? null,
      vm.osType ?? null,
      vm.guestOsName ?? null,
      vm.guestOsVersion ?? null,
      vm.kernelVersion ?? null,
      vm.hostname ?? null,
      vm.fqdn ?? null,
      vm.guestAgentStatus ?? null,
      vm.guestAgentVersion ?? null,
      vm.lastGuestAgentUpdate ?? null,
      vm.biosType ?? null,
      vm.secureBoot ?? null,
      stringifyJson(vm.bootOrder ?? []),
      vm.healthScore ?? null,
      stringifyJson(vm.healthDeductions ?? []),
      stringifyJson(vm.raw ?? vm)
    ]
  );
}

async function insertVmOwnership(client: PostgresQueryable, managerId: string, vm: VmRecord): Promise<void> {
  await client.query(
    `
      INSERT INTO vm_ownership (
        manager_id, vm_id, environment, application, service_role, owner, on_call_group,
        cost_center, criticality, cmdb_ci_id, ticket_reference, backup_policy, backup_status,
        last_backup_success_at, last_backup_attempt_at, rpo_target_hours, rpo_actual_hours,
        rto_target_hours, last_restore_test_at, backup_excluded_disks, os_eol_date, last_patch_at,
        edr_status, vulnerability_critical_count, public_ip, lifecycle_status, retire_date,
        monthly_estimated_cost
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20::jsonb, $21, $22,
        $23, $24, $25, $26, $27,
        $28
      )
    `,
    [
      managerId,
      vm.vmId,
      vm.environment ?? null,
      vm.application ?? null,
      vm.serviceRole ?? null,
      vm.owner ?? null,
      vm.onCallGroup ?? null,
      vm.costCenter ?? null,
      vm.criticality ?? null,
      vm.cmdbCiId ?? null,
      vm.ticketReference ?? null,
      vm.backupPolicy ?? null,
      vm.backupStatus ?? null,
      vm.lastBackupSuccessAt ?? null,
      vm.lastBackupAttemptAt ?? null,
      vm.rpoTargetHours ?? null,
      vm.rpoActualHours ?? null,
      vm.rtoTargetHours ?? null,
      vm.lastRestoreTestAt ?? null,
      stringifyJson(vm.backupExcludedDisks ?? []),
      vm.osEolDate ?? null,
      vm.lastPatchAt ?? null,
      vm.edrStatus ?? null,
      vm.vulnerabilityCriticalCount ?? null,
      vm.publicIp ?? null,
      vm.lifecycleStatus ?? null,
      vm.retireDate ?? null,
      vm.monthlyEstimatedCost ?? null
    ]
  );
}

async function insertVmTags(client: PostgresQueryable, managerId: string, vm: VmRecord): Promise<void> {
  for (const tag of vm.tags ?? []) {
    await client.query("INSERT INTO tags (manager_id, tag_name, raw_json) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING", [
      managerId,
      tag,
      stringifyJson({ name: tag })
    ]);
    await client.query("INSERT INTO vm_tags (manager_id, vm_id, tag_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      managerId,
      vm.vmId,
      tag
    ]);
  }
}

async function insertVmChildren(client: PostgresQueryable, managerId: string, vm: VmRecord, lastSeenAt: string): Promise<void> {
  for (const nic of vm.nics ?? []) {
    await client.query(
      `
        INSERT INTO vm_nics (
          manager_id, vm_id, nic_id, nic_name, mac_address, vnic_profile_id, vnic_profile,
          logical_network, vlan_id, interface_type, linked, ipv4_addresses, ipv6_addresses,
          network_filter, qos, port_mirroring, last_seen_at, raw_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18::jsonb)
      `,
      [
        managerId,
        vm.vmId,
        nic.nicId,
        nic.name,
        nic.macAddress ?? null,
        nic.vnicProfileId ?? null,
        nic.vnicProfile ?? null,
        nic.logicalNetwork ?? null,
        nic.vlanId ?? null,
        nic.interfaceType ?? null,
        nic.linked ?? null,
        stringifyJson(nic.ipv4Addresses ?? []),
        stringifyJson(nic.ipv6Addresses ?? []),
        nic.networkFilter ?? null,
        nic.qos ?? null,
        nic.portMirroring ?? null,
        lastSeenAt,
        stringifyJson(nic.raw ?? nic)
      ]
    );
  }

  for (const disk of vm.disks ?? []) {
    await client.query(
      `
        INSERT INTO vm_disks (
          manager_id, vm_id, disk_id, alias, storage_domain_id, storage_domain, disk_format,
          provisioned_size_gib, actual_size_gib, interface, bootable, shareable,
          backup_included, disk_profile, direct_lun, encrypted, last_seen_at, raw_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
      `,
      [
        managerId,
        vm.vmId,
        disk.diskId,
        disk.alias,
        disk.storageDomainId ?? null,
        disk.storageDomain ?? null,
        disk.diskFormat ?? null,
        disk.provisionedSizeGib ?? null,
        disk.actualSizeGib ?? null,
        disk.interface ?? null,
        disk.bootable ?? null,
        disk.shareable ?? null,
        disk.backupIncluded ?? null,
        disk.diskProfile ?? null,
        disk.directLun ?? null,
        disk.encrypted ?? null,
        lastSeenAt,
        stringifyJson(disk.raw ?? disk)
      ]
    );
  }

  for (const snapshot of vm.snapshots ?? []) {
    await client.query(
      `
        INSERT INTO vm_snapshots (
          manager_id, vm_id, snapshot_id, description, created_at, status, snapshot_type,
          age_days, size_gib, creator, ticket_reference, last_seen_at, raw_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      `,
      [
        managerId,
        vm.vmId,
        snapshot.snapshotId,
        snapshot.description ?? null,
        snapshot.createdAt ?? null,
        snapshot.status ?? null,
        snapshot.snapshotType ?? null,
        snapshot.ageDays ?? null,
        snapshot.sizeGib ?? null,
        snapshot.creator ?? null,
        snapshot.ticketReference ?? null,
        lastSeenAt,
        stringifyJson(snapshot.raw ?? snapshot)
      ]
    );
  }
}

async function insertAffinityGroups(client: PostgresQueryable, input: InventorySyncInput, lastSeenAt: string): Promise<void> {
  for (const group of input.resources.affinityGroups ?? []) {
    await client.query(
      `
        INSERT INTO affinity_groups (manager_id, affinity_group_id, name, enforcing, positive, last_seen_at, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        input.managerId,
        group.affinityGroupId,
        group.name,
        group.enforcing ?? null,
        group.positive ?? null,
        lastSeenAt,
        stringifyJson(group.raw ?? group)
      ]
    );

    for (const vmId of group.vmIds ?? []) {
      await client.query("INSERT INTO affinity_group_vms (manager_id, affinity_group_id, vm_id) VALUES ($1, $2, $3)", [
        input.managerId,
        group.affinityGroupId,
        vmId
      ]);
    }
  }
}

async function insertEvents(client: PostgresQueryable, input: InventorySyncInput): Promise<void> {
  for (const event of input.resources.events ?? []) {
    await client.query(
      `
        INSERT INTO events (manager_id, event_id, event_time, severity, resource_type, resource_id, message, raw_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (manager_id, event_id) DO NOTHING
      `,
      [
        input.managerId,
        event.eventId,
        event.eventTime,
        event.severity ?? null,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.message,
        stringifyJson(event.raw ?? event)
      ]
    );
  }
}

async function appendHistory(
  client: PostgresQueryable,
  input: {
    managerId: string;
    collectionRunId: string;
    resourceType: string;
    resourceId: string;
    collectedAt: string;
    payload: unknown;
  }
): Promise<QueryResult> {
  return client.query(
    `
      INSERT INTO inventory_history (
        id, manager_id, collection_run_id, resource_type, resource_id, collected_at, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [randomUUID(), input.managerId, input.collectionRunId, input.resourceType, input.resourceId, input.collectedAt, stringifyJson(input.payload)]
  );
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
