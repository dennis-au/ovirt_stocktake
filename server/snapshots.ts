import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import type { AppRole } from "./rbac.js";
import { redactInventoryResources, requireRole, roles } from "./rbac.js";
import { resourceKeys, type CollectionIssue, type InventoryResources, type SnapshotPayload, type SnapshotStatus } from "../shared/snapshot.js";

interface SnapshotRecord {
  id: string;
  manager_id: string;
  manager_name: string;
  manager_url: string;
  collected_at: string;
  api_version: string;
  duration_ms: number;
  status: SnapshotStatus;
  resources_json: string;
  warnings_json: string;
  errors_json: string;
  created_at: string;
}

export interface SnapshotSummary {
  id: string;
  managerId: string;
  managerName: string;
  managerUrl: string;
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  resourceCounts: Record<(typeof resourceKeys)[number], number>;
  warningsCount: number;
  errorsCount: number;
  createdAt: string;
}

export interface SnapshotDetail extends SnapshotSummary {
  resources: InventoryResources;
  warnings: CollectionIssue[];
  errors: CollectionIssue[];
}

export function registerSnapshotRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.post("/api/snapshots", { preHandler: requireRole(roles.operator) }, async (request, reply) => {
    const parsed = parseSnapshotPayload(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    const manager = db.prepare("SELECT id FROM managers WHERE id = ?").get(parsed.value.managerId);
    if (!manager) {
      return reply.code(404).send({ error: "Manager not found" });
    }

    const snapshot = saveSnapshotPayload(db, parsed.value);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "snapshot.saved",
      resourceType: "manager",
      resourceId: snapshot.managerId,
      metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
    });
    return reply.code(201).send({ snapshot: redactSnapshotDetail(sessionRole(db, request), snapshot) });
  });

  app.get("/api/snapshots", { preHandler: requireRole(roles.read) }, async (request) => {
    const managerId = parseManagerQuery(request.query);
    return { snapshots: listSnapshots(db, managerId) };
  });

  app.get("/api/snapshots/latest", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const managerId = parseManagerQuery(request.query);
    const snapshot = latestSuccessfulSnapshot(db, managerId);
    if (!snapshot) {
      return reply.code(404).send({ error: "Snapshot not found" });
    }
    return { snapshot: redactSnapshotDetail(sessionRole(db, request), snapshotDetail(snapshot)) };
  });

  app.get("/api/snapshots/:id", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const id = parseId(request.params);
    const snapshot = id ? findSnapshot(db, id) : undefined;
    if (!snapshot) {
      return reply.code(404).send({ error: "Snapshot not found" });
    }
    return { snapshot: redactSnapshotDetail(sessionRole(db, request), snapshotDetail(snapshot)) };
  });
}

export function saveSnapshotPayload(db: SqliteDatabase, payload: SnapshotPayload): SnapshotDetail {
  const parsed = parseSnapshotPayload(payload);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO snapshots
      (id, manager_id, manager_name, manager_url, collected_at, api_version, duration_ms, status, resources_json, warnings_json, errors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    parsed.value.managerId,
    parsed.value.managerName,
    parsed.value.managerUrl,
    parsed.value.collectedAt,
    parsed.value.apiVersion,
    parsed.value.durationMs,
    parsed.value.status,
    JSON.stringify(parsed.value.resources),
    JSON.stringify(parsed.value.warnings),
    JSON.stringify(parsed.value.errors)
  );

  return snapshotDetail(findSnapshot(db, id)!);
}

export function listSnapshots(db: SqliteDatabase, managerId?: string): SnapshotSummary[] {
  const rows = managerId
    ? db.prepare("SELECT * FROM snapshots WHERE manager_id = ? ORDER BY collected_at DESC, created_at DESC").all(managerId)
    : db.prepare("SELECT * FROM snapshots ORDER BY collected_at DESC, created_at DESC").all();
  return rows.map((row) => snapshotSummary(row as SnapshotRecord));
}

export function latestSuccessfulSnapshot(db: SqliteDatabase, managerId?: string): SnapshotRecord | undefined {
  const sql = managerId
    ? "SELECT * FROM snapshots WHERE status = 'success' AND manager_id = ? ORDER BY collected_at DESC, created_at DESC LIMIT 1"
    : "SELECT * FROM snapshots WHERE status = 'success' ORDER BY collected_at DESC, created_at DESC LIMIT 1";
  return (managerId ? db.prepare(sql).get(managerId) : db.prepare(sql).get()) as SnapshotRecord | undefined;
}

