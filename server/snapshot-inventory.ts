import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";
import { snapshotAgeDaysAt, snapshotCreatedAt } from "./snapshot-age.js";
import { isActiveVmSnapshot } from "./snapshot-semantics.js";
import { type InventoryResource, type InventoryResources } from "../shared/snapshot.js";

interface SnapshotRow {
  id: string;
  manager_id: string;
  manager_name: string;
  manager_url: string;
  collected_at: string;
  resources_json: string;
}

interface ManagerRow {
  id: string;
  name: string;
  url: string;
}

interface SnapshotVmInventoryQuery {
  page: number;
  pageSize: number;
  filters: SnapshotVmInventoryFilters;
  sortBy?: SnapshotVmInventorySortKey;
  sortDirection: SnapshotVmInventorySortDirection;
}

interface SnapshotVmInventoryFilters {
  search?: string;
  managerId?: string;
  clusterId?: string;
  powerState?: string;
  environment?: string;
  sortBy?: SnapshotVmInventorySortKey;
  sortDirection?: SnapshotVmInventorySortDirection;
}

export interface SnapshotVmInventoryRow {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  dataCenterId?: string;
  dataCenterName?: string;
  clusterId?: string;
  clusterName?: string;
  vmId: string;
  name: string;
  environment?: string;
  powerState?: string;
  host?: string;
  guestOs?: string;
  ipAddress?: string;
  ipAddresses?: string[];
  vcpuCount?: number;
  allocatedRamMiB?: number;
  storageAllocatedGiB?: number;
  storageUsedGiB?: number;
  snapshotNames: string[];
  snapshotDetails: SnapshotInventorySnapshot[];
}

export interface SnapshotInventorySnapshot {
  name: string;
  createdAt?: string;
  ageDays?: number;
}

export interface SnapshotHostInventoryRow {
  managerId: string;
  managerName: string;
  snapshotId: string;
  collectedAt: string;
  clusterId?: string;
  clusterName?: string;
  hostId: string;
  hostName: string;
  status?: string;
  hostOs?: string;
  vdsmVersion?: string;
  physicalCpuThreads?: number;
  physicalMemoryMiB?: number;
  hostedVmCount: number;
  allocatedVcpu?: number;
  allocatedRamMiB?: number;
}

interface SnapshotHostInventoryQuery {
  page: number;
  pageSize: number;
  filters: SnapshotHostInventoryFilters;
}

interface SnapshotHostInventoryFilters {
  search?: string;
  managerId?: string;
  clusterId?: string;
}

export interface SnapshotHostInventoryResult {
  rows: SnapshotHostInventoryRow[];
  page: number;
  pageSize: number;
  total: number;
  filters: SnapshotHostInventoryFilters;
  filterOptions: {
    managers: Array<{ value: string; label: string }>;
    clusters: Array<{ value: string; label: string }>;
  };
}

export interface RelationshipRow {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  clusterId?: string;
  clusterName?: string;
  hostId?: string;
  hostName?: string;
  vmId?: string;
  vmName?: string;
  powerState?: string;
  ipAddresses: string[];
  vcpuCount?: number;
  allocatedRamMiB?: number;
  virtualDisks: RelationshipVirtualDisk[];
  storageDomainNames: string[];
}

export interface RelationshipVirtualDisk {
  name: string;
  sizeGiB?: number;
}

type SnapshotVmInventorySortKey =
  | "managerName"
  | "clusterName"
  | "name"
  | "powerState"
  | "host"
  | "guestOs"
  | "ipAddress"
  | "vcpuCount"
  | "allocatedRamMiB"
  | "storageAllocatedGiB"
  | "storageUsedGiB"
  | "snapshotNames"
  | "collectedAt";

type SnapshotVmInventorySortDirection = "asc" | "desc";

export interface SnapshotVmInventoryResult {
  rows: SnapshotVmInventoryRow[];
  page: number;
  pageSize: number;
  total: number;
  filters: SnapshotVmInventoryFilters;
  filterOptions: {
    managers: Array<{ value: string; label: string }>;
    clusters: Array<{ value: string; label: string }>;
    powerStates: string[];
    environments: string[];
  };
}

export interface RelationshipResult {
  rows: RelationshipRow[];
  total: number;
}

interface RelationshipExportScope {
  managerId?: string;
  clusterId?: string;
  hostId?: string;
}

const inventoryColumns: Array<{ key: keyof SnapshotVmInventoryRow; title: string; format?: (row: SnapshotVmInventoryRow) => unknown }> = [
  { key: "managerName", title: "Manager" },
  { key: "clusterName", title: "Cluster" },
  { key: "name", title: "VM Name" },
  { key: "powerState", title: "Power State" },
  { key: "host", title: "Host" },
  { key: "guestOs", title: "Guest OS" },
  { key: "ipAddress", title: "IP Addresses", format: (row) => row.ipAddresses?.join("; ") ?? row.ipAddress },
  { key: "vcpuCount", title: "vCPU Count" },
  { key: "allocatedRamMiB", title: "Allocated RAM", format: (row) => formatMemory(row.allocatedRamMiB) },
  { key: "storageAllocatedGiB", title: "Storage Allocated GiB" },
  { key: "storageUsedGiB", title: "Storage Used GiB" },
  { key: "snapshotNames", title: "Snapshots", format: (row) => formatSnapshotDetails(row.snapshotDetails) },
  { key: "collectedAt", title: "Collected At" }
];

