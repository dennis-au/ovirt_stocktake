import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";
import { sqliteUtcTimestampToIso } from "../shared/time.js";

const snapshotIntervalKey = "setting.snapshot_interval_minutes";
const snapshotRetentionKey = "setting.snapshot_retention_days";
const inventoryCollectionEnabledKey = "setting.inventory_collection_enabled";
const metricsCollectionEnabledKey = "setting.metrics_collection_enabled";
const metricsIntervalKey = "setting.metrics_interval_minutes";
const maxSnapshotIntervalMinutes = 24 * 60;
const maxSnapshotRetentionDays = 3650;

export interface AppSettings {
  snapshotIntervalMinutes: number;
  snapshotRetentionDays: number;
  inventoryCollectionEnabled: boolean;
  metricsCollectionEnabled: boolean;
  metricsIntervalMinutes: number;
  collectorEnabled: boolean;
  updatedAt?: string;
}

type AppSettingsInput = Pick<AppSettings, "snapshotIntervalMinutes" | "snapshotRetentionDays"> &
  Partial<Pick<AppSettings, "inventoryCollectionEnabled" | "metricsCollectionEnabled" | "metricsIntervalMinutes">>;

interface SettingRow {
  value: string;
  updated_at: string;
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  config: AppConfig,
  onSettingsChanged?: (settings: AppSettings) => void | Promise<void>
): void {
  app.get("/api/settings", { preHandler: requireRole(roles.read) }, async () => ({
    settings: getAppSettings(db, config)
  }));

  app.patch("/api/settings", { preHandler: requireRole(roles.admin) }, async (request, reply) => {
    const parsed = parseSettingsInput(request.body, getAppSettings(db, config));
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }

    saveAppSettings(db, parsed.value);
    const prunedSnapshots = pruneSnapshotsByRetention(db, parsed.value.snapshotRetentionDays);
    const settings = getAppSettings(db, config);
    await onSettingsChanged?.(settings);
    recordAudit(db, {
      actor: currentSession(db, request)?.username,
      action: "settings.updated",
      metadata: {
        snapshotIntervalMinutes: settings.snapshotIntervalMinutes,
        snapshotRetentionDays: settings.snapshotRetentionDays,
        inventoryCollectionEnabled: settings.inventoryCollectionEnabled,
        metricsCollectionEnabled: settings.metricsCollectionEnabled,
        metricsIntervalMinutes: settings.metricsIntervalMinutes,
        prunedSnapshots
      }
    });
    return { settings };
  });
}