function findSnapshot(db: SqliteDatabase, id: string): SnapshotRecord | undefined {
  return db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRecord | undefined;
}

export function snapshotDetailById(db: SqliteDatabase, id: string): SnapshotDetail | undefined {
  const snapshot = findSnapshot(db, id);
  return snapshot ? snapshotDetail(snapshot) : undefined;
}

export function latestSuccessfulSnapshotDetail(db: SqliteDatabase): SnapshotDetail | undefined {
  const snapshot = latestSuccessfulSnapshot(db);
  return snapshot ? snapshotDetail(snapshot) : undefined;
}

export function redactSnapshotDetail(role: AppRole, snapshot: SnapshotDetail): SnapshotDetail {
  return {
    ...snapshot,
    resources: redactInventoryResources(role, snapshot.resources)
  };
}

function snapshotSummary(row: SnapshotRecord): SnapshotSummary {
  const resources = JSON.parse(row.resources_json) as InventoryResources;
  return {
    id: row.id,
    managerId: row.manager_id,
    managerName: row.manager_name,
    managerUrl: row.manager_url,
    collectedAt: row.collected_at,
    apiVersion: row.api_version,
    durationMs: row.duration_ms,
    status: row.status,
    resourceCounts: Object.fromEntries(resourceKeys.map((key) => [key, resources[key].length])) as SnapshotSummary["resourceCounts"],
    warningsCount: (JSON.parse(row.warnings_json) as CollectionIssue[]).length,
    errorsCount: (JSON.parse(row.errors_json) as CollectionIssue[]).length,
    createdAt: row.created_at
  };
}

function snapshotDetail(row: SnapshotRecord): SnapshotDetail {
  return {
    ...snapshotSummary(row),
    resources: JSON.parse(row.resources_json) as InventoryResources,
    warnings: JSON.parse(row.warnings_json) as CollectionIssue[],
    errors: JSON.parse(row.errors_json) as CollectionIssue[]
  };
}

function parseSnapshotPayload(body: unknown): { ok: true; value: SnapshotPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Snapshot body must be an object" };
  }
  if (containsSecretKey(body)) {
    return { ok: false, error: "Snapshot must not contain credentials or authorization data" };
  }

  const value = body as Partial<SnapshotPayload>;
  if (!isNonEmptyString(value.managerId) || !isNonEmptyString(value.managerName) || !isNonEmptyString(value.managerUrl)) {
    return { ok: false, error: "Snapshot manager fields are required" };
  }
  if (!isNonEmptyString(value.collectedAt) || Number.isNaN(Date.parse(value.collectedAt))) {
    return { ok: false, error: "Snapshot collectedAt must be a valid timestamp" };
  }
  if (!isNonEmptyString(value.apiVersion)) {
    return { ok: false, error: "Snapshot apiVersion is required" };
  }
  if (typeof value.durationMs !== "number" || !Number.isInteger(value.durationMs) || value.durationMs < 0) {
    return { ok: false, error: "Snapshot durationMs must be a non-negative integer" };
  }
  if (!["success", "partial", "failed"].includes(String(value.status))) {
    return { ok: false, error: "Snapshot status is invalid" };
  }
  if (!value.resources || typeof value.resources !== "object") {
    return { ok: false, error: "Snapshot resources are required" };
  }
  for (const key of resourceKeys) {
    if (!Array.isArray((value.resources as Record<string, unknown>)[key])) {
      return { ok: false, error: `Snapshot resources.${key} must be an array` };
    }
  }
  if (!Array.isArray(value.warnings) || !Array.isArray(value.errors)) {
    return { ok: false, error: "Snapshot warnings and errors must be arrays" };
  }

  return { ok: true, value: value as SnapshotPayload };
}

function containsSecretKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(containsSecretKey);
  }

  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase();
    return ["password", "credential", "authorization", "token", "secret"].includes(normalized) || containsSecretKey(child);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const value = (params as Record<string, unknown>).id;
  return typeof value === "string" && value ? value : undefined;
}

function parseManagerQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>).managerId;
  return typeof value === "string" && value ? value : undefined;
}

function sessionRole(db: SqliteDatabase, request: Parameters<typeof currentSession>[1]): AppRole {
  return currentSession(db, request)?.role ?? "viewer";
}