const hardwareInventoryColumns: Array<{ key: keyof SnapshotHostInventoryRow; title: string; format?: (row: SnapshotHostInventoryRow) => unknown }> = [
  { key: "managerName", title: "Manager" },
  { key: "clusterName", title: "Cluster" },
  { key: "hostName", title: "Host" },
  { key: "status", title: "Status" },
  { key: "hostOs", title: "Host OS" },
  { key: "vdsmVersion", title: "oVirt/VDSM Version" },
  { key: "physicalCpuThreads", title: "Physical CPU Threads" },
  { key: "physicalMemoryMiB", title: "Physical RAM", format: (row) => formatMemory(row.physicalMemoryMiB) },
  { key: "hostedVmCount", title: "Hosted VMs" },
  { key: "allocatedVcpu", title: "Allocated vCPU" },
  { key: "allocatedRamMiB", title: "Allocated RAM", format: (row) => formatMemory(row.allocatedRamMiB) },
  { key: "collectedAt", title: "Collected At" }
];

const sortableColumns = new Set<SnapshotVmInventorySortKey>([
  "managerName",
  "clusterName",
  "name",
  "powerState",
  "host",
  "guestOs",
  "ipAddress",
  "vcpuCount",
  "allocatedRamMiB",
  "storageAllocatedGiB",
  "storageUsedGiB",
  "collectedAt"
]);

export function registerSnapshotInventoryRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/inventory/snapshot-vms", { preHandler: requireRole(roles.read) }, async (request) => ({
    inventory: querySnapshotVmInventory(db, parseSnapshotVmInventoryQuery(request.query))
  }));

  app.get("/api/inventory/snapshot-hosts", { preHandler: requireRole(roles.read) }, async (request) => ({
    inventory: querySnapshotHostInventory(db, parseSnapshotHostInventoryQuery(request.query))
  }));

  app.get("/api/inventory/relationships", { preHandler: requireRole(roles.read) }, async () => ({
    relationships: queryRelationships(db)
  }));

  app.get("/api/exports/snapshot-vms", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const format = parseExportFormat(request.query);
    const inventory = querySnapshotVmInventory(db, { ...parseSnapshotVmInventoryQuery(request.query), page: 1, pageSize: 10_000 });
    const session = currentSession(db, request);
    recordAudit(db, {
      actor: session?.username,
      action: "export.snapshot_vm_inventory",
      metadata: { format, filters: inventory.filters, rows: inventory.rows.length }
    });

    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-vms.csv\"")
        .send(snapshotVmInventoryCsv(inventory.rows));
    }

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-vms.pdf\"")
      .send(snapshotVmInventoryPdf(inventory.rows, inventory.filters));
  });

  app.get("/api/exports/snapshot-hosts", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const format = parseExportFormat(request.query);
    const filters = parseSnapshotHostInventoryQuery(request.query).filters;
    const rows = filteredSnapshotHostRows(db, filters);
    const session = currentSession(db, request);
    recordAudit(db, {
      actor: session?.username,
      action: "export.snapshot_host_inventory",
      metadata: { format, filters, rows: rows.length }
    });

    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-hardware.csv\"")
        .send(snapshotHostInventoryCsv(rows));
    }

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-hardware.pdf\"")
      .send(snapshotHostInventoryPdf(rows, filters));
  });

  app.get("/api/exports/relationships", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const scope = parseRelationshipExportScope(request.query);
    const rows = queryRelationships(db).rows.filter((row) => matchesRelationshipExportScope(row, scope));
    const columns = parseRelationshipColumns(request.query);
    const session = currentSession(db, request);
    recordAudit(db, {
      actor: session?.username,
      action: "export.relationships",
      metadata: { rows: rows.length, columns: columns.map((column) => column.key), scope }
    });

    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${relationshipExportFilename(rows, scope)}"`)
      .send(relationshipsCsv(rows, columns));
  });
}

export function querySnapshotVmInventory(db: SqliteDatabase, query: SnapshotVmInventoryQuery): SnapshotVmInventoryResult {
  const allRows = allLatestSnapshotVmRows(db);
  const filteredRows = sortRows(allRows.filter((row) => matchesFilters(row, query.filters)), query.sortBy, query.sortDirection);
  const pageSize = Math.min(Math.max(query.pageSize, 1), 500);
  const page = Math.max(query.page, 1);
  const start = (page - 1) * pageSize;

  return {
    rows: filteredRows.slice(start, start + pageSize),
    page,
    pageSize,
    total: filteredRows.length,
    filters: {
      ...query.filters,
      ...(query.sortBy ? { sortBy: query.sortBy, sortDirection: query.sortDirection } : {})
    },
    filterOptions: filterOptions(allRows)
  };
}

