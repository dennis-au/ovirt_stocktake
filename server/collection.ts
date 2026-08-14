import type { FastifyInstance, FastifyReply } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { decryptSecret } from "./credentials.js";
import type { SqliteDatabase } from "./db.js";
import { normalizeManagerUrl } from "./managers.js";
import { snapshotToInventorySyncInput } from "./ovirt-normalize.js";
import { collectOvirtSnapshot, type OvirtCollectionTarget } from "./ovirt.js";
import { replaceCurrentInventory, type ConnectablePostgres } from "./postgres/inventory.js";
import { saveSnapshotPayload, type SnapshotDetail, type SnapshotSummary } from "./snapshots.js";
import { requireRole, roles } from "./rbac.js";
import { applySnapshotRetention } from "./settings.js";
import {
  emptyInventoryResources,
  resourceKeys,
  type CollectionIssue,
  type InventoryResources,
  type SnapshotPayload,
  type SnapshotStatus
} from "../shared/snapshot.js";

interface ManagerCredentialRecord {
  id: string;
  name: string;
  url: string;
  enabled: number;
  ignore_tls: number;
  username_ciphertext: string;
  password_ciphertext: string;
}

const BULK_COLLECTION_CONCURRENCY = 2;

export interface CollectionTestResult {
  managerName: string;
  managerUrl: string;
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  resourceCounts: Record<(typeof resourceKeys)[number], number>;
  warningsCount: number;
  errorsCount: number;
  warnings: CollectionIssue[];
  errors: CollectionIssue[];
}

export function registerCollectionRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): void {
  app.post("/api/managers/test-collection", { preHandler: requireRole(roles.admin) }, async (request, reply) => {
    const parsed = testCollectionTarget(db, request.body, config.credentialEncryptionKey);
    if (!parsed.ok) {
      return reply.code(parsed.statusCode).send({ error: parsed.error });
    }

    const payload = await collectOvirtSnapshot(parsed.value.target, { allowInsecureTls: parsed.value.allowInsecureTls });
    const result = collectionTestResult(payload);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "collection.test_completed",
      resourceType: parsed.value.managerId ? "manager" : undefined,
      resourceId: parsed.value.managerId,
      metadata: {
        managerName: result.managerName,
        managerUrl: result.managerUrl,
        status: result.status,
        warnings: result.warningsCount,
        errors: result.errorsCount
      }
    });
    return { result };
  });

  app.post("/api/managers/:id/collect", { preHandler: requireRole(roles.operator) }, async (request, reply) => {
    const id = parseId(request.params);
    const manager = id ? findManager(db, id) : undefined;
    if (!id || !manager) {
      return reply.code(404).send({ error: "Manager not found" });
    }
    if (!manager.enabled) {
      return reply.code(409).send({ error: "Manager is disabled" });
    }

    const encryptionKey = requireEncryptionKey(config, reply);
    if (!encryptionKey) {
      return;
    }

    const snapshot = await collectAndSaveManagerSnapshot(db, manager, encryptionKey, config.ovirtAllowInsecureTls, config, inventoryDb);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "collection.completed",
      resourceType: "manager",
      resourceId: manager.id,
      metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
    });
    return { snapshot };
  });

  app.post("/api/collect", { preHandler: requireRole(roles.operator) }, async (request, reply) => {
    const encryptionKey = requireEncryptionKey(config, reply);
    if (!encryptionKey) {
      return;
    }

    const actor = currentSession(db, request)?.username;
    const snapshots = await collectManagersConcurrently(
      listEnabledManagers(db),
      BULK_COLLECTION_CONCURRENCY,
      async (manager) => {
        const snapshot = await collectAndSaveManagerSnapshot(db, manager, encryptionKey, config.ovirtAllowInsecureTls, config, inventoryDb);
        recordAudit(db, {
          actor,
          action: "collection.completed",
          resourceType: "manager",
          resourceId: manager.id,
          metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
        });
        return snapshot;
      }
    );
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "collection.bulk_completed",
      metadata: { managers: snapshots.length }
    });
    return { snapshots: snapshots.map(snapshotSummary) };
  });
}

