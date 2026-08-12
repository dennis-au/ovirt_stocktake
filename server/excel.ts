import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import type { AppRole } from "./rbac.js";
import { redactInventoryResources, requireRole, roles } from "./rbac.js";
import { latestSuccessfulSnapshotDetail, redactSnapshotDetail, snapshotDetailById, type SnapshotDetail } from "./snapshots.js";
import { resourceKeys, type InventoryResource } from "../shared/snapshot.js";

type SnapshotExportFormat = "json" | "csv" | "excel";

export function registerExcelRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/exports/excel", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const snapshotId = parseSnapshotId(request.query);
    const snapshot = snapshotId ? snapshotDetailById(db, snapshotId) : latestSuccessfulSnapshotDetail(db);
    if (!snapshot) {
      return reply.code(404).send({ error: "Snapshot not found" });
    }

    const session = currentSession(db, request);
    const workbook = buildSnapshotWorkbook(snapshot, session?.role ?? "viewer");
    const buffer = await workbook.xlsx.writeBuffer();
    recordAudit(db, {
      actor: session?.username,
      action: "export.excel",
      resourceType: "snapshot",
      resourceId: snapshot.id,
      metadata: { snapshotId: snapshot.id, managerId: snapshot.managerId, format: "xlsx" }
    });
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="ovirt-inventory-${snapshot.id}.xlsx"`)
      .send(Buffer.from(buffer));
  });

  app.get("/api/exports/snapshot", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const snapshotId = parseSnapshotId(request.query);
    const snapshot = snapshotId ? snapshotDetailById(db, snapshotId) : latestSuccessfulSnapshotDetail(db);
    if (!snapshot) {
      return reply.code(404).send({ error: "Snapshot not found" });
    }

    const session = currentSession(db, request);
    const role = session?.role ?? "viewer";
    const format = parseExportFormat(request.query);
    recordAudit(db, {
      actor: session?.username,
      action: "export.snapshot",
      resourceType: "snapshot",
      resourceId: snapshot.id,
      metadata: { snapshotId: snapshot.id, managerId: snapshot.managerId, format }
    });

    if (format === "json") {
      return { snapshot: redactSnapshotDetail(role, snapshot) };
    }
    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="ovirt-inventory-${snapshot.id}.csv"`)
        .send(snapshotCsv(snapshot, role));
    }

    const workbook = buildSnapshotWorkbook(snapshot, role);
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="ovirt-inventory-${snapshot.id}.xlsx"`)
      .send(Buffer.from(buffer));
  });
}

export function buildSnapshotWorkbook(snapshot: SnapshotDetail, role: AppRole = "admin"): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ovirt-inventory";
  workbook.created = new Date();
  const resources = redactInventoryResources(role, snapshot.resources);

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Field", key: "field", width: 24 },
    { header: "Value", key: "value", width: 48 }
  ];
  summary.addRows([
    { field: "Snapshot ID", value: snapshot.id },
    { field: "Manager ID", value: snapshot.managerId },
    { field: "Manager Name", value: snapshot.managerName },
    { field: "Manager URL", value: snapshot.managerUrl },
    { field: "Collected At", value: snapshot.collectedAt },
    { field: "API Version", value: snapshot.apiVersion },
    { field: "Status", value: snapshot.status },
    { field: "Duration Ms", value: snapshot.durationMs },
    { field: "Warnings", value: snapshot.warningsCount },
    { field: "Errors", value: snapshot.errorsCount }
  ]);

  const managers = workbook.addWorksheet("Managers");
  managers.columns = [
    { header: "Manager ID", key: "managerId", width: 38 },
    { header: "Manager Name", key: "managerName", width: 24 },
    { header: "Manager URL", key: "managerUrl", width: 38 },
    { header: "Snapshot ID", key: "snapshotId", width: 38 },
    { header: "Collected At", key: "collectedAt", width: 28 },
    { header: "Status", key: "status", width: 14 }
  ];
  managers.addRow({
    managerId: snapshot.managerId,
    managerName: snapshot.managerName,
    managerUrl: snapshot.managerUrl,
    snapshotId: snapshot.id,
    collectedAt: snapshot.collectedAt,
    status: snapshot.status
  });

  for (const key of resourceKeys) {
    addResourceSheet(workbook, sheetName(key), resources[key], snapshot);
  }

  addIssueSheet(workbook, "Warnings", snapshot.warnings, snapshot);
  addIssueSheet(workbook, "Errors", snapshot.errors, snapshot);
  return workbook;
}

function addResourceSheet(workbook: ExcelJS.Workbook, name: string, rows: InventoryResource[], snapshot: SnapshotDetail): void {
  const keys = orderedKeys(rows);
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: "Manager ID", key: "managerId", width: 38 },
    { header: "Manager Name", key: "managerName", width: 24 },
    { header: "Snapshot ID", key: "snapshotId", width: 38 },
    ...keys.map((key) => ({ header: titleCase(key), key, width: 24 }))
  ];

  for (const row of rows) {
    sheet.addRow({
      managerId: snapshot.managerId,
      managerName: snapshot.managerName,
      snapshotId: snapshot.id,
      ...Object.fromEntries(keys.map((key) => [key, cellValue(row[key])]))
    });
  }
}

function addIssueSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: SnapshotDetail["warnings"],
  snapshot: SnapshotDetail
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: "Manager ID", key: "managerId", width: 38 },
    { header: "Manager Name", key: "managerName", width: 24 },
    { header: "Snapshot ID", key: "snapshotId", width: 38 },
    { header: "Resource", key: "resource", width: 20 },
    { header: "Message", key: "message", width: 80 }
  ];
  for (const row of rows) {
    sheet.addRow({
      managerId: snapshot.managerId,
      managerName: snapshot.managerName,
      snapshotId: snapshot.id,
      resource: row.resource ?? "",
      message: row.message
    });
  }
}

function orderedKeys(rows: InventoryResource[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keys.add(key);
    }
  }
  return [...["id", "name", "status"], ...[...keys].filter((key) => !["id", "name", "status"].includes(key)).sort()];
}

function cellValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return value as string | number | boolean;
  }
  if (typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return JSON.stringify(value);
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function sheetName(value: string): string {
  if (value === "vms") {
    return "VMs";
  }
  if (value === "vmSnapshots") {
    return "VM Snapshots";
  }
  if (value === "vnicProfiles") {
    return "vNIC Profiles";
  }
  if (value === "storageDomains") {
    return "Storage Domains";
  }
  return titleCase(value);
}

function parseSnapshotId(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>).snapshotId;
  return typeof value === "string" && value ? value : undefined;
}

function parseExportFormat(query: unknown): SnapshotExportFormat {
  if (!query || typeof query !== "object") {
    return "json";
  }
  const value = (query as Record<string, unknown>).format;
  return value === "csv" || value === "excel" ? value : "json";
}

function snapshotCsv(snapshot: SnapshotDetail, role: AppRole): string {
  const redacted = redactSnapshotDetail(role, snapshot);
  const rows: Array<Record<string, unknown>> = [
    {
      section: "summary",
      resourceType: "snapshot",
      resourceId: redacted.id,
      name: redacted.managerName,
      payload: {
        managerId: redacted.managerId,
        managerUrl: redacted.managerUrl,
        collectedAt: redacted.collectedAt,
        apiVersion: redacted.apiVersion,
        status: redacted.status,
        durationMs: redacted.durationMs,
        resourceCounts: redacted.resourceCounts,
        warningsCount: redacted.warningsCount,
        errorsCount: redacted.errorsCount
      }
    }
  ];

  for (const key of resourceKeys) {
    for (const resource of redacted.resources[key]) {
      rows.push({
        section: "resource",
        resourceType: key,
        resourceId: resource.id,
        name: resource.name,
        payload: resource
      });
    }
  }

  redacted.warnings.forEach((warning, index) => {
    rows.push({ section: "warning", resourceType: warning.resource, resourceId: index + 1, payload: warning });
  });
  redacted.errors.forEach((error, index) => {
    rows.push({ section: "error", resourceType: error.resource, resourceId: index + 1, payload: error });
  });

  const columns = ["section", "resourceType", "resourceId", "name", "payload"];
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n");
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}
