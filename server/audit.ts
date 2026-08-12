import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db.js";

export interface AuditInput {
  actor?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: unknown;
}

export interface AuditLog {
  id: string;
  actor?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata: unknown;
  createdAt: string;
}

interface AuditRow {
  id: string;
  actor: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata_json: string;
  created_at: string;
}

const secretKeyPattern = /(password|credential|authorization|token|secret)/i;

export function recordAudit(db: SqliteDatabase, input: AuditInput): AuditLog {
  const id = randomUUID();
  const metadata = sanitizeAuditValue(input.metadata ?? {});
  db.prepare(
    `INSERT INTO audit_logs
      (id, actor, action, resource_type, resource_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.actor ?? null, input.action, input.resourceType ?? null, input.resourceId ?? null, JSON.stringify(metadata));

  return auditLog(
    db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(id) as AuditRow
  );
}

export function listAuditLogs(db: SqliteDatabase, limit = 200): AuditLog[] {
  return db
    .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit)
    .map((row) => auditLog(row as AuditRow));
}

export function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretKeyPattern.test(key))
      .map(([key, child]) => [key, sanitizeAuditValue(child)])
  );
}

function auditLog(row: AuditRow): AuditLog {
  return {
    id: row.id,
    actor: row.actor ?? undefined,
    action: row.action,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    metadata: JSON.parse(row.metadata_json) as unknown,
    createdAt: row.created_at
  };
}