export async function collectEnabledManagers(
  db: SqliteDatabase,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): Promise<SnapshotDetail[]> {
  if (!config.credentialEncryptionKey) {
    throw new Error("OVIRT_INVENTORY_ENCRYPTION_KEY is required");
  }

  const snapshots: SnapshotDetail[] = [];
  for (const manager of listEnabledManagers(db)) {
    snapshots.push(await collectAndSaveManagerSnapshot(db, manager, config.credentialEncryptionKey, config.ovirtAllowInsecureTls, config, inventoryDb));
  }
  return snapshots;
}

async function collectManagersConcurrently(
  managers: ManagerCredentialRecord[],
  concurrency: number,
  collect: (manager: ManagerCredentialRecord) => Promise<SnapshotDetail>
): Promise<SnapshotDetail[]> {
  const snapshots = new Array<SnapshotDetail>(managers.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < managers.length) {
      const index = nextIndex++;
      snapshots[index] = await collect(managers[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, managers.length) }, worker));
  return snapshots;
}

function testCollectionTarget(
  db: SqliteDatabase,
  body: unknown,
  encryptionKey: string | undefined
):
  | { ok: true; value: { managerId?: string; target: OvirtCollectionTarget; allowInsecureTls: boolean } }
  | { ok: false; statusCode: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, statusCode: 400, error: "Request body must be an object" };
  }

  const raw = body as Record<string, unknown>;
  const managerId = stringInput(raw.managerId);
  const existing = managerId ? findManager(db, managerId) : undefined;
  if (managerId && !existing) {
    return { ok: false, statusCode: 404, error: "Manager not found" };
  }

  const name = stringInput(raw.name) ?? existing?.name;
  if (!name) {
    return { ok: false, statusCode: 400, error: "Manager name is required" };
  }

  const url = typeof raw.url === "string" ? normalizeManagerUrl(raw.url) : existing?.url;
  if (!url) {
    return { ok: false, statusCode: 400, error: "Manager URL must be an http(s) URL without query or fragment" };
  }

  const ignoreTls = raw.ignoreTls === undefined ? Boolean(existing?.ignore_tls) : raw.ignoreTls;
  if (typeof ignoreTls !== "boolean") {
    return { ok: false, statusCode: 400, error: "Manager ignoreTls must be true or false" };
  }

  const username = stringInput(raw.username);
  const password = typeof raw.password === "string" && raw.password ? raw.password : undefined;
  let credentials: { username: string; password: string };
  if (username || password) {
    if (!username || !password) {
      return { ok: false, statusCode: 400, error: "Manager username and password are required together" };
    }
    credentials = { username, password };
  } else if (existing) {
    if (!encryptionKey) {
      return { ok: false, statusCode: 503, error: "OVIRT_INVENTORY_ENCRYPTION_KEY is required" };
    }
    try {
      credentials = {
        username: decryptSecret(existing.username_ciphertext, encryptionKey),
        password: decryptSecret(existing.password_ciphertext, encryptionKey)
      };
    } catch {
      return { ok: false, statusCode: 400, error: "Stored oVirt credentials could not be decrypted" };
    }
  } else {
    return { ok: false, statusCode: 400, error: "Manager username and password are required together" };
  }

  return {
    ok: true,
    value: {
      managerId,
      allowInsecureTls: ignoreTls,
      target: {
        managerId: managerId ?? "test-collection",
        managerName: name,
        managerUrl: url,
        username: credentials.username,
        password: credentials.password
      }
    }
  };
}

function collectionTestResult(payload: SnapshotPayload): CollectionTestResult {
  return {
    managerName: payload.managerName,
    managerUrl: payload.managerUrl,
    collectedAt: payload.collectedAt,
    apiVersion: payload.apiVersion,
    durationMs: payload.durationMs,
    status: payload.status,
    resourceCounts: Object.fromEntries(resourceKeys.map((key) => [key, payload.resources[key].length])) as CollectionTestResult["resourceCounts"],
    warningsCount: payload.warnings.length,
    errorsCount: payload.errors.length,
    warnings: payload.warnings,
    errors: payload.errors
  };
}

