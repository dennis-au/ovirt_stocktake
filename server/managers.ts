import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./credentials.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";

interface ManagerRecord {
  id: string;
  name: string;
  url: string;
  enabled: number;
  ignore_tls: number;
  username_ciphertext: string;
  password_ciphertext: string;
  created_at: string;
  updated_at: string;
}

export interface PublicManager {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  ignoreTls: boolean;
  credentialStatus: "saved";
  createdAt: string;
  updatedAt: string;
}

export function registerManagerRoutes(app: FastifyInstance, db: SqliteDatabase, config: AppConfig): void {
  app.get("/api/managers", { preHandler: requireRole(roles.read) }, async () => ({ managers: listManagers(db) }));

  app.post("/api/managers", { preHandler: requireRole(roles.admin) }, async (request, reply) => {
    const input = parseManagerInput(request.body, true);
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }
    const encryptionKey = requireEncryptionKey(config, reply);
    if (!encryptionKey) {
      return;
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO managers
        (id, name, url, enabled, ignore_tls, username_ciphertext, password_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.value.name,
      input.value.url,
      input.value.enabled ? 1 : 0,
      input.value.ignoreTls ? 1 : 0,
      encryptSecret(input.value.username!, encryptionKey),
      encryptSecret(input.value.password!, encryptionKey),
      now,
      now
    );

    const manager = publicManager(findManager(db, id)!);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "manager.created",
      resourceType: "manager",
      resourceId: id,
      metadata: { name: manager.name, url: manager.url, enabled: manager.enabled, ignoreTls: manager.ignoreTls }
    });
    return reply.code(201).send({ manager });
  });

  app.patch("/api/managers/:id", { preHandler: requireRole(roles.admin) }, async (request, reply) => {
    const id = parseId(request.params);
    const existing = id ? findManager(db, id) : undefined;
    if (!id || !existing) {
      return reply.code(404).send({ error: "Manager not found" });
    }

    const input = parseManagerInput(request.body, false);
    if (!input.ok) {
      return reply.code(400).send({ error: input.error });
    }

    const credentialUpdate = input.value.username !== undefined || input.value.password !== undefined;
    const encryptionKey = credentialUpdate ? requireEncryptionKey(config, reply) : config.credentialEncryptionKey;
    if (credentialUpdate && !encryptionKey) {
      return;
    }

    const usernameCiphertext =
      input.value.username !== undefined ? encryptSecret(input.value.username, encryptionKey!) : existing.username_ciphertext;
    const passwordCiphertext =
      input.value.password !== undefined ? encryptSecret(input.value.password, encryptionKey!) : existing.password_ciphertext;

    db.prepare(
      `UPDATE managers
       SET name = ?, url = ?, enabled = ?, ignore_tls = ?, username_ciphertext = ?, password_ciphertext = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.value.name ?? existing.name,
      input.value.url ?? existing.url,
      (input.value.enabled ?? Boolean(existing.enabled)) ? 1 : 0,
      (input.value.ignoreTls ?? Boolean(existing.ignore_tls)) ? 1 : 0,
      usernameCiphertext,
      passwordCiphertext,
      new Date().toISOString(),
      id
    );

    const manager = publicManager(findManager(db, id)!);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "manager.updated",
      resourceType: "manager",
      resourceId: id,
      metadata: {
        name: manager.name,
        url: manager.url,
        enabled: manager.enabled,
        ignoreTls: manager.ignoreTls,
        loginMaterialUpdated: credentialUpdate
      }
    });
    return { manager };
  });

  app.delete("/api/managers/:id", { preHandler: requireRole(roles.admin) }, async (request, reply) => {
    const id = parseId(request.params);
    const existing = id ? findManager(db, id) : undefined;
    if (!id || !existing) {
      return reply.code(404).send({ error: "Manager not found" });
    }

    const result = db.prepare("DELETE FROM managers WHERE id = ?").run(id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: "Manager not found" });
    }
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "manager.deleted",
      resourceType: "manager",
      resourceId: id,
      metadata: { name: existing.name, url: existing.url }
    });
    return reply.code(204).send();
  });
}

export function listManagers(db: SqliteDatabase): PublicManager[] {
  return db
    .prepare("SELECT * FROM managers ORDER BY name COLLATE NOCASE")
    .all()
    .map((row) => publicManager(row as ManagerRecord));
}

function findManager(db: SqliteDatabase, id: string): ManagerRecord | undefined {
  return db.prepare("SELECT * FROM managers WHERE id = ?").get(id) as ManagerRecord | undefined;
}

function publicManager(row: ManagerRecord): PublicManager {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: Boolean(row.enabled),
    ignoreTls: Boolean(row.ignore_tls),
    credentialStatus: "saved",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseManagerInput(
  body: unknown,
  requireCredentials: boolean
):
  | {
      ok: true;
      value: {
        name?: string;
        url?: string;
        enabled?: boolean;
        ignoreTls?: boolean;
        username?: string;
        password?: string;
      };
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be an object" };
  }

  const raw = body as Record<string, unknown>;
  const value: { name?: string; url?: string; enabled?: boolean; ignoreTls?: boolean; username?: string; password?: string } = {};

  if (typeof raw.name === "string") {
    value.name = raw.name.trim();
    if (!value.name) {
      return { ok: false, error: "Manager name is required" };
    }
  } else if (requireCredentials) {
    return { ok: false, error: "Manager name is required" };
  }

  if (typeof raw.url === "string") {
    const normalized = normalizeManagerUrl(raw.url);
    if (!normalized) {
      return { ok: false, error: "Manager URL must be an http(s) URL without query or fragment" };
    }
    value.url = normalized;
  } else if (requireCredentials) {
    return { ok: false, error: "Manager URL is required" };
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      return { ok: false, error: "Manager enabled must be true or false" };
    }
    value.enabled = raw.enabled;
  } else if (requireCredentials) {
    value.enabled = true;
  }

  if (raw.ignoreTls !== undefined) {
    if (typeof raw.ignoreTls !== "boolean") {
      return { ok: false, error: "Manager ignoreTls must be true or false" };
    }
    value.ignoreTls = raw.ignoreTls;
  } else if (requireCredentials) {
    value.ignoreTls = false;
  }

  if (raw.username !== undefined || raw.password !== undefined || requireCredentials) {
    if (typeof raw.username !== "string" || !raw.username.trim() || typeof raw.password !== "string" || !raw.password) {
      return { ok: false, error: "Manager username and password are required together" };
    }
    value.username = raw.username.trim();
    value.password = raw.password;
  }

  return { ok: true, value };
}

export function normalizeManagerUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash) {
      return undefined;
    }

    let pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/ovirt-engine/api")) {
      pathname = pathname.slice(0, -"/api".length);
    }
    if (!pathname) {
      pathname = "";
    }
    parsed.pathname = pathname;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function requireEncryptionKey(config: AppConfig, reply: FastifyReply): string | undefined {
  if (!config.credentialEncryptionKey) {
    void reply.code(503).send({ error: "OVIRT_INVENTORY_ENCRYPTION_KEY is required" });
    return undefined;
  }
  return config.credentialEncryptionKey;
}

function parseId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const value = (params as Record<string, unknown>).id;
  return typeof value === "string" && value ? value : undefined;
}