export function querySnapshotHostInventory(db: SqliteDatabase, query: SnapshotHostInventoryQuery): SnapshotHostInventoryResult {
  const allRows = allLatestSnapshotHostRows(db);
  const filteredRows = allRows.filter((row) => matchesHostFilters(row, query.filters));
  const pageSize = Math.min(Math.max(query.pageSize, 1), 500);
  const page = Math.max(query.page, 1);
  const start = (page - 1) * pageSize;

  return {
    rows: filteredRows.slice(start, start + pageSize),
    page,
    pageSize,
    total: filteredRows.length,
    filters: query.filters,
    filterOptions: {
      managers: uniquePairs(allRows.map((row) => ({ value: row.managerId, label: row.managerName }))),
      clusters: uniquePairs(allRows.filter((row) => row.clusterId).map((row) => ({ value: row.clusterId!, label: row.clusterName ?? row.clusterId! })))
    }
  };
}

function filteredSnapshotHostRows(db: SqliteDatabase, filters: SnapshotHostInventoryFilters): SnapshotHostInventoryRow[] {
  return allLatestSnapshotHostRows(db).filter((row) => matchesHostFilters(row, filters));
}

export function queryRelationships(db: SqliteDatabase): RelationshipResult {
  const rows = allLatestRelationshipRows(db);
  return {
    rows,
    total: rows.length
  };
}

function allLatestSnapshotVmRows(db: SqliteDatabase): SnapshotVmInventoryRow[] {
  const managers = db.prepare("SELECT id, name, url FROM managers ORDER BY name COLLATE NOCASE").all() as ManagerRow[];
  return managers.flatMap((manager) => {
    const snapshot = latestInventorySnapshot(db, manager.id);
    if (!snapshot) {
      return [];
    }
    return snapshotRows(manager, snapshot);
  });
}

function allLatestSnapshotHostRows(db: SqliteDatabase): SnapshotHostInventoryRow[] {
  const managers = db.prepare("SELECT id, name, url FROM managers ORDER BY name COLLATE NOCASE").all() as ManagerRow[];
  return managers.flatMap((manager) => {
    const snapshot = latestInventorySnapshot(db, manager.id);
    return snapshot ? hostRows(manager, snapshot) : [];
  });
}

function allLatestRelationshipRows(db: SqliteDatabase): RelationshipRow[] {
  const managers = db.prepare("SELECT id, name, url FROM managers ORDER BY name COLLATE NOCASE").all() as ManagerRow[];
  return managers.flatMap((manager) => {
    const snapshot = latestInventorySnapshot(db, manager.id);
    if (!snapshot) {
      return [];
    }
    return relationshipRows(manager, snapshot);
  });
}