function snapshotSummary(snapshot: SnapshotDetail): SnapshotSummary {
  return {
    id: snapshot.id,
    managerId: snapshot.managerId,
    managerName: snapshot.managerName,
    managerUrl: snapshot.managerUrl,
    collectedAt: snapshot.collectedAt,
    apiVersion: snapshot.apiVersion,
    durationMs: snapshot.durationMs,
    status: snapshot.status,
    resourceCounts: snapshot.resourceCounts,
    warningsCount: snapshot.warningsCount,
    errorsCount: snapshot.errorsCount,
    createdAt: snapshot.createdAt
  };
}

async function collectAndSaveManagerSnapshot(
  db: SqliteDatabase,
  manager: ManagerCredentialRecord,
  encryptionKey: string,
  allowInsecureTls: boolean,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): Promise<SnapshotDetail> {
  let target: OvirtCollectionTarget;
  try {
    target = {
      managerId: manager.id,
      managerName: manager.name,
      managerUrl: manager.url,
      username: decryptSecret(manager.username_ciphertext, encryptionKey),
      password: decryptSecret(manager.password_ciphertext, encryptionKey)
    };
  } catch {
    const snapshot = saveSnapshotPayload(db, failedSnapshot(manager, "Stored oVirt credentials could not be decrypted"));
    applySnapshotRetention(db, config);
    return snapshot;
  }

  let payload: SnapshotPayload;
  try {
    payload = await collectOvirtSnapshot(target, { allowInsecureTls: allowInsecureTlsForManager(allowInsecureTls, manager) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Collected snapshot could not be saved";
    const snapshot = saveSnapshotPayload(db, failedSnapshot(manager, message));
    applySnapshotRetention(db, config);
    return snapshot;
  }

  const snapshot = saveSnapshotPayload(db, payload);
  applySnapshotRetention(db, config);
  try {
    await persistNormalizedInventory(inventoryDb, snapshot);
  } catch (error) {
    recordAudit(db, {
      actor: "system",
      action: "inventory.normalization_failed",
      resourceType: "manager",
      resourceId: snapshot.managerId,
      metadata: { snapshotId: snapshot.id, message: error instanceof Error ? error.message : "Normalized inventory update failed" }
    });
  }
  return snapshot;
}

export function allowInsecureTlsForManager(globalAllowInsecureTls: boolean, manager: { ignore_tls?: number }): boolean {
  return globalAllowInsecureTls || Boolean(manager.ignore_tls);
}

async function persistNormalizedInventory(inventoryDb: ConnectablePostgres | undefined, snapshot: SnapshotDetail): Promise<void> {
  if (!inventoryDb || snapshot.status === "failed") {
    return;
  }

  await inventoryDb.query(
    `
      INSERT INTO managers (id, name, url, credential_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        credential_status = excluded.credential_status,
        updated_at = CURRENT_TIMESTAMP
    `,
    [snapshot.managerId, snapshot.managerName, snapshot.managerUrl, "saved"]
  );
  await replaceCurrentInventory(inventoryDb, snapshotToInventorySyncInput(snapshot));
}

function failedSnapshot(manager: ManagerCredentialRecord, message: string): SnapshotPayload {
  const now = new Date().toISOString();
  const issue: CollectionIssue = { message };
  return {
    managerId: manager.id,
    managerName: manager.name,
    managerUrl: manager.url,
    collectedAt: now,
    apiVersion: "unknown",
    durationMs: 0,
    status: "failed",
    resources: emptyResources(),
    warnings: [],
    errors: [issue]
  };
}

function findManager(db: SqliteDatabase, id: string): ManagerCredentialRecord | undefined {
  return db
    .prepare("SELECT id, name, url, enabled, ignore_tls, username_ciphertext, password_ciphertext FROM managers WHERE id = ?")
    .get(id) as ManagerCredentialRecord | undefined;
}

function listEnabledManagers(db: SqliteDatabase): ManagerCredentialRecord[] {
  return db
    .prepare(
      "SELECT id, name, url, enabled, ignore_tls, username_ciphertext, password_ciphertext FROM managers WHERE enabled = 1 ORDER BY name COLLATE NOCASE"
    )
    .all() as ManagerCredentialRecord[];
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

function stringInput(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function emptyResources(): InventoryResources {
  return emptyInventoryResources();
}
