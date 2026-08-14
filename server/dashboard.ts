import type { FastifyInstance } from "fastify";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";
import {
  emptyInventoryResources,
  resourceKeys,
  type InventoryResource,
  type InventoryResources,
  type SnapshotStatus
} from "../shared/snapshot.js";

interface ManagerRow {
  id: string;
  name: string;
  url: string;
  enabled: number;
}

interface SnapshotRow {
  id: string;
  manager_id: string;
  collected_at: string;
  status: SnapshotStatus;
  resources_json: string;
  warnings_json: string;
  errors_json: string;
}

export interface DashboardResponse {
  totals: {
    managers: number;
    clusters: number;
    hosts: number;
    vms: number;
    storageDomains: number;
    disks: number;
    networks: number;
  };
  clusters: DashboardClusterSummary[];
  vmStatuses: Record<string, number>;
  hostStatuses: Record<string, number>;
  managers: Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    lastSnapshotId?: string;
    latestInventorySnapshotId?: string;
    freshness?: string;
    lastStatus?: SnapshotStatus;
    resourceCounts: Record<(typeof resourceKeys)[number], number>;
    warningsCount: number;
    errorsCount: number;
  }>;
}

export interface DashboardClusterSummary {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  clusterId: string;
  name: string;
  dataCenterId?: string;
  dataCenterName?: string;
  version?: string;
  cpuType?: string;
  hostCount: number;
  vmCount: number;
  storageDomainCount: number;
}

export interface DashboardClusterDetail extends DashboardClusterSummary {
  vms: DashboardClusterVm[];
}

export interface DashboardClusterVm {
  vmId: string;
  name: string;
  environment?: string;
  powerState?: string;
  host?: string;
  guestOs?: string;
  ipAddress?: string;
  vcpuCount?: number;
  allocatedRamMiB?: number;
  storageAllocatedGiB?: number;
  storageUsedGiB?: number;
}

export function registerDashboardRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/dashboard", { preHandler: requireRole(roles.read) }, async () => dashboard(db));
  app.get("/api/dashboard/clusters/:managerId/:clusterId", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const params = parseClusterParams(request.params);
    const detail = params ? clusterDetail(db, params.managerId, params.clusterId) : undefined;
    if (!detail) {
      return reply.code(404).send({ error: "Cluster not found" });
    }
    return { cluster: detail };
  });
}

export function dashboard(db: SqliteDatabase): DashboardResponse {
  const managers = db.prepare("SELECT id, name, url, enabled FROM managers ORDER BY name COLLATE NOCASE").all() as ManagerRow[];
  const summaries = managers.map((manager) => managerDashboard(db, manager));
  const totals = {
    managers: managers.length,
    clusters: sum(summaries, "clusters"),
    hosts: sum(summaries, "hosts"),
    vms: sum(summaries, "vms"),
    storageDomains: sum(summaries, "storageDomains"),
    disks: sum(summaries, "disks"),
    networks: sum(summaries, "networks")
  };

  return {
    totals,
    clusters: clusterSummaries(db, managers),
    vmStatuses: aggregateStatuses(db, "vms"),
    hostStatuses: aggregateStatuses(db, "hosts"),
    managers: summaries
  };
}

function managerDashboard(db: SqliteDatabase, manager: ManagerRow): DashboardResponse["managers"][number] {
  const latestAny = latestSnapshot(db, manager.id);
  const latestInventory = latestSnapshot(db, manager.id, ["success", "partial"]);
  const resources = latestInventory ? (JSON.parse(latestInventory.resources_json) as InventoryResources) : emptyResources();
  const resourceCounts = Object.fromEntries(resourceKeys.map((key) => [key, resources[key].length])) as Record<
    (typeof resourceKeys)[number],
    number
  >;

  return {
    id: manager.id,
    name: manager.name,
    url: manager.url,
    enabled: Boolean(manager.enabled),
    lastSnapshotId: latestAny?.id,
    latestInventorySnapshotId: latestInventory?.id,
    freshness: latestInventory?.collected_at,
    lastStatus: latestAny?.status,
    resourceCounts,
    warningsCount: latestAny ? JSON.parse(latestAny.warnings_json).length : 0,
    errorsCount: latestAny ? JSON.parse(latestAny.errors_json).length : 0
  };
}

export function clusterDetail(db: SqliteDatabase, managerId: string, clusterId: string): DashboardClusterDetail | undefined {
  const manager = db.prepare("SELECT id, name, url, enabled FROM managers WHERE id = ?").get(managerId) as ManagerRow | undefined;
  if (!manager) {
    return undefined;
  }

  const snapshot = latestSnapshot(db, manager.id, ["success", "partial"]);
  if (!snapshot) {
    return undefined;
  }

  const resources = parseResources(snapshot);
  const cluster = resources.clusters.find((item) => stringValue(item.id) === clusterId);
  if (!cluster) {
    return undefined;
  }

  const summary = clusterSummary(manager, snapshot, resources, cluster);
  if (!summary) {
    return undefined;
  }

  const hostNamesById = hostNames(resources);
  return {
    ...summary,
    vms: resources.vms.filter((vm) => refId(vm.cluster) === summary.clusterId).map((vm) => vmDetail(vm, hostNamesById))
  };
}