function latestInventorySnapshot(db: SqliteDatabase, managerId: string): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT id, manager_id, manager_name, manager_url, collected_at, resources_json
       FROM snapshots
       WHERE manager_id = ? AND status IN ('success', 'partial')
       ORDER BY collected_at DESC, created_at DESC LIMIT 1`
    )
    .get(managerId) as SnapshotRow | undefined;
}

function snapshotRows(manager: ManagerRow, snapshot: SnapshotRow): SnapshotVmInventoryRow[] {
  const resources = JSON.parse(snapshot.resources_json) as InventoryResources;
  const dataCenters = new Map(resources.dataCenters.map((item) => [stringValue(item.id), item]));
  const clusters = new Map(resources.clusters.map((item) => [stringValue(item.id), item]));
  const hosts = new Map(resources.hosts.map((item) => [stringValue(item.id), item]));
  const snapshotDetailsByVmId = vmSnapshotDetailsByVmId(resources, snapshot.collected_at);

  return resources.vms.map((vm) => {
    const vmId = stringValue(vm.id) ?? stringValue(vm.name) ?? "unknown";
    const hostId = refId(vm.host);
    const host = hostId ? hosts.get(hostId) : undefined;
    const clusterId = refId(vm.cluster) ?? refId(host?.cluster);
    const cluster = clusterId ? clusters.get(clusterId) : undefined;
    const dataCenterId = refId(cluster?.data_center);
    const diskTotals = vmDiskTotals(vm);
    const ipAddresses = vmIpAddresses(vm);

    return {
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      snapshotId: snapshot.id,
      collectedAt: snapshot.collected_at,
      dataCenterId,
      dataCenterName: stringValue(dataCenters.get(dataCenterId)?.name),
      clusterId,
      clusterName: refName(vm.cluster) ?? stringValue(cluster?.name) ?? clusterId,
      vmId,
      name: stringValue(vm.name) ?? vmId,
      environment: vmEnvironment(vm),
      powerState: stringValue(vm.status),
      host: refName(vm.host) ?? stringValue(host?.name) ?? hostId,
      guestOs: guestOs(vm),
      ipAddress: ipAddresses[0],
      ipAddresses,
      vcpuCount: vcpuCount(vm),
      allocatedRamMiB: allocatedRamMiB(vm),
      storageAllocatedGiB: diskTotals.allocated,
      storageUsedGiB: diskTotals.used,
      snapshotNames: snapshotDetailsByVmId.get(vmId)?.map((item) => item.name) ?? [],
      snapshotDetails: snapshotDetailsByVmId.get(vmId) ?? []
    };
  });
}

function hostRows(manager: ManagerRow, snapshot: SnapshotRow): SnapshotHostInventoryRow[] {
  const resources = JSON.parse(snapshot.resources_json) as InventoryResources;
  const clusters = new Map(resources.clusters.map((item) => [stringValue(item.id), item]));
  const vmsByHostId = new Map<string, InventoryResource[]>();

  for (const vm of resources.vms) {
    const hostId = refId(vm.host);
    if (hostId) {
      const vms = vmsByHostId.get(hostId);
      if (vms) {
        vms.push(vm);
      } else {
        vmsByHostId.set(hostId, [vm]);
      }
    }
  }

  return resources.hosts
    .flatMap((host): SnapshotHostInventoryRow[] => {
      const hostId = stringValue(host.id);
      if (!hostId) {
        return [];
      }
      const clusterId = refId(host.cluster);
      const cluster = clusterId ? clusters.get(clusterId) : undefined;
      const vms = vmsByHostId.get(hostId) ?? [];
      const allocatedVcpu = sumOptional(vms.map(vcpuCount));
      const allocatedRamTotalMiB = sumOptional(vms.map(allocatedRamMiB));

      return [{
        managerId: manager.id,
        managerName: manager.name,
        snapshotId: snapshot.id,
        collectedAt: snapshot.collected_at,
        clusterId,
        clusterName: refName(host.cluster) ?? stringValue(cluster?.name) ?? clusterId,
        hostId,
        hostName: stringValue(host.name) ?? hostId,
        status: stringValue(host.status),
        hostOs: hostOperatingSystem(host),
        vdsmVersion: versionLabel(host.version),
        physicalCpuThreads: hostCpuThreads(host),
        physicalMemoryMiB: bytesToMiB(host.memory),
        hostedVmCount: vms.length,
        allocatedVcpu,
        allocatedRamMiB: allocatedRamTotalMiB
      }];
    })
    .sort((left, right) =>
      compareSortValues(left.managerName, right.managerName) ||
      compareSortValues(left.clusterName, right.clusterName) ||
      compareSortValues(left.hostName, right.hostName)
    );
}

function relationshipRows(manager: ManagerRow, snapshot: SnapshotRow): RelationshipRow[] {
  const resources = JSON.parse(snapshot.resources_json) as InventoryResources;
  const clusters = new Map(resources.clusters.map((item) => [stringValue(item.id), item]));
  const hosts = new Map(resources.hosts.map((item) => [stringValue(item.id), item]));
  const disks = resourceMapById(resources.disks, ["id", "diskId"]);
  const storageDomains = resourceMapById(resources.storageDomains, ["id", "storageDomainId"]);
  const hostIdsWithVms = new Set<string>();
  const rows: RelationshipRow[] = [];

  for (const vm of resources.vms) {
    const vmId = stringValue(vm.id) ?? stringValue(vm.name) ?? "unknown";
    const hostId = refId(vm.host);
    const host = hostId ? hosts.get(hostId) : undefined;
    const clusterId = refId(vm.cluster) ?? refId(host?.cluster);
    const cluster = clusterId ? clusters.get(clusterId) : undefined;
    if (hostId) {
      hostIdsWithVms.add(hostId);
    }

    rows.push({
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      snapshotId: snapshot.id,
      collectedAt: snapshot.collected_at,
      clusterId,
      clusterName: refName(vm.cluster) ?? stringValue(cluster?.name) ?? clusterId,
      hostId,
      hostName: refName(vm.host) ?? stringValue(host?.name) ?? hostId,
      vmId,
      vmName: stringValue(vm.name) ?? vmId,
      powerState: stringValue(vm.status),
      ipAddresses: vmIpAddresses(vm),
      vcpuCount: vcpuCount(vm),
      allocatedRamMiB: allocatedRamMiB(vm),
      virtualDisks: vmVirtualDisks(vm, disks),
      storageDomainNames: vmStorageDomainNames(vm, disks, storageDomains)
    });
  }

  for (const host of resources.hosts) {
    const hostId = stringValue(host.id);
    if (!hostId || hostIdsWithVms.has(hostId)) {
      continue;
    }
    const clusterId = refId(host.cluster);
    const cluster = clusterId ? clusters.get(clusterId) : undefined;
    rows.push({
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      snapshotId: snapshot.id,
      collectedAt: snapshot.collected_at,
      clusterId,
      clusterName: refName(host.cluster) ?? stringValue(cluster?.name) ?? clusterId,
      hostId,
      hostName: stringValue(host.name) ?? hostId,
      ipAddresses: [],
      virtualDisks: [],
      storageDomainNames: []
    });
  }

  if (rows.length === 0) {
    rows.push({
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      snapshotId: snapshot.id,
      collectedAt: snapshot.collected_at,
      ipAddresses: [],
      virtualDisks: [],
      storageDomainNames: []
    });
  }

  return rows.sort((left, right) =>
    compareSortValues(left.managerName, right.managerName) ||
    compareSortValues(left.clusterName, right.clusterName) ||
    compareSortValues(left.hostName, right.hostName) ||
    compareSortValues(left.vmName, right.vmName)
  );
}

function parseSnapshotVmInventoryQuery(query: unknown): SnapshotVmInventoryQuery {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const sortBy = snapshotVmInventorySortKey(raw.sortBy);
  return {
    page: positiveInteger(raw.page, 1),
    pageSize: positiveInteger(raw.pageSize, 100),
    sortBy,
    sortDirection: stringValue(raw.sortDirection) === "desc" ? "desc" : "asc",
    filters: {
      search: stringValue(raw.search),
      managerId: stringValue(raw.managerId),
      clusterId: stringValue(raw.clusterId),
      powerState: stringValue(raw.powerState),
      environment: stringValue(raw.environment)
    }
  };
}

function parseSnapshotHostInventoryQuery(query: unknown): SnapshotHostInventoryQuery {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  return {
    page: positiveInteger(raw.page, 1),
    pageSize: positiveInteger(raw.pageSize, 100),
    filters: {
      search: stringValue(raw.search),
      managerId: stringValue(raw.managerId),
      clusterId: stringValue(raw.clusterId)
    }
  };
}

function parseExportFormat(query: unknown): "csv" | "pdf" {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  return stringValue(raw.format) === "pdf" ? "pdf" : "csv";
}

function matchesFilters(row: SnapshotVmInventoryRow, filters: SnapshotVmInventoryFilters): boolean {
  if (filters.managerId && row.managerId !== filters.managerId) {
    return false;
  }
  if (filters.clusterId && row.clusterId !== filters.clusterId) {
    return false;
  }
  if (filters.powerState && row.powerState !== filters.powerState) {
    return false;
  }
  if (filters.environment && row.environment !== filters.environment) {
    return false;
  }
  if (filters.search) {
    const haystack = [
      row.managerName,
      row.clusterName,
      row.name,
      row.environment,
      row.powerState,
      row.host,
      row.guestOs,
      row.ipAddress,
      ...(row.ipAddresses ?? []),
      ...row.snapshotNames
    ]
      .filter(isString)
      .join(" ")
      .toLowerCase();
    return haystack.includes(filters.search.toLowerCase());
  }
  return true;
}

function matchesHostFilters(row: SnapshotHostInventoryRow, filters: SnapshotHostInventoryFilters): boolean {
  if (filters.managerId && row.managerId !== filters.managerId) {
    return false;
  }
  if (filters.clusterId && row.clusterId !== filters.clusterId) {
    return false;
  }
  if (!filters.search) {
    return true;
  }
  return [row.managerName, row.clusterName, row.hostName, row.status, row.hostOs, row.vdsmVersion]
    .filter(isString)
    .join(" ")
    .toLowerCase()
    .includes(filters.search.toLowerCase());
}

function filterOptions(rows: SnapshotVmInventoryRow[]): SnapshotVmInventoryResult["filterOptions"] {
  return {
    managers: uniquePairs(rows.map((row) => ({ value: row.managerId, label: row.managerName }))),
    clusters: uniquePairs(rows.filter((row) => row.clusterId).map((row) => ({ value: row.clusterId!, label: row.clusterName ?? row.clusterId! }))),
    powerStates: uniqueStrings(rows.map((row) => row.powerState)),
    environments: uniqueStrings(rows.map((row) => row.environment))
  };
}

function snapshotVmInventoryCsv(rows: SnapshotVmInventoryRow[]): string {
  return [
    inventoryColumns.map((column) => csvCell(column.title)).join(","),
    ...rows.map((row) => inventoryColumns.map((column) => csvCell(column.format ? column.format(row) : row[column.key])).join(","))
  ].join("\n");
}

function snapshotHostInventoryCsv(rows: SnapshotHostInventoryRow[]): string {
  return [
    hardwareInventoryColumns.map((column) => csvCell(column.title)).join(","),
    ...rows.map((row) => hardwareInventoryColumns.map((column) => csvCell(column.format ? column.format(row) : row[column.key])).join(","))
  ].join("\n");
}

const relationshipColumns = [
  { key: "hostName", title: "Host" },
  { key: "vmName", title: "VM" },
  { key: "powerState", title: "Power State" },
  { key: "ipAddresses", title: "IP Addresses", format: (row) => formatNameList(row.ipAddresses) },
  { key: "vcpuCount", title: "vCPU Count" },
  { key: "allocatedRamMiB", title: "Allocated RAM", format: (row) => formatMemory(row.allocatedRamMiB) },
  { key: "virtualDisks", title: "Virtual Disks", format: (row) => formatVirtualDisks(row.virtualDisks) },
  { key: "storageDomainNames", title: "Storage Domains", format: (row) => formatNameList(row.storageDomainNames) },
  { key: "managerName", title: "Manager" },
  { key: "clusterName", title: "Cluster" },
  { key: "collectedAt", title: "Collected At" },
  { key: "managerId", title: "Manager ID" },
  { key: "clusterId", title: "Cluster ID" },
  { key: "hostId", title: "Host ID" },
  { key: "vmId", title: "VM ID" },
  { key: "snapshotId", title: "Snapshot ID" },
  { key: "managerUrl", title: "Manager URL" }
] satisfies Array<{ key: keyof RelationshipRow; title: string; format?: (row: RelationshipRow) => unknown }>;

type RelationshipColumn = (typeof relationshipColumns)[number];

const defaultRelationshipColumns = relationshipColumns.slice(0, 8);

function parseRelationshipColumns(query: unknown): RelationshipColumn[] {
  const raw = query && typeof query === "object" ? stringValue((query as Record<string, unknown>).columns) : undefined;
  if (!raw) {
    return defaultRelationshipColumns;
  }
  const columnsByKey = new Map<string, RelationshipColumn>(relationshipColumns.map((column) => [column.key, column]));
  const seen = new Set<string>();
  const requested: RelationshipColumn[] = [];
  for (const key of raw.split(",")) {
    const column = columnsByKey.get(key.trim());
    if (column && !seen.has(column.key)) {
      requested.push(column);
      seen.add(column.key);
    }
  }
  return requested.length ? requested : defaultRelationshipColumns;
}

function parseRelationshipExportScope(query: unknown): RelationshipExportScope {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  return {
    managerId: stringValue(raw.managerId),
    clusterId: stringValue(raw.clusterId),
    hostId: stringValue(raw.hostId)
  };
}

function matchesRelationshipExportScope(row: RelationshipRow, scope: RelationshipExportScope): boolean {
  return (
    (!scope.managerId || row.managerId === scope.managerId) &&
    (!scope.clusterId || row.clusterId === scope.clusterId) &&
    (!scope.hostId || row.hostId === scope.hostId)
  );
}

function relationshipExportFilename(rows: RelationshipRow[], scope: RelationshipExportScope): string {
  if (!scope.managerId && !scope.clusterId && !scope.hostId) {
    return "ovirt-inventory-topology.csv";
  }

  const row = rows[0];
  const parts = ["ovirt-inventory", "topology"];
  if (scope.managerId) {
    parts.push(filenameSlug(row?.managerName) || filenameSlug(scope.managerId) || "manager");
  }
  if (scope.clusterId) {
    parts.push(filenameSlug(row?.clusterName) || filenameSlug(scope.clusterId) || "cluster");
  }
  if (scope.hostId) {
    parts.push(filenameSlug(row?.hostName) || filenameSlug(scope.hostId) || "host");
  }
  const collectedDate = relationshipCollectedDate(row?.collectedAt);
  if (collectedDate) {
    parts.push(collectedDate);
  }
  return `${parts.join("-")}.csv`;
}

function filenameSlug(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function relationshipCollectedDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString().slice(0, 10);
}

function relationshipsCsv(rows: RelationshipRow[], columns: RelationshipColumn[] = defaultRelationshipColumns): string {
  return [
    columns.map((column) => csvCell(column.title)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(column.format ? column.format(row) : (row[column.key] ?? "-"))).join(","))
  ].join("\n");
}

function snapshotVmInventoryPdf(rows: SnapshotVmInventoryRow[], filters: SnapshotVmInventoryFilters): Buffer {
  const filterText = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const lines = [
    "ovirt-inventory VM Inventory",
    `Generated: ${new Date().toISOString()}`,
    `Filters: ${filterText || "none"}`,
    `Rows: ${rows.length}`,
    "",
    inventoryColumns.map((column) => column.title).join(" | "),
    ...rows.map((row) => inventoryColumns.map((column) => String((column.format ? column.format(row) : row[column.key]) ?? "-")).join(" | "))
  ];
  return simplePdf(lines);
}

function snapshotHostInventoryPdf(rows: SnapshotHostInventoryRow[], filters: SnapshotHostInventoryFilters): Buffer {
  const filterText = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const lines = [
    "ovirt-inventory Hardware Inventory",
    `Generated: ${new Date().toISOString()}`,
    `Filters: ${filterText || "none"}`,
    `Rows: ${rows.length}`,
    "",
    hardwareInventoryColumns.map((column) => column.title).join(" | "),
    ...rows.map((row) => hardwareInventoryColumns.map((column) => String((column.format ? column.format(row) : row[column.key]) ?? "-")).join(" | "))
  ];
  return simplePdf(lines, { landscape: true, fontSize: 6, lineHeight: 8, linesPerPage: 60, maxLineLength: 260 });
}

interface SimplePdfOptions {
  landscape?: boolean;
  fontSize?: number;
  lineHeight?: number;
  linesPerPage?: number;
  maxLineLength?: number;
}

function simplePdf(lines: string[], options: SimplePdfOptions = {}): Buffer {
  const landscape = options.landscape ?? false;
  const fontSize = options.fontSize ?? 8;
  const lineHeight = options.lineHeight ?? 10;
  const linesPerPage = options.linesPerPage ?? 38;
  const maxLineLength = options.maxLineLength ?? 170;
  const pageWidth = landscape ? 842 : 612;
  const pageHeight = landscape ? 612 : 842;
  const chunks = chunk(lines.map((line) => pdfLine(line, maxLineLength)), linesPerPage);
  const objects: string[] = [""];
  const catalogId = addObject(objects, "<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject(objects, "");
  const fontId = addObject(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const pageLines of chunks.length ? chunks : [[]]) {
    const content = `BT /F1 ${fontSize} Tf 36 ${pageHeight - 50} Td ${lineHeight} TL ${pageLines.map((line) => `(${escapePdf(line)}) Tj T*`).join(" ")} ET`;
    const contentId = addObject(objects, `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(
      objects,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[pagesId] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, "utf8");
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function addObject(objects: string[], body: string): number {
  objects.push(body);
  return objects.length - 1;
}