export function getAppSettings(db: SqliteDatabase, config: AppConfig): AppSettings {
  const interval = settingInteger(db, snapshotIntervalKey, config.collector.inventorySyncMinutes, 1, maxSnapshotIntervalMinutes);
  const retention = settingInteger(db, snapshotRetentionKey, 0, 0, maxSnapshotRetentionDays);
  const inventoryCollectionEnabled = settingBoolean(db, inventoryCollectionEnabledKey, config.collector.enabled);
  const metricsCollectionEnabled = settingBoolean(db, metricsCollectionEnabledKey, config.collector.enabled);
  const metricsIntervalMinutes = settingInteger(db, metricsIntervalKey, config.collector.metricsSyncMinutes, 1, maxSnapshotIntervalMinutes);
  const updatedAt = latestUpdatedAt(db, [
    snapshotIntervalKey,
    snapshotRetentionKey,
    inventoryCollectionEnabledKey,
    metricsCollectionEnabledKey,
    metricsIntervalKey
  ]);

  return {
    snapshotIntervalMinutes: interval,
    snapshotRetentionDays: retention,
    inventoryCollectionEnabled,
    metricsCollectionEnabled,
    metricsIntervalMinutes,
    collectorEnabled: config.collector.enabled,
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function saveAppSettings(db: SqliteDatabase, settings: AppSettingsInput): void {
  saveSetting(db, snapshotIntervalKey, settings.snapshotIntervalMinutes);
  saveSetting(db, snapshotRetentionKey, settings.snapshotRetentionDays);
  if (settings.inventoryCollectionEnabled !== undefined) {
    saveSetting(db, inventoryCollectionEnabledKey, settings.inventoryCollectionEnabled ? 1 : 0);
  }
  if (settings.metricsCollectionEnabled !== undefined) {
    saveSetting(db, metricsCollectionEnabledKey, settings.metricsCollectionEnabled ? 1 : 0);
  }
  if (settings.metricsIntervalMinutes !== undefined) {
    saveSetting(db, metricsIntervalKey, settings.metricsIntervalMinutes);
  }
}

export function snapshotIntervalMinutes(db: SqliteDatabase, config: AppConfig): number {
  return getAppSettings(db, config).snapshotIntervalMinutes;
}

export function snapshotRetentionDays(db: SqliteDatabase, config: AppConfig): number {
  return getAppSettings(db, config).snapshotRetentionDays;
}

export function pruneSnapshotsByRetention(db: SqliteDatabase, retentionDays: number, now = new Date()): number {
  if (retentionDays <= 0) {
    return 0;
  }

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare("DELETE FROM snapshots WHERE collected_at < ?").run(cutoff);
  return result.changes;
}

export function applySnapshotRetention(db: SqliteDatabase, config: AppConfig): number {
  return pruneSnapshotsByRetention(db, snapshotRetentionDays(db, config));
}

function parseSettingsInput(
  body: unknown,
  current: AppSettings
): { ok: true; value: AppSettingsInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Settings body must be an object" };
  }

  const raw = body as Record<string, unknown>;
  const snapshotIntervalMinutes = positiveInteger(raw.snapshotIntervalMinutes);
  if (snapshotIntervalMinutes === undefined || snapshotIntervalMinutes > maxSnapshotIntervalMinutes) {
    return { ok: false, error: "Snapshot interval must be from 1 to 1440 minutes" };
  }

  const snapshotRetentionDays = nonNegativeInteger(raw.snapshotRetentionDays);
  if (snapshotRetentionDays === undefined || snapshotRetentionDays > maxSnapshotRetentionDays) {
    return { ok: false, error: "Snapshot retention must be from 0 to 3650 days" };
  }

  const inventoryCollectionEnabled = booleanInput(raw.inventoryCollectionEnabled);
  if (raw.inventoryCollectionEnabled !== undefined && inventoryCollectionEnabled === undefined) {
    return { ok: false, error: "Inventory collection must be enabled or disabled" };
  }

  const metricsCollectionEnabled = booleanInput(raw.metricsCollectionEnabled);
  if (raw.metricsCollectionEnabled !== undefined && metricsCollectionEnabled === undefined) {
    return { ok: false, error: "Metrics collection must be enabled or disabled" };
  }

  const metricsIntervalMinutes = raw.metricsIntervalMinutes === undefined ? current.metricsIntervalMinutes : positiveInteger(raw.metricsIntervalMinutes);
  if (metricsIntervalMinutes === undefined || metricsIntervalMinutes > maxSnapshotIntervalMinutes) {
    return { ok: false, error: "Metrics interval must be from 1 to 1440 minutes" };
  }

  return {
    ok: true,
    value: {
      snapshotIntervalMinutes,
      snapshotRetentionDays,
      inventoryCollectionEnabled: inventoryCollectionEnabled ?? current.inventoryCollectionEnabled,
      metricsCollectionEnabled: metricsCollectionEnabled ?? current.metricsCollectionEnabled,
      metricsIntervalMinutes
    }
  };
}

function settingInteger(db: SqliteDatabase, key: string, fallback: number, min: number, max: number): number {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as Pick<SettingRow, "value"> | undefined;
  const value = row ? Number.parseInt(row.value, 10) : fallback;
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function settingBoolean(db: SqliteDatabase, key: string, fallback: boolean): boolean {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as Pick<SettingRow, "value"> | undefined;
  if (!row) {
    return fallback;
  }
  return row.value === "1" || row.value.toLowerCase() === "true";
}

function saveSetting(db: SqliteDatabase, key: string, value: number): void {
  db.prepare(
    `INSERT INTO app_metadata (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = CURRENT_TIMESTAMP`
  ).run(key, String(value));
}

function latestUpdatedAt(db: SqliteDatabase, keys: string[]): string | undefined {
  const placeholders = keys.map(() => "?").join(", ");
  const row = db
    .prepare(`SELECT updated_at FROM app_metadata WHERE key IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`)
    .get(...keys) as Pick<SettingRow, "updated_at"> | undefined;
  return sqliteUtcTimestampToIso(row?.updated_at);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanInput(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