function clusterSummaries(db: SqliteDatabase, managers: ManagerRow[]): DashboardClusterSummary[] {
  return managers.flatMap((manager) => {
    const snapshot = latestSnapshot(db, manager.id, ["success", "partial"]);
    if (!snapshot) {
      return [];
    }
    const resources = parseResources(snapshot);
    return resources.clusters
      .map((cluster) => clusterSummary(manager, snapshot, resources, cluster))
      .filter((cluster): cluster is DashboardClusterSummary => Boolean(cluster));
  });
}

function clusterSummary(
  manager: ManagerRow,
  snapshot: SnapshotRow,
  resources: InventoryResources,
  cluster: InventoryResource
): DashboardClusterSummary | undefined {
  const clusterId = stringValue(cluster.id);
  const name = stringValue(cluster.name) ?? clusterId;
  if (!clusterId || !name) {
    return undefined;
  }

  const dataCenterId = refId(cluster.data_center);
  return {
    managerId: manager.id,
    managerName: manager.name,
    managerUrl: manager.url,
    snapshotId: snapshot.id,
    collectedAt: snapshot.collected_at,
    clusterId,
    name,
    dataCenterId,
    dataCenterName: dataCenterName(resources, dataCenterId),
    version: versionString(cluster.version),
    cpuType: stringValue(recordValue(cluster.cpu)?.type),
    hostCount: resources.hosts.filter((host) => refId(host.cluster) === clusterId).length,
    vmCount: resources.vms.filter((vm) => refId(vm.cluster) === clusterId).length,
    storageDomainCount: storageDomainCount(resources, dataCenterId)
  };
}

function vmDetail(vm: InventoryResource, hostNamesById: Map<string, string>): DashboardClusterVm {
  const vmId = stringValue(vm.id) ?? stringValue(vm.name) ?? "unknown";
  const diskTotals = vmDiskTotals(vm);
  const hostId = refId(vm.host);
  return {
    vmId,
    name: stringValue(vm.name) ?? vmId,
    environment: vmEnvironment(vm),
    powerState: stringValue(vm.status),
    host: refName(vm.host) ?? (hostId ? hostNamesById.get(hostId) ?? "Unknown host" : undefined),
    guestOs: guestOs(vm),
    ipAddress: firstIpAddress(vm),
    vcpuCount: cpuTotal(recordValue(recordValue(vm.cpu)?.topology)),
    allocatedRamMiB: bytesToMiB(vm.memory),
    storageAllocatedGiB: diskTotals.allocated,
    storageUsedGiB: diskTotals.used
  };
}

function hostNames(resources: InventoryResources): Map<string, string> {
  return new Map(
    resources.hosts.flatMap((host) => {
      const id = stringValue(host.id);
      const name = stringValue(host.name);
      return id && name ? [[id, name]] : [];
    })
  );
}

function latestSnapshot(db: SqliteDatabase, managerId: string, statuses?: SnapshotStatus[]): SnapshotRow | undefined {
  if (statuses?.length) {
    const placeholders = statuses.map(() => "?").join(", ");
    return db
      .prepare(
        `SELECT * FROM snapshots
         WHERE manager_id = ? AND status IN (${placeholders})
         ORDER BY collected_at DESC, created_at DESC LIMIT 1`
      )
      .get(managerId, ...statuses) as SnapshotRow | undefined;
  }

  return db
    .prepare("SELECT * FROM snapshots WHERE manager_id = ? ORDER BY collected_at DESC, created_at DESC LIMIT 1")
    .get(managerId) as SnapshotRow | undefined;
}

function aggregateStatuses(db: SqliteDatabase, resourceKey: "hosts" | "vms"): Record<string, number> {
  const result: Record<string, number> = {};
  const managers = db.prepare("SELECT id FROM managers").all() as Array<{ id: string }>;
  for (const manager of managers) {
    const snapshot = latestSnapshot(db, manager.id, ["success", "partial"]);
    if (!snapshot) {
      continue;
    }
    const resources = JSON.parse(snapshot.resources_json) as InventoryResources;
    for (const item of resources[resourceKey]) {
      const status = typeof item.status === "string" && item.status ? item.status : "unknown";
      result[status] = (result[status] ?? 0) + 1;
    }
  }
  return result;
}

function parseResources(snapshot: SnapshotRow): InventoryResources {
  return JSON.parse(snapshot.resources_json) as InventoryResources;
}

function dataCenterName(resources: InventoryResources, dataCenterId: string | undefined): string | undefined {
  if (!dataCenterId) {
    return undefined;
  }
  const dataCenter = resources.dataCenters.find((item) => stringValue(item.id) === dataCenterId);
  return stringValue(dataCenter?.name);
}

