import type { AppRole } from "../rbac.js";
import { redactInventoryFields } from "../rbac.js";
import type { PostgresQueryable } from "./migrate.js";

export interface VmInventoryFilters {
  managerId?: string;
  datacenter?: string;
  cluster?: string;
  host?: string;
  storageDomain?: string;
  logicalNetwork?: string;
  vnicProfile?: string;
  status?: string;
  ha?: boolean;
  environment?: string;
  owner?: string;
  application?: string;
  criticality?: string;
  costCenter?: string;
  tag?: string;
  os?: string;
  guestAgentStatus?: string;
  backupStatus?: string;
  rpoBreach?: boolean;
  snapshotAgeOverDays?: number;
  createdFrom?: string;
  createdTo?: string;
  lastSeenFrom?: string;
  lastSeenTo?: string;
  lifecycleStatus?: string;
  missingMetadata?: boolean;
  missingBackup?: boolean;
  unknownIp?: boolean;
  idle?: boolean;
}

export interface VmInventoryQuery {
  page: number;
  pageSize: number;
  filters: VmInventoryFilters;
  columns: string[];
}

export interface VmInventoryListItem extends Record<string, unknown> {
  managerId: string;
  vmId: string;
  name: string;
  status?: string;
  environment?: string;
  application?: string;
  owner?: string;
  criticality?: string;
  costCenter?: string;
  dataCenterId?: string;
  dataCenterName?: string;
  clusterId?: string;
  clusterName?: string;
  hostId?: string;
  hostName?: string;
  osType?: string;
  guestOsName?: string;
  guestOsVersion?: string;
  vcpus?: number;
  memoryMb?: number;
  cpuP95?: number;
  memoryP95?: number;
  storageUsedGib?: number;
  storageProvisionedGib?: number;
  backupStatus?: string;
  snapshotCount?: number;
  oldestSnapshotAgeDays?: number;
  guestAgentStatus?: string;
  ipAddress?: string;
  lastSeenAt: string;
  healthScore?: number;
  healthDeductions?: unknown[];
  lifecycleStatus?: string;
  publicIp?: string;
  vulnerabilityCriticalCount?: number;
  monthlyEstimatedCost?: number;
  tags?: string[];
}

export interface VmInventoryResult {
  rows: VmInventoryListItem[];
  page: number;
  pageSize: number;
  total: number;
  columns: string[];
  filters: VmInventoryFilters;
}

interface VmInventoryRow {
  manager_id: string;
  vm_id: string;
  name: string;
  status: string | null;
  environment: string | null;
  application: string | null;
  owner: string | null;
  criticality: string | null;
  cost_center: string | null;
  data_center_id: string | null;
  data_center_name: string | null;
  cluster_id: string | null;
  cluster_name: string | null;
  host_id: string | null;
  host_name: string | null;
  os_type: string | null;
  guest_os_name: string | null;
  guest_os_version: string | null;
  vcpus: number | null;
  memory_mb: number | null;
  backup_status: string | null;
  guest_agent_status: string | null;
  public_ip: string | null;
  last_seen_at: Date | string;
  health_score: number | null;
  health_deductions: unknown;
  lifecycle_status: string | null;
  vulnerability_critical_count: number | null;
  monthly_estimated_cost: string | number | null;
}

export const defaultInventoryColumns = [
  "name",
  "status",
  "environment",
  "application",
  "owner",
  "criticality",
  "datacenter",
  "cluster",
  "host",
  "os",
  "vcpus",
  "memoryMb",
  "cpuP95",
  "memoryP95",
  "storage",
  "backupStatus",
  "snapshot",
  "guestAgentStatus",
  "ipAddress",
  "lastSeenAt",
  "healthScore"
];

