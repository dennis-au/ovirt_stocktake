import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { recordAudit } from "./audit.js";
import { currentSession } from "./auth.js";
import { integrationStatuses, queryExceptions, type ExceptionType } from "./postgres/exceptions.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";

type ExportFormat = "json" | "csv" | "excel";

export function registerExceptionRoutes(app: FastifyInstance, inventoryDb?: ConnectablePostgres): void {
  app.get("/api/exceptions", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }
    const session = currentSession(request.server.sqlite, request);
    return { exceptions: await queryExceptions(inventoryDb, session?.role ?? "viewer", exceptionType(request.query)) };
  });

  app.get("/api/exports/exceptions", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const session = currentSession(request.server.sqlite, request);
    const type = exceptionType(request.query);
    const format = parseExportFormat(request.query);
    const exceptions = await queryExceptions(inventoryDb, session?.role ?? "viewer", type);
    recordAudit(request.server.sqlite, {
      actor: session?.username,
      action: "export.exceptions",
      metadata: { format, type: type ?? "all", rows: exceptions.length }
    });

    if (format === "json") {
      return { exceptions };
    }
    if (format === "csv") {
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-exceptions.csv\"")
        .send(exceptionsCsv(exceptions));
    }

    const workbook = exceptionsWorkbook(exceptions);
    const buffer = await workbook.xlsx.writeBuffer();
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", "attachment; filename=\"ovirt-inventory-exceptions.xlsx\"")
      .send(Buffer.from(buffer));
  });

  app.get("/api/integrations/status", { preHandler: requireRole(roles.read) }, async () => ({ integrations: integrationStatuses() }));
}

function exceptionType(query: unknown): ExceptionType | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>).type;
  if (
    value === "backup_non_compliance" ||
    value === "rpo_breach" ||
    value === "restore_test_gap" ||
    value === "unsupported_os" ||
    value === "critical_vulnerabilities" ||
    value === "public_exposure" ||
    value === "retirement_candidate" ||
    value === "snapshot_risk"
  ) {
    return value;
  }
  return undefined;
}

function parseExportFormat(query: unknown): ExportFormat {
  if (!query || typeof query !== "object") {
    return "json";
  }
  const value = (query as Record<string, unknown>).format;
  return value === "csv" || value === "excel" ? value : "json";
}

function exceptionsCsv(exceptions: Array<Record<string, unknown>>): string {
  const columns = ["type", "severity", "managerId", "vmId", "name", "evidence", "recommendedAction", "href"];
  return [columns.join(","), ...exceptions.map((item) => columns.map((column) => csvCell(item[column])).join(","))].join("\n");
}

function exceptionsWorkbook(exceptions: Array<Record<string, unknown>>): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ovirt-inventory";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Exceptions");
  sheet.columns = [
    { header: "Type", key: "type", width: 26 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Manager ID", key: "managerId", width: 24 },
    { header: "VM ID", key: "vmId", width: 24 },
    { header: "Name", key: "name", width: 24 },
    { header: "Evidence", key: "evidence", width: 44 },
    { header: "Recommended Action", key: "recommendedAction", width: 56 },
    { header: "Link", key: "href", width: 48 }
  ];

  for (const item of exceptions) {
    sheet.addRow({
      ...item,
      evidence: JSON.stringify(item.evidence ?? {})
    });
  }
  return workbook;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}