function storageDomainCount(resources: InventoryResources, dataCenterId: string | undefined): number {
  if (dataCenterId) {
    const sameDataCenter = resources.storageDomains.filter((domain) => refId(domain.data_center) === dataCenterId).length;
    if (sameDataCenter > 0) {
      return sameDataCenter;
    }
  }
  return resources.clusters.length === 1 ? resources.storageDomains.length : 0;
}

function vmEnvironment(vm: InventoryResource): string | undefined {
  const metadata = customProperties(vm);
  if (metadata.environment) {
    return metadata.environment;
  }
  const tags = childItems(vm.tags, "tag").map((tag) => stringValue(tag.name)).filter(isString);
  return tags.find((tag) => ["prod", "production", "dev", "test", "stage"].includes(tag.toLowerCase()));
}

function guestOs(vm: InventoryResource): string | undefined {
  const guestInfo = recordValue(vm.guest_info);
  const guestOsInfo = recordValue(guestInfo?.os);
  const guestName = stringValue(guestOsInfo?.name);
  const guestVersion = stringValue(guestOsInfo?.version);
  const combinedGuest = [guestName, guestVersion].filter(isString).join(" ");
  return combinedGuest || stringValue(recordValue(vm.os)?.type);
}

function firstIpAddress(vm: InventoryResource): string | undefined {
  const nicIps = childItems(vm.nics, "nic").flatMap((nic) =>
    childItems(nic.reported_devices, "reported_device").flatMap((device) => childItems(device.ips, "ip").map((ip) => stringValue(ip.address)))
  );
  const guestInfoIps = childItems(recordValue(vm.guest_info)?.ips, "ip").map((ip) => stringValue(ip.address));
  return [...nicIps, ...guestInfoIps].filter(isString)[0];
}

function vmDiskTotals(vm: InventoryResource): { allocated?: number; used?: number } {
  let allocated = 0;
  let used = 0;
  let hasAllocated = false;
  let hasUsed = false;

  for (const attachment of childItems(vm.disk_attachments, "disk_attachment")) {
    const disk = recordValue(attachment.disk) ?? attachment;
    const provisionedSize = bytesToGiB(disk.provisioned_size);
    const actualSize = bytesToGiB(disk.actual_size);
    if (provisionedSize !== undefined) {
      allocated += provisionedSize;
      hasAllocated = true;
    }
    if (actualSize !== undefined) {
      used += actualSize;
      hasUsed = true;
    }
  }

  return {
    allocated: hasAllocated ? roundGib(allocated) : undefined,
    used: hasUsed ? roundGib(used) : undefined
  };
}

function childItems(value: unknown, itemKey: string): InventoryResource[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  const child = (value as Record<string, unknown>)[itemKey];
  if (Array.isArray(child)) {
    return child.filter(isRecord);
  }
  return isRecord(child) ? [child] : [];
}

function customProperties(raw: InventoryResource): Record<string, string> {
  const result: Record<string, string> = {};
  const properties = [...childItems(raw.custom_properties, "custom_property"), ...childItems(raw.properties, "property")];
  for (const property of properties) {
    const name = stringValue(property.name);
    const value = stringValue(property.value);
    if (!name || value === undefined) {
      continue;
    }
    result[toCamelCase(name)] = value;
  }
  return result;
}

function refId(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.id);
}

function refName(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.name);
}

function recordValue(value: unknown): InventoryResource | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bytesToMiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round(bytes / 1024 / 1024);
}

function bytesToGiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
}

function cpuTotal(topology: InventoryResource | undefined): number | undefined {
  const sockets = numberValue(topology?.sockets);
  const cores = numberValue(topology?.cores);
  const threads = numberValue(topology?.threads);
  return sockets && cores && threads ? sockets * cores * threads : undefined;
}

function versionString(value: unknown): string | undefined {
  const version = recordValue(value);
  if (!version) {
    return undefined;
  }
  const major = stringValue(version.major) ?? numberValue(version.major)?.toString();
  const minor = stringValue(version.minor) ?? numberValue(version.minor)?.toString();
  return major && minor ? `${major}.${minor}` : undefined;
}

function roundGib(value: number): number {
  return Math.round(value * 100) / 100;
}

function toCamelCase(value: string): string {
  return value
    .trim()
    .replace(/[-_\s]+(.)?/g, (_match, letter: string | undefined) => (letter ? letter.toUpperCase() : ""))
    .replace(/^./, (letter) => letter.toLowerCase());
}

function isRecord(value: unknown): value is InventoryResource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseClusterParams(params: unknown): { managerId: string; clusterId: string } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  return typeof record.managerId === "string" && typeof record.clusterId === "string"
    ? { managerId: record.managerId, clusterId: record.clusterId }
    : undefined;
}

function sum(summaries: DashboardResponse["managers"], key: (typeof resourceKeys)[number]): number {
  return summaries.reduce((total, manager) => total + manager.resourceCounts[key], 0);
}

function emptyResources(): InventoryResources {
  return emptyInventoryResources();
}
