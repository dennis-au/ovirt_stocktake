import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";

export interface SavedView {
  id: string;
  ownerUsername: string;
  name: string;
  scope: string;
  filters: Record<string, unknown>;
  columns: string[];
  sort: Record<string, unknown>;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
}

interface SavedViewRow {
  id: string;
  owner_username: string;
  name: string;
  scope: string;
  filters_json: string;
  columns_json: string;
  sort_json: string;
  visibility: "private" | "shared";
  created_at: string;
  updated_at: string;
}

export function registerSavedViewRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/saved-views", { preHandler: requireRole(roles.read) }, async (request) => {
    const session = currentSession(db, request);
    const scope = stringValue((request.query as Record<string, unknown> | undefined)?.scope);
    return { savedViews: listSavedViews(db, session?.username ?? "", scope) };
  });

  app.post("/api/saved-views", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const session = currentSession(db, request);
    const input = parseSavedViewInput(request.body, true);
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO saved_views
        (id, owner_username, name, scope, filters_json, columns_json, sort_json, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      session?.username ?? "",
      input.value.name,
      input.value.scope,
      JSON.stringify(input.value.filters ?? {}),
      JSON.stringify(input.value.columns ?? []),
      JSON.stringify(input.value.sort ?? {}),
      input.value.visibility ?? "private",
      now,
      now
    );

    recordAudit(db, {
      actor: session?.username,
      action: "saved_view.created",
      resourceType: "saved_view",
      resourceId: id,
      metadata: { name: input.value.name, scope: input.value.scope, visibility: input.value.visibility ?? "private" }
    });
    return reply.code(201).send({ savedView: findSavedView(db, id)! });
  });

  app.patch("/api/saved-views/:id", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const session = currentSession(db, request);
    const id = parseId(request.params);
    const existing = id ? findSavedView(db, id) : undefined;
    if (!id || !existing || existing.ownerUsername !== session?.username) {
      return reply.code(404).send({ error: "Saved view not found" });
    }

    const input = parseSavedViewInput(request.body, false);
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }

    db.prepare(
      `UPDATE saved_views
       SET name = ?, scope = ?, filters_json = ?, columns_json = ?, sort_json = ?, visibility = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.value.name ?? existing.name,
      input.value.scope ?? existing.scope,
      JSON.stringify(input.value.filters ?? existing.filters),
      JSON.stringify(input.value.columns ?? existing.columns),
      JSON.stringify(input.value.sort ?? existing.sort),
      input.value.visibility ?? existing.visibility,
      new Date().toISOString(),
      id
    );

    recordAudit(db, {
      actor: session?.username,
      action: "saved_view.updated",
      resourceType: "saved_view",
      resourceId: id,
      metadata: { name: input.value.name ?? existing.name, scope: input.value.scope ?? existing.scope }
    });
    return { savedView: findSavedView(db, id)! };
  });

  app.delete("/api/saved-views/:id", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const session = currentSession(db, request);
    const id = parseId(request.params);
    const existing = id ? findSavedView(db, id) : undefined;
    if (!id || !existing || existing.ownerUsername !== session?.username) {
      return reply.code(404).send({ error: "Saved view not found" });
    }

    db.prepare("DELETE FROM saved_views WHERE id = ?").run(id);
    recordAudit(db, {
      actor: session?.username,
      action: "saved_view.deleted",
      resourceType: "saved_view",
      resourceId: id,
      metadata: { name: existing.name, scope: existing.scope }
    });
    return reply.code(204).send();
  });
}

export function listSavedViews(db: SqliteDatabase, ownerUsername: string, scope?: string): SavedView[] {
  const rows = scope
    ? db
        .prepare(
          `SELECT * FROM saved_views
           WHERE scope = ? AND (owner_username = ? OR visibility = 'shared')
           ORDER BY updated_at DESC, name COLLATE NOCASE`
        )
        .all(scope, ownerUsername)
    : db
        .prepare(
          `SELECT * FROM saved_views
           WHERE owner_username = ? OR visibility = 'shared'
           ORDER BY updated_at DESC, name COLLATE NOCASE`
        )
        .all(ownerUsername);
  return rows.map((row) => savedView(row as SavedViewRow));
}

function findSavedView(db: SqliteDatabase, id: string): SavedView | undefined {
  const row = db.prepare("SELECT * FROM saved_views WHERE id = ?").get(id) as SavedViewRow | undefined;
  return row ? savedView(row) : undefined;
}

function savedView(row: SavedViewRow): SavedView {
  return {
    id: row.id,
    ownerUsername: row.owner_username,
    name: row.name,
    scope: row.scope,
    filters: JSON.parse(row.filters_json) as Record<string, unknown>,
    columns: JSON.parse(row.columns_json) as string[],
    sort: JSON.parse(row.sort_json) as Record<string, unknown>,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseSavedViewInput(
  body: unknown,
  requireFields: boolean
):
  | {
      ok: true;
      value: {
        name?: string;
        scope?: string;
        filters?: Record<string, unknown>;
        columns?: string[];
        sort?: Record<string, unknown>;
        visibility?: "private" | "shared";
      };
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Saved view body must be an object" };
  }
  const raw = body as Record<string, unknown>;
  const value: {
    name?: string;
    scope?: string;
    filters?: Record<string, unknown>;
    columns?: string[];
    sort?: Record<string, unknown>;
    visibility?: "private" | "shared";
  } = {};

  value.name = stringValue(raw.name);
  value.scope = stringValue(raw.scope);
  if (requireFields && (!value.name || !value.scope)) {
    return { ok: false, error: "Saved view name and scope are required" };
  }
  if (raw.filters !== undefined) {
    if (!isRecord(raw.filters)) {
      return { ok: false, error: "Saved view filters must be an object" };
    }
    value.filters = raw.filters;
  }
  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns) || raw.columns.some((column) => typeof column !== "string" || !column.trim())) {
      return { ok: false, error: "Saved view columns must be an array of strings" };
    }
    value.columns = raw.columns.map((column) => column.trim());
  }
  if (raw.sort !== undefined) {
    if (!isRecord(raw.sort)) {
      return { ok: false, error: "Saved view sort must be an object" };
    }
    value.sort = raw.sort;
  }
  if (raw.visibility !== undefined) {
    if (raw.visibility !== "private" && raw.visibility !== "shared") {
      return { ok: false, error: "Saved view visibility must be private or shared" };
    }
    value.visibility = raw.visibility;
  }
  return { ok: true, value };
}

function parseId(params: unknown): string | undefined {
  return params && typeof params === "object" && typeof (params as Record<string, unknown>).id === "string"
    ? ((params as Record<string, unknown>).id as string)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
