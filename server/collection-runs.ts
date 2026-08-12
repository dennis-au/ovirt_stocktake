import type { FastifyInstance } from "fastify";
import { sanitizeAuditValue } from "./audit.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";

export interface CollectionRunSummary {
  id: string;
  managerId: string;
  managerName?: string;
  status: string;
  apiVersion?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  warningsCount: number;
  errorsCount: number;
  createdAt: string;
}

export interface CollectionRunDetail extends CollectionRunSummary {
  warnings: unknown[];
  errors: unknown[];
}

interface CollectionRunRow {
  id: string;
  manager_id: string;
  manager_name: string | null;
  status: string;
  api_version: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  duration_ms: number | null;
  warnings: unknown;
  errors: unknown;
  created_at: Date | string;
}

export function registerCollectionRunRoutes(app: FastifyInstance, inventoryDb?: ConnectablePostgres): void {
  app.get("/api/collection-runs", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    return { collectionRuns: await listCollectionRuns(inventoryDb, parseCollectionRunQuery(request.query)) };
  });

  app.get("/api/collection-runs/:id", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL inventory store is not configured" });
    }

    const id = parseId(request.params);
    const collectionRun = id ? await findCollectionRun(inventoryDb, id) : undefined;
    if (!collectionRun) {
      return reply.code(404).send({ error: "Collection run not found" });
    }
    return { collectionRun };
  });
}

export async function listCollectionRuns(
  db: ConnectablePostgres,
  query: { managerId?: string; limit: number }
): Promise<CollectionRunSummary[]> {
  const values: unknown[] = [];
  let where = "";
  if (query.managerId) {
    values.push(query.managerId);
    where = `WHERE r.manager_id = $${values.length}`;
  }
  values.push(query.limit);

  const result = await db.query<CollectionRunRow>(
    `
      SELECT r.id, r.manager_id, m.name AS manager_name, r.status, r.api_version, r.started_at,
             r.completed_at, r.duration_ms, r.warnings, r.errors, r.created_at
      FROM collection_runs r
      LEFT JOIN managers m ON m.id = r.manager_id
      ${where}
      ORDER BY r.started_at DESC, r.created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return result.rows.map(collectionRunSummary);
}

export async function findCollectionRun(db: ConnectablePostgres, id: string): Promise<CollectionRunDetail | undefined> {
  const row = (
    await db.query<CollectionRunRow>(
      `
        SELECT r.id, r.manager_id, m.name AS manager_name, r.status, r.api_version, r.started_at,
               r.completed_at, r.duration_ms, r.warnings, r.errors, r.created_at
        FROM collection_runs r
        LEFT JOIN managers m ON m.id = r.manager_id
        WHERE r.id = $1
        LIMIT 1
      `,
      [id]
    )
  ).rows[0];

  return row
    ? {
        ...collectionRunSummary(row),
        warnings: sanitizeIssueArray(row.warnings),
        errors: sanitizeIssueArray(row.errors)
      }
    : undefined;
}

function collectionRunSummary(row: CollectionRunRow): CollectionRunSummary {
  return {
    id: row.id,
    managerId: row.manager_id,
    managerName: row.manager_name ?? undefined,
    status: row.status,
    apiVersion: row.api_version ?? undefined,
    startedAt: isoRequired(row.started_at),
    completedAt: iso(row.completed_at),
    durationMs: row.duration_ms ?? undefined,
    warningsCount: sanitizeIssueArray(row.warnings).length,
    errorsCount: sanitizeIssueArray(row.errors).length,
    createdAt: isoRequired(row.created_at)
  };
}

function parseCollectionRunQuery(query: unknown): { managerId?: string; limit: number } {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  return {
    managerId: stringValue(raw.managerId),
    limit: positiveInteger(raw.limit, 100)
  };
}

function parseId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  return stringValue((params as Record<string, unknown>).id);
}

function sanitizeIssueArray(value: unknown): unknown[] {
  const parsed = jsonArray(value);
  const sanitized = sanitizeAuditValue(parsed);
  return Array.isArray(sanitized) ? sanitized : [];
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function positiveInteger(value: unknown, fallback: number): number {
  const text = stringValue(value);
  if (!text) {
    return fallback;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

function stringValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return stringValue(value[0]);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" && value ? value : undefined;
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
