import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";
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

  return resources.vms.map((vm) => {
    const vmId = stringValue(vm.id) ?? stringValue(vm.name) ?? "unknown";
    const clusterId = refId(vm.cluster);
    const cluster = clusterId ? clusters.get(clusterId) : undefined;
    const dataCenterId = refId(cluster?.data_center);
    const hostId = refId(vm.host);
    const host = hostId ? hosts.get(hostId) : undefined;
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
      storageUsedGiB: diskTotals.used
    };
  });
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
      ...(row.ipAddresses ?? [])
    ]
      .filter(isString)
      .join(" ")
      .toLowerCase();
    return haystack.includes(filters.search.toLowerCase());
  }
  return true;
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

function simplePdf(lines: string[]): Buffer {
  const chunks = chunk(lines.map(pdfLine), 38);
  const objects: string[] = [""];
  const catalogId = addObject(objects, "<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject(objects, "");
  const fontId = addObject(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];

  for (const pageLines of chunks.length ? chunks : [[]]) {
    const content = `BT /F1 8 Tf 36 792 Td 10 TL ${pageLines.map((line) => `(${escapePdf(line)}) Tj T*`).join(" ")} ET`;
    const contentId = addObject(objects, `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(
      objects,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
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

function pdfLine(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 170);
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