function pdfLine(value: string, maxLength: number): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, maxLength);
}

function escapePdf(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function vmEnvironment(vm: InventoryResource): string | undefined {
  const metadata = customProperties(vm);
  if (metadata.environment) {
    return metadata.environment;
  }
  if (stringValue(vm.environment)) {
    return stringValue(vm.environment);
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

function vmIpAddresses(vm: InventoryResource): string[] {
  const nicIps = childItems(vm.nics, "nic").flatMap((nic) =>
    childItems(nic.reported_devices ?? nic.reporteddevices, "reported_device").flatMap((device) =>
      childItems(device.ips, "ip").map((ip) => stringValue(ip.address))
    )
  );
  const guestInfoIps = childItems(recordValue(vm.guest_info)?.ips, "ip").map((ip) => stringValue(ip.address));
  return uniqueOrderedStrings([...nicIps, ...guestInfoIps].filter(isString));
}

function vmSnapshotDetailsByVmId(resources: InventoryResources, collectedAt: string): Map<string, SnapshotInventorySnapshot[]> {
  const byVmId = new Map<string, SnapshotInventorySnapshot[]>();
  for (const snapshot of resources.vmSnapshots) {
    const vmId = refId(snapshot.vm) ?? stringValue(snapshot.vm_id) ?? stringValue(snapshot.vmId);
    const name = stringValue(snapshot.name) ?? stringValue(snapshot.description) ?? stringValue(snapshot.id);
    if (!vmId || !name || isActiveVmSnapshot(snapshot)) {
      continue;
    }
    const current = byVmId.get(vmId) ?? [];
    if (current.some((item) => item.name === name)) {
      continue;
    }
    const createdAt = snapshotCreatedAt(snapshot.date);
    const ageDays = snapshotAgeDaysAt(createdAt, collectedAt);
    current.push({
      name,
      ...(createdAt ? { createdAt } : {}),
      ...(ageDays === undefined ? {} : { ageDays })
    });
    byVmId.set(vmId, current);
  }
  return byVmId;
}

function vmStorageDomainNames(
  vm: InventoryResource,
  disksById: Map<string, InventoryResource>,
  storageDomainsById: Map<string, InventoryResource>
): string[] {
  const names: string[] = [];
  for (const attachment of childItems(vm.disk_attachments ?? vm.diskAttachments, "disk_attachment")) {
    const embeddedDisk = recordValue(attachment.disk) ?? attachment;
    const diskId = stringValue(embeddedDisk.id ?? embeddedDisk.diskId ?? attachment.disk_id ?? attachment.diskId);
    const relatedDisk = diskId ? disksById.get(diskId) : undefined;
    names.push(...diskStorageDomainNames(embeddedDisk, storageDomainsById));
    if (relatedDisk) {
      names.push(...diskStorageDomainNames(relatedDisk, storageDomainsById));
    }
  }
  return uniqueOrderedStrings(names);
}

function vmVirtualDisks(vm: InventoryResource, disksById: Map<string, InventoryResource>): RelationshipVirtualDisk[] {
  return childItems(vm.disk_attachments ?? vm.diskAttachments, "disk_attachment").map((attachment) => {
    const embeddedDisk = recordValue(attachment.disk) ?? attachment;
    const diskId = stringValue(embeddedDisk.id ?? embeddedDisk.diskId ?? attachment.disk_id ?? attachment.diskId);
    const relatedDisk = diskId ? disksById.get(diskId) : undefined;
    return {
      name:
        stringValue(embeddedDisk.alias) ??
        stringValue(embeddedDisk.name) ??
        stringValue(relatedDisk?.alias) ??
        stringValue(relatedDisk?.name) ??
        diskId ??
        "Unknown disk",
      sizeGiB: provisionedSizeGiB(embeddedDisk) ?? provisionedSizeGiB(relatedDisk)
    };
  });
}

function provisionedSizeGiB(disk: InventoryResource | undefined): number | undefined {
  if (!disk) {
    return undefined;
  }
  const direct = numberValue(disk.provisionedSizeGib ?? disk.provisionedSizeGiB ?? disk.provisioned_size_gib);
  return direct === undefined ? bytesToGiB(disk.provisioned_size) : roundGib(direct);
}

function diskStorageDomainNames(disk: InventoryResource, storageDomainsById: Map<string, InventoryResource>): string[] {
  const refs = [
    ...childItems(disk.storage_domains, "storage_domain"),
    ...childItems(disk.storageDomains, "storageDomain")
  ];
  const names = refs.map((domain) => storageDomainName(domain, storageDomainsById)).filter(isString);
  const directRef = recordValue(disk.storage_domain ?? disk.storageDomain);
  const directId = stringValue(disk.storage_domain_id ?? disk.storageDomainId) ?? refId(directRef);
  const directName = stringValue(disk.storage_domain ?? disk.storageDomain) ?? refName(directRef);
  if (directName) {
    names.push(directName);
  } else if (directId) {
    names.push(stringValue(storageDomainsById.get(directId)?.name) ?? directId);
  }
  return uniqueOrderedStrings(names);
}

function storageDomainName(domain: InventoryResource, storageDomainsById: Map<string, InventoryResource>): string | undefined {
  const id = stringValue(domain.id ?? domain.storageDomainId);
  return refName(domain) ?? stringValue(domain.name) ?? (id ? stringValue(storageDomainsById.get(id)?.name) ?? id : undefined);
}

function vcpuCount(vm: InventoryResource): number | undefined {
  const direct = numberValue(vm.vcpus ?? vm.vcpuCount);
  if (direct !== undefined) {
    return direct;
  }
  const topology = recordValue(recordValue(vm.cpu)?.topology);
  const sockets = numberValue(topology?.sockets);
  const cores = numberValue(topology?.cores);
  const threads = numberValue(topology?.threads);
  return sockets && cores && threads ? sockets * cores * threads : undefined;
}

function allocatedRamMiB(vm: InventoryResource): number | undefined {
  const direct = numberValue(vm.memory_mb ?? vm.memoryMb);
  if (direct !== undefined) {
    return direct;
  }
  const bytes = numberValue(vm.memory);
  return bytes === undefined ? undefined : Math.round(bytes / 1024 / 1024);
}

function hostOperatingSystem(host: InventoryResource): string | undefined {
  const os = recordValue(host.os);
  const fallback = [stringValue(os?.type), versionLabel(os?.version)].filter(isString).join(" ");
  return stringValue(os?.description) ?? (fallback || undefined);
}

function versionLabel(value: unknown): string | undefined {
  const version = recordValue(value);
  if (!version) {
    return undefined;
  }
  const fallback = [version.major, version.minor, version.build, version.revision]
    .map(numberValue)
    .filter((part): part is number => part !== undefined)
    .join(".");
  return stringValue(version.full_version) ?? stringValue(version.fullVersion) ?? (fallback || undefined);
}

function hostCpuThreads(host: InventoryResource): number | undefined {
  const topology = recordValue(recordValue(host.cpu)?.topology);
  const sockets = numberValue(topology?.sockets);
  const cores = numberValue(topology?.cores);
  const threads = numberValue(topology?.threads);
  return sockets && cores && threads ? sockets * cores * threads : undefined;
}

function bytesToMiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round(bytes / 1024 / 1024);
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function vmDiskTotals(vm: InventoryResource): { allocated?: number; used?: number } {
  let allocated = 0;
  let used = 0;
  let hasAllocated = false;
  let hasUsed = false;

  for (const attachment of childItems(vm.disk_attachments, "disk_attachment")) {
    const disk = recordValue(attachment.disk) ?? attachment;
    const provisionedSize = bytesToGiB(disk.provisioned_size ?? disk.provisionedSizeGib);
    const actualSize = bytesToGiB(disk.actual_size ?? disk.actualSizeGib);
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
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function positiveInteger(value: unknown, fallback: number): number {
  const text = stringValue(value);
  if (!text) {
    return fallback;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function snapshotVmInventorySortKey(value: unknown): SnapshotVmInventorySortKey | undefined {
  const text = stringValue(value);
  return text && sortableColumns.has(text as SnapshotVmInventorySortKey) ? (text as SnapshotVmInventorySortKey) : undefined;
}

function sortRows(
  rows: SnapshotVmInventoryRow[],
  sortBy: SnapshotVmInventorySortKey | undefined,
  sortDirection: SnapshotVmInventorySortDirection
): SnapshotVmInventoryRow[] {
  if (!sortBy) {
    return rows;
  }
  const direction = sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => compareSortValues(left[sortBy], right[sortBy]) * direction);
}

function compareSortValues(left: unknown, right: unknown): number {
  if (left === undefined || left === null) {
    return right === undefined || right === null ? 0 : 1;
  }
  if (right === undefined || right === null) {
    return -1;
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function formatMemory(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const gib = value / 1024;
  return `${value.toLocaleString()} MiB (~${formatRoundedGib(gib)} GiB)`;
}

function formatSnapshotDetails(value: SnapshotInventorySnapshot[]): string {
  return value.length
    ? value.map((snapshot) => `${snapshot.name} (${snapshot.ageDays === undefined ? "age unknown" : `${snapshot.ageDays}d`})`).join("; ")
    : "-";
}

function formatNameList(value: string[]): string {
  return value.length ? value.join("; ") : "-";
}

function formatVirtualDisks(value: RelationshipVirtualDisk[]): string {
  return value.length
    ? value.map((disk) => (disk.sizeGiB === undefined ? disk.name : `${disk.name} (${formatRoundedGib(disk.sizeGiB)} GiB)`)).join("; ")
    : "-";
}

function resourceMapById(items: InventoryResource[], keys: string[]): Map<string, InventoryResource> {
  const map = new Map<string, InventoryResource>();
  for (const item of items) {
    for (const key of keys) {
      const id = stringValue(item[key]);
      if (id) {
        map.set(id, item);
      }
    }
  }
  return map;
}

function formatRoundedGib(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function bytesToGiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
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

function uniquePairs(items: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
  const result = new Map<string, string>();
  for (const item of items) {
    if (!result.has(item.value)) {
      result.set(item.value, item.label);
    }
  }
  return [...result.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter(isString))].sort((left, right) => left.localeCompare(right));
}

function uniqueOrderedStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function isRecord(value: unknown): value is InventoryResource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