export async function queryVmInventory(db: PostgresQueryable, query: VmInventoryQuery, role: AppRole): Promise<VmInventoryResult> {
  const sql = buildInventorySql(query.filters);
  const pageSize = Math.min(Math.max(query.pageSize, 1), 500);
  const page = Math.max(query.page, 1);
  const offset = (page - 1) * pageSize;

  const count = await db.query<{ count: string | number }>(`SELECT COUNT(DISTINCT v.vm_id) AS count ${sql.fromWhere}`, sql.values);
  const rows = await db.query<VmInventoryRow>(
    `
      SELECT DISTINCT
        v.manager_id,
        v.vm_id,
        v.name,
        v.status,
        o.environment,
        o.application,
        o.owner,
        o.criticality,
        o.cost_center,
        v.data_center_id,
        v.data_center_name,
        v.cluster_id,
        v.cluster_name,
        v.host_id,
        v.host_name,
        v.os_type,
        v.guest_os_name,
        v.guest_os_version,
        v.vcpus,
        v.memory_mb,
        o.backup_status,
        v.guest_agent_status,
        o.public_ip,
        v.last_seen_at,
        v.health_score,
        v.health_deductions,
        o.lifecycle_status,
        o.vulnerability_critical_count,
        o.monthly_estimated_cost
      ${sql.fromWhere}
      ORDER BY LOWER(v.name) ASC
      LIMIT $${sql.values.length + 1}
      OFFSET $${sql.values.length + 2}
    `,
    [...sql.values, pageSize, offset]
  );

  const items = rows.rows.map(mapInventoryRow);
  await attachTagsAndIps(db, items);

  return {
    rows: items.map((item) => redactInventoryFields(role, item)),
    page,
    pageSize,
    total: Number(count.rows[0]?.count ?? 0),
    columns: query.columns.length ? query.columns : defaultInventoryColumns,
    filters: query.filters
  };
}

