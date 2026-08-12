import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import { requireRole, roles } from "./rbac.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { operationalDashboard } from "./postgres/operational-dashboard.js";
import { getVmDetail, type VmDetail } from "./postgres/vm-detail.js";
import {
  defaultInventoryColumns,
  queryVmInventory,
  type VmInventoryListItem,
  type VmInventoryQuery
} from "./postgres/vm-inventory.js";

export function registerInventoryRoutes(app: FastifyInstance, inventoryDb?: ConnectablePostgres): void {
  app.get("/api/dashboard/operational", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const session = currentSession(request.server.sqlite, request);
    return { dashboard: await operationalDashboard(inventoryDb, session?.role ?? "viewer") };
  });

  app.get("/api/inventory/vms/:managerId/:vmId", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const params = request.params as { managerId?: string; vmId?: string };
    if (!params.managerId || !params.vmId) {
      return reply.code(404).send({ error: "VM not found" });
    }
    const session = currentSession(request.server.sqlite, request);
    const vm = await getVmDetail(inventoryDb, params.managerId, params.vmId, session?.role ?? "viewer");
    if (!vm) {
      return reply.code(404).send({ error: "VM not found" });
    }
    return { vm };
  });

  app.get("/api/inventory/vms", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const session = currentSession(request.server.sqlite, request);
    const inventory = await queryVmInventory(inventoryDb, parseInventoryQuery(request.query), session?.role ?? "viewer");
    return { inventory };
  });

  app.get("/api/exports/inventory", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const session = currentSession(request.server.sqlite, request);
    const query = parseInventoryQuery(request.query);
    const format = parseExportFormat(request.query);
    const inventory = await queryVmInventory(inventoryDb, { ...query, page: 1, pageSize: 10000 }, session?.role ?? "viewer");
    recordAudit(request.server.sqlite, {
      actor: session?.username,
      action: "export.inventory",
      metadata: { format, filters: inventory.filters, rows: inventory.rows.length }
    });

    if (format === "json") {
      return { inventory };
    }
    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-vms.csv\"")
        .send(inventoryCsv(inventory.rows, inventory.columns));
    }

    const workbook = inventoryWorkbook(inventory.rows, inventory.columns);
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-vms.xlsx\"")
      .send(Buffer.from(buffer));
  });

  app.get("/api/exports/vm-detail", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const raw = request.query && typeof request.query === "object" ? (request.query as Record<string, unknown>) : {};
    const managerId = stringValue(raw.managerId);
    const vmId = stringValue(raw.vmId);
    if (!managerId || !vmId) {
      return reply.code(400).send({ error: "managerId and vmId are required" });
    }

    const session = currentSession(request.server.sqlite, request);
    const vm = await getVmDetail(inventoryDb, managerId, vmId, session?.role ?? "viewer");
    if (!vm) {
      return reply.code(404).send({ error: "VM not found" });
    }

    const format = parseExportFormat(request.query);
    const rows = vmDetailEvidenceRows(vm);
    recordAudit(request.server.sqlite, {
      actor: session?.username,
      action: "export.vm_detail",
      resourceType: "vm",
      resourceId: `${managerId}/${vmId}`,
      metadata: { format, managerId, vmId, rows: rows.length }
    });

    if (format === "json") {
      return { vm };
    }
    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="ovirt-inventory-${vmId}-evidence.csv"`)
        .send(vmDetailEvidenceCsv(rows));
    }

    const workbook = vmDetailEvidenceWorkbook(vm, rows);
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="ovirt-inventory-${vmId}-evidence.xlsx"`)
      .send(Buffer.from(buffer));
  });
}

export function parseInventoryQuery(query: unknown): VmInventoryQuery {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  return {
    page: positiveInteger(raw.page, 1),
    pageSize: positiveInteger(raw.pageSize, 50),
    columns: stringList(raw.columns),
    filters: {
      managerId: stringValue(raw.managerId),
      datacenter: stringValue(raw.datacenter),
      cluster: stringValue(raw.cluster),
      host: stringValue(raw.host),
      storageDomain: stringValue(raw.storageDomain),
      logicalNetwork: stringValue(raw.logicalNetwork),
      vnicProfile: stringValue(raw.vnicProfile),
      status: stringValue(raw.status),
      ha: booleanValue(raw.ha),
      environment: stringValue(raw.environment),
      owner: stringValue(raw.owner),
      application: stringValue(raw.application),
      criticality: stringValue(raw.criticality),
      costCenter: stringValue(raw.costCenter),
      tag: stringValue(raw.tag),
      os: stringValue(raw.os),
      guestAgentStatus: stringValue(raw.guestAgentStatus),
      backupStatus: stringValue(raw.backupStatus),
      rpoBreach: booleanValue(raw.rpoBreach),
      snapshotAgeOverDays: optionalInteger(raw.snapshotAgeOverDays ?? raw.snapshotAgeOver),
      createdFrom: timestampString(raw.createdFrom),
      createdTo: timestampString(raw.createdTo),
      lastSeenFrom: timestampString(raw.lastSeenFrom),
      lastSeenTo: timestampString(raw.lastSeenTo),
      lifecycleStatus: stringValue(raw.lifecycleStatus),
      missingMetadata: booleanValue(raw.missingMetadata),
      missingBackup: booleanValue(raw.missingBackup),
      unknownIp: booleanValue(raw.unknownIp),
      idle: booleanValue(raw.idle)
    }
  };
}

