import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppRole } from "./rbac.js";
import { hashPasswordSync } from "./security.js";

loadRuntimeEnvFiles();

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  nodeEnv: string;
  auth: AuthConfig;
  postgres: PostgresConfig;
  metrics: MetricsConfig;
  collector: CollectorConfig;
  credentialEncryptionKey?: string;
  ovirtAllowInsecureTls: boolean;
}

export interface AuthConfig {
  adminUsername: string;
  adminRole: AppRole;
  adminPasswordHash?: string;
  sessionSecret?: string;
  sessionTtlHours: number;
  secureCookies: boolean;
}

export interface PostgresConfig {
  databaseUrl?: string;
  ssl: boolean;
}

export interface MetricsConfig {
  backend: "none" | "postgres" | "timescale" | "timescaledb" | "prometheus" | "victoriametrics" | "grafana";
  url?: string;
}

export interface CollectorConfig {
  enabled: boolean;
  inventorySyncMinutes: number;
  extendedSyncMinutes: number;
  eventSyncMinutes: number;
  metricsSyncMinutes: number;
  backupSyncMinutes: number;
  fullSnapshotHour: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = resolve(environment.OVIRT_INVENTORY_DB_PATH ?? ".data/ovirt-inventory.sqlite");
  const port = Number.parseInt(environment.OVIRT_INVENTORY_PORT ?? "3000", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OVIRT_INVENTORY_PORT must be a valid TCP port");
  }

  const sessionTtlHours = Number.parseInt(environment.OVIRT_INVENTORY_SESSION_TTL_HOURS ?? "12", 10);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error("OVIRT_INVENTORY_SESSION_TTL_HOURS must be greater than zero");
  }

  const ovirtAllowInsecureTls = parseBoolean(environment.OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS ?? "false");
  if (ovirtAllowInsecureTls === undefined) {
    throw new Error("OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS must be true or false");
  }

  const databaseSsl = parseBoolean(environment.OVIRT_INVENTORY_DATABASE_SSL ?? "false");
  if (databaseSsl === undefined) {
    throw new Error("OVIRT_INVENTORY_DATABASE_SSL must be true or false");
  }

  const secureCookiesValue = environment.OVIRT_INVENTORY_SECURE_COOKIES;
  const secureCookies = secureCookiesValue === undefined ? undefined : parseBoolean(secureCookiesValue);
  if (secureCookiesValue !== undefined && secureCookies === undefined) {
    throw new Error("OVIRT_INVENTORY_SECURE_COOKIES must be true or false");
  }

  const collectorEnabled = parseBoolean(environment.OVIRT_INVENTORY_COLLECTOR_ENABLED ?? "true");
  if (collectorEnabled === undefined) {
    throw new Error("OVIRT_INVENTORY_COLLECTOR_ENABLED must be true or false");
  }

  const adminRole = parseRole(environment.OVIRT_INVENTORY_ADMIN_ROLE ?? "admin");
  if (!adminRole) {
    throw new Error("OVIRT_INVENTORY_ADMIN_ROLE must be admin, operator, or viewer");
  }
  const metricsBackend = parseMetricsBackend(environment.OVIRT_INVENTORY_METRICS_BACKEND ?? "none");
  if (!metricsBackend) {
    throw new Error("OVIRT_INVENTORY_METRICS_BACKEND must be none, postgres, timescale, timescaledb, prometheus, victoriametrics, or grafana");
  }

  const inventorySyncMinutes = parsePositiveInteger(environment.OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES ?? "15", "OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES");
  const extendedSyncMinutes = parsePositiveInteger(environment.OVIRT_INVENTORY_EXTENDED_SYNC_MINUTES ?? "60", "OVIRT_INVENTORY_EXTENDED_SYNC_MINUTES");
  const eventSyncMinutes = parsePositiveInteger(environment.OVIRT_INVENTORY_EVENT_SYNC_MINUTES ?? "5", "OVIRT_INVENTORY_EVENT_SYNC_MINUTES");
  const metricsSyncMinutes = parsePositiveInteger(environment.OVIRT_INVENTORY_METRICS_SYNC_MINUTES ?? "5", "OVIRT_INVENTORY_METRICS_SYNC_MINUTES");
  const backupSyncMinutes = parsePositiveInteger(environment.OVIRT_INVENTORY_BACKUP_SYNC_MINUTES ?? "60", "OVIRT_INVENTORY_BACKUP_SYNC_MINUTES");
  const fullSnapshotHour = parseHour(environment.OVIRT_INVENTORY_FULL_SNAPSHOT_HOUR ?? "2");

  mkdirSync(dirname(databasePath), { recursive: true });

  return {
    host: environment.OVIRT_INVENTORY_HOST ?? "0.0.0.0",
    port,
    databasePath,
    nodeEnv: environment.NODE_ENV ?? "development",
    credentialEncryptionKey: environment.OVIRT_INVENTORY_ENCRYPTION_KEY,
    ovirtAllowInsecureTls,
    postgres: {
      databaseUrl: environment.OVIRT_INVENTORY_DATABASE_URL || undefined,
      ssl: databaseSsl
    },
    metrics: {
      backend: metricsBackend,
      url: environment.OVIRT_INVENTORY_METRICS_URL || undefined
    },
    collector: {
      enabled: collectorEnabled,
      inventorySyncMinutes,
      extendedSyncMinutes,
      eventSyncMinutes,
      metricsSyncMinutes,
      backupSyncMinutes,
      fullSnapshotHour
    },
    auth: {
      adminUsername: environment.OVIRT_INVENTORY_ADMIN_USERNAME ?? "admin",
      adminRole,
      adminPasswordHash: adminPasswordHashFromEnvironment(environment),
      sessionSecret: environment.OVIRT_INVENTORY_SESSION_SECRET,
      sessionTtlHours,
      secureCookies: secureCookies ?? (environment.NODE_ENV ?? "development") === "production"
    }
  };
}

function loadRuntimeEnvFiles(): void {
  const candidates = [process.env.OVIRT_INVENTORY_ENV_FILE];
  if (process.env.NODE_ENV !== "test") {
    candidates.push("/data/.env", ".env");
  }
  const loaded = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate?.trim()) {
      continue;
    }
    const path = resolve(candidate);
    if (loaded.has(path) || !existsSync(path)) {
      continue;
    }
    loadDotenv({ path, override: false, quiet: true });
    loaded.add(path);
  }
}

function adminPasswordHashFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.OVIRT_INVENTORY_ADMIN_PASSWORD_HASH) {
    return environment.OVIRT_INVENTORY_ADMIN_PASSWORD_HASH;
  }
  if (environment.OVIRT_INVENTORY_ADMIN_PASSWORD) {
    return hashPasswordSync(environment.OVIRT_INVENTORY_ADMIN_PASSWORD);
  }
  return undefined;
}

function parseMetricsBackend(value: string): MetricsConfig["backend"] | undefined {
  const normalized = value.trim().toLowerCase();
  if (["none", "postgres", "timescale", "timescaledb", "prometheus", "victoriametrics", "grafana"].includes(normalized)) {
    return normalized as MetricsConfig["backend"];
  }
  return undefined;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return parsed;
}

function parseHour(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    throw new Error("OVIRT_INVENTORY_FULL_SNAPSHOT_HOUR must be an hour from 0 to 23");
  }
  return parsed;
}

function parseRole(value: string): AppRole | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "admin" || normalized === "operator" || normalized === "viewer") {
    return normalized;
  }
  return undefined;
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", ""].includes(normalized)) {
    return false;
  }
  return undefined;
}