function buildInventorySql(filters: VmInventoryFilters): { fromWhere: string; values: unknown[] } {
  const values: unknown[] = [];
  const conditions = ["1 = 1"];
  const joins = ["LEFT JOIN vm_ownership o ON o.manager_id = v.manager_id AND o.vm_id = v.vm_id"];
  const add = (condition: string, value: unknown): void => {
    values.push(value);
    conditions.push(condition.replace("?", `$${values.length}`));
  };

  if (filters.managerId) {
    add("v.manager_id = ?", filters.managerId);
  }
  if (filters.datacenter) {
    add("(v.data_center_id = ? OR v.data_center_name = ?)", filters.datacenter);
    values.push(filters.datacenter);
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replace("?", `$${values.length}`);
  }
  if (filters.cluster) {
    add("(v.cluster_id = ? OR v.cluster_name = ?)", filters.cluster);
    values.push(filters.cluster);
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replace("?", `$${values.length}`);
  }
  if (filters.host) {
    add("(v.host_id = ? OR v.host_name = ?)", filters.host);
    values.push(filters.host);
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replace("?", `$${values.length}`);
  }
  if (filters.status) {
    add("v.status = ?", filters.status);
  }
  if (filters.ha !== undefined) {
    add("v.ha_enabled = ?", filters.ha);
  }
  if (filters.environment) {
    add("o.environment = ?", filters.environment);
  }
  if (filters.owner) {
    add("o.owner = ?", filters.owner);
  }
  if (filters.application) {
    add("o.application = ?", filters.application);
  }
  if (filters.criticality) {
    add("o.criticality = ?", filters.criticality);
  }
  if (filters.costCenter) {
    add("o.cost_center = ?", filters.costCenter);
  }
  if (filters.guestAgentStatus) {
    add("v.guest_agent_status = ?", filters.guestAgentStatus);
  }
  if (filters.backupStatus) {
    add("o.backup_status = ?", filters.backupStatus);
  }
  if (filters.lifecycleStatus) {
    add("o.lifecycle_status = ?", filters.lifecycleStatus);
  }
  if (filters.os) {
    add("(v.os_type = ? OR v.guest_os_name = ? OR v.guest_os_version = ?)", filters.os);
    values.push(filters.os, filters.os);
    conditions[conditions.length - 1] = conditions[conditions.length - 1]
      .replace("?", `$${values.length - 1}`)
      .replace("?", `$${values.length}`);
  }
  if (filters.createdFrom) {
    add("v.created_at >= ?", filters.createdFrom);
  }
  if (filters.createdTo) {
    add("v.created_at <= ?", filters.createdTo);
  }
  if (filters.lastSeenFrom) {
    add("v.last_seen_at >= ?", filters.lastSeenFrom);
  }
  if (filters.lastSeenTo) {
    add("v.last_seen_at <= ?", filters.lastSeenTo);
  }
  if (filters.storageDomain) {
    values.push(filters.storageDomain);
    const first = `$${values.length}`;
    values.push(filters.storageDomain);
    const second = `$${values.length}`;
    joins.push(
      `JOIN vm_disks filter_disk ON filter_disk.manager_id = v.manager_id AND filter_disk.vm_id = v.vm_id AND (filter_disk.storage_domain_id = ${first} OR filter_disk.storage_domain = ${second})`
    );
  }
  if (filters.logicalNetwork) {
    values.push(filters.logicalNetwork);
    joins.push(
      `JOIN vm_nics filter_network ON filter_network.manager_id = v.manager_id AND filter_network.vm_id = v.vm_id AND filter_network.logical_network = $${values.length}`
    );
  }
  if (filters.vnicProfile) {
    values.push(filters.vnicProfile);
    const first = `$${values.length}`;
    values.push(filters.vnicProfile);
    const second = `$${values.length}`;
    joins.push(
      `JOIN vm_nics filter_vnic ON filter_vnic.manager_id = v.manager_id AND filter_vnic.vm_id = v.vm_id AND (filter_vnic.vnic_profile_id = ${first} OR filter_vnic.vnic_profile = ${second})`
    );
  }
  if (filters.tag) {
    values.push(filters.tag);
    joins.push(
      `JOIN vm_tags filter_tag ON filter_tag.manager_id = v.manager_id AND filter_tag.vm_id = v.vm_id AND filter_tag.tag_name = $${values.length}`
    );
  }
  if (filters.rpoBreach) {
    conditions.push("o.rpo_actual_hours IS NOT NULL AND o.rpo_target_hours IS NOT NULL AND o.rpo_actual_hours > o.rpo_target_hours");
  }
  if (filters.snapshotAgeOverDays !== undefined) {
    values.push(filters.snapshotAgeOverDays);
    joins.push(
      `JOIN vm_snapshots filter_snapshot ON filter_snapshot.manager_id = v.manager_id AND filter_snapshot.vm_id = v.vm_id AND filter_snapshot.age_days >= $${values.length}`
    );
  }
  if (filters.missingMetadata) {
    conditions.push("(o.owner IS NULL OR o.environment IS NULL OR o.application IS NULL OR o.criticality IS NULL)");
  }
  if (filters.missingBackup) {
    conditions.push("(o.backup_status IS NULL OR o.backup_status IN ('missing', 'unprotected', 'failed'))");
  }
  if (filters.unknownIp) {
    conditions.push("o.public_ip IS NULL");
  }
  if (filters.idle) {
    conditions.push("o.lifecycle_status IN ('idle', 'retirement_candidate')");
  }

  return {
    fromWhere: `
      FROM vms v
      ${joins.join("\n")}
      WHERE ${conditions.join(" AND ")}
    `,
    values
  };
}