export function inventoryCsv(rows: VmInventoryListItem[], columns = defaultInventoryColumns): string {
  const header = columns.map(csvCell).join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(columnValue(row, column))).join(","));
  return [header, ...body].join("\n");
}

export function inventoryWorkbook(rows: VmInventoryListItem[], columns = defaultInventoryColumns): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ovirt-inventory";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("VM Inventory");
  sheet.columns = columns.map((column) => ({ header: columnTitle(column), key: column, width: 24 }));
  for (const row of rows) {
    sheet.addRow(Object.fromEntries(columns.map((column) => [column, columnValue(row, column)])));
  }
  return workbook;
}

function vmDetailEvidenceRows(vm: VmDetail): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [
    { section: "identity", field: "managerId", value: vm.managerId },
    { section: "identity", field: "vmId", value: vm.vmId },
    { section: "identity", field: "managerName", value: vm.manager.name },
    { section: "identity", field: "managerUrl", value: vm.manager.url }
  ];

  addFieldRows(rows, "overview", vm.tabs.overview);
  addFieldRows(rows, "performance", vm.tabs.performance);
  addFieldRows(rows, "backupDr", vm.tabs.backupDr);
  addFieldRows(rows, "freshness", vm.freshness);
  rows.push({ section: "health", field: "score", value: vm.health.score });
  addItemRows(rows, "health.deductions", vm.health.deductions);
  addItemRows(rows, "storage.disks", vm.tabs.storageSnapshots.disks);
  addItemRows(rows, "storage.snapshots", vm.tabs.storageSnapshots.snapshots);
  addItemRows(rows, "network.nics", vm.tabs.network.nics);
  addItemRows(rows, "eventsAudit.events", vm.tabs.eventsAudit.events);
  addItemRows(rows, "eventsAudit.history", vm.tabs.eventsAudit.history);
  return rows;
}

function vmDetailEvidenceCsv(rows: Array<Record<string, unknown>>): string {
  const columns = ["section", "field", "index", "value"];
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n");
}

function vmDetailEvidenceWorkbook(vm: VmDetail, rows: Array<Record<string, unknown>>): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ovirt-inventory";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("VM Detail Evidence");
  summary.columns = [
    { header: "Section", key: "section", width: 24 },
    { header: "Field", key: "field", width: 28 },
    { header: "Index", key: "index", width: 10 },
    { header: "Value", key: "value", width: 64 }
  ];
  for (const row of rows) {
    summary.addRow(row);
  }

  const tabs = workbook.addWorksheet("Tabs");
  tabs.columns = [
    { header: "VM ID", key: "vmId", width: 24 },
    { header: "Tab", key: "tab", width: 24 },
    { header: "Freshness", key: "freshness", width: 32 }
  ];
  for (const [tab, freshness] of Object.entries(vm.freshness)) {
    tabs.addRow({ vmId: vm.vmId, tab, freshness });
  }
  return workbook;
}

function parseExportFormat(query: unknown): "json" | "csv" | "excel" {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const format = stringValue(raw.format);
  return format === "csv" || format === "excel" ? format : "json";
}

function columnValue(row: VmInventoryListItem, column: string): unknown {
  if (column === "datacenter") {
    return row.dataCenterName ?? row.dataCenterId;
  }
  if (column === "cluster") {
    return row.clusterName ?? row.clusterId;
  }
  if (column === "host") {
    return row.hostName ?? row.hostId;
  }
  if (column === "os") {
    return row.guestOsName ?? row.osType ?? row.guestOsVersion;
  }
  if (column === "storage") {
    return `${row.storageUsedGib ?? 0}/${row.storageProvisionedGib ?? 0} GiB`;
  }
  if (column === "snapshot") {
    return `${row.snapshotCount ?? 0} snapshots, oldest ${row.oldestSnapshotAgeDays ?? 0} days`;
  }
  return row[column];
}

function addFieldRows(rows: Array<Record<string, unknown>>, section: string, record: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(record)) {
    rows.push({ section, field, value: exportValue(value) });
  }
}

function addItemRows(rows: Array<Record<string, unknown>>, section: string, items: unknown[]): void {
  items.forEach((item, index) => {
    rows.push({ section, index: index + 1, value: exportValue(item) });
  });
}

function exportValue(value: unknown): unknown {
  return value && typeof value === "object" ? JSON.stringify(value) : value;
}

function columnTitle(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function stringValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  const text = stringValue(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : defaultInventoryColumns;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = optionalInteger(value);
  return parsed && parsed > 0 ? parsed : fallback;
}

function optionalInteger(value: unknown): number | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  const text = stringValue(value);
  if (text === "true" || text === "1") {
    return true;
  }
  if (text === "false" || text === "0") {
    return false;
  }
  return undefined;
}

function timestampString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}