async function attachTagsAndIps(db: PostgresQueryable, items: VmInventoryListItem[]): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const ids = [...new Set(items.map((item) => item.vmId))];
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  const tags = await db.query<{ vm_id: string; tag_name: string }>(
    `SELECT vm_id, tag_name FROM vm_tags WHERE vm_id IN (${placeholders}) ORDER BY tag_name`,
    ids
  );
  const nics = await db.query<{ vm_id: string; ipv4_addresses: unknown; ipv6_addresses: unknown }>(
    `SELECT vm_id, ipv4_addresses, ipv6_addresses FROM vm_nics WHERE vm_id IN (${placeholders})`,
    ids
  );
  const disks = await db.query<{ vm_id: string; actual_size_gib: string | number | null; provisioned_size_gib: string | number | null }>(
    `SELECT vm_id, actual_size_gib, provisioned_size_gib FROM vm_disks WHERE vm_id IN (${placeholders})`,
    ids
  );
  const snapshots = await db.query<{ vm_id: string; age_days: number | null }>(
    `SELECT vm_id, age_days FROM vm_snapshots WHERE vm_id IN (${placeholders})`,
    ids
  );

  const byId = new Map(items.map((item) => [item.vmId, item]));
  for (const item of items) {
    item.storageUsedGib = 0;
    item.storageProvisionedGib = 0;
    item.snapshotCount = 0;
  }
  for (const row of tags.rows) {
    const item = byId.get(row.vm_id);
    if (item) {
      item.tags = [...(item.tags ?? []), row.tag_name];
    }
  }
  for (const row of nics.rows) {
    const item = byId.get(row.vm_id);
    if (item && !item.ipAddress) {
      item.ipAddress = firstString(row.ipv4_addresses) ?? firstString(row.ipv6_addresses);
    }
  }
  for (const row of disks.rows) {
    const item = byId.get(row.vm_id);
    if (item) {
      item.storageUsedGib = (item.storageUsedGib ?? 0) + Number(row.actual_size_gib ?? 0);
      item.storageProvisionedGib = (item.storageProvisionedGib ?? 0) + Number(row.provisioned_size_gib ?? 0);
    }
  }
  for (const row of snapshots.rows) {
    const item = byId.get(row.vm_id);
    if (item) {
      item.snapshotCount = (item.snapshotCount ?? 0) + 1;
      item.oldestSnapshotAgeDays =
        row.age_days === null ? item.oldestSnapshotAgeDays : Math.max(item.oldestSnapshotAgeDays ?? 0, row.age_days);
    }
  }
}

function mapInventoryRow(row: VmInventoryRow): VmInventoryListItem {
  return {
    managerId: row.manager_id,
    vmId: row.vm_id,
    name: row.name,
    status: row.status ?? undefined,
    environment: row.environment ?? undefined,
    application: row.application ?? undefined,
    owner: row.owner ?? undefined,
    criticality: row.criticality ?? undefined,
    costCenter: row.cost_center ?? undefined,
    dataCenterId: row.data_center_id ?? undefined,
    dataCenterName: row.data_center_name ?? undefined,
    clusterId: row.cluster_id ?? undefined,
    clusterName: row.cluster_name ?? undefined,
    hostId: row.host_id ?? undefined,
    hostName: row.host_name ?? undefined,
    osType: row.os_type ?? undefined,
    guestOsName: row.guest_os_name ?? undefined,
    guestOsVersion: row.guest_os_version ?? undefined,
    vcpus: row.vcpus ?? undefined,
    memoryMb: row.memory_mb ?? undefined,
    cpuP95: undefined,
    memoryP95: undefined,
    storageUsedGib: 0,
    storageProvisionedGib: 0,
    backupStatus: row.backup_status ?? undefined,
    snapshotCount: 0,
    guestAgentStatus: row.guest_agent_status ?? undefined,
    publicIp: row.public_ip ?? undefined,
    ipAddress: row.public_ip ?? undefined,
    lastSeenAt: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at),
    healthScore: row.health_score ?? undefined,
    healthDeductions: Array.isArray(row.health_deductions) ? row.health_deductions : [],
    lifecycleStatus: row.lifecycle_status ?? undefined,
    vulnerabilityCriticalCount: row.vulnerability_critical_count ?? undefined,
    monthlyEstimatedCost: row.monthly_estimated_cost === null ? undefined : Number(row.monthly_estimated_cost)
  };
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && item.length > 0);
  }
  return undefined;
}
