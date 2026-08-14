import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { loadConfig, type AppConfig } from "../server/config.js";
import { databaseHealth, openDatabase, type SqliteDatabase } from "../server/db.js";
import { verifyPassword } from "../server/security.js";

const databases: SqliteDatabase[] = [];
type TestConfigOverrides = Partial<Omit<AppConfig, "auth">> & {
  auth?: Partial<AppConfig["auth"]>;
};

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

export function testConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const { auth, ...rest } = overrides;
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    nodeEnv: "test",
    ovirtAllowInsecureTls: false,
    postgres: {
      ssl: false
    },
    metrics: {
      backend: "none"
    },
    scheduler: {
      workerConcurrency: 2
    },
    collector: {
      enabled: false,
      inventorySyncMinutes: 15,
      extendedSyncMinutes: 60,
      eventSyncMinutes: 5,
      metricsSyncMinutes: 5,
      backupSyncMinutes: 60,
      fullSnapshotHour: 2
    },
    auth: {
      adminUsername: "admin",
      adminRole: "admin",
      sessionTtlHours: 12,
      secureCookies: false,
      ...auth
    },
    ...rest
  };
}

afterEach(() => {
  while (databases.length) {
    databases.pop()?.close();
  }
});

describe("configuration", () => {
  it("keeps insecure oVirt TLS disabled by default and requires an explicit opt-in", () => {
    expect(loadConfig({ OVIRT_INVENTORY_DB_PATH: ":memory:" }).ovirtAllowInsecureTls).toBe(false);
    expect(
      loadConfig({
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS: "true"
      }).ovirtAllowInsecureTls
    ).toBe(true);
    expect(() =>
      loadConfig({
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS: "sometimes"
      })
    ).toThrow("OVIRT_INVENTORY_OVIRT_ALLOW_INSECURE_TLS must be true or false");
  });

  it("parses PostgreSQL and scheduled collector settings", () => {
    expect(loadConfig({ OVIRT_INVENTORY_DB_PATH: ":memory:" }).collector.enabled).toBe(true);
    expect(
      loadConfig({
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_COLLECTOR_ENABLED: "false"
      }).collector.enabled
    ).toBe(false);

    const config = loadConfig({
      OVIRT_INVENTORY_DB_PATH: ":memory:",
      OVIRT_INVENTORY_DATABASE_URL: "postgres://inventory@example.local/ovirt",
      OVIRT_INVENTORY_DATABASE_SSL: "true",
      OVIRT_INVENTORY_COLLECTOR_ENABLED: "true",
      OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES: "5",
      OVIRT_INVENTORY_EXTENDED_SYNC_MINUTES: "30",
      OVIRT_INVENTORY_EVENT_SYNC_MINUTES: "1",
      OVIRT_INVENTORY_METRICS_SYNC_MINUTES: "2",
      OVIRT_INVENTORY_SCHEDULER_WORKER_CONCURRENCY: "3",
      OVIRT_INVENTORY_BACKUP_SYNC_MINUTES: "45",
      OVIRT_INVENTORY_FULL_SNAPSHOT_HOUR: "3"
    });

    expect(config.postgres).toEqual({ databaseUrl: "postgres://inventory@example.local/ovirt", ssl: true });
    expect(config.metrics).toEqual({ backend: "none", url: undefined });
    expect(config.collector).toMatchObject({
      enabled: true,
      inventorySyncMinutes: 5,
      extendedSyncMinutes: 30,
      eventSyncMinutes: 1,
      metricsSyncMinutes: 2,
      backupSyncMinutes: 45,
      fullSnapshotHour: 3
    });
    expect(config.scheduler).toEqual({ workerConcurrency: 3 });
    expect(() =>
      loadConfig({
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_COLLECTOR_ENABLED: "true",
        OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES: "0"
      })
    ).toThrow("OVIRT_INVENTORY_INVENTORY_SYNC_MINUTES must be greater than zero");
  });

  it("derives the admin password hash from a plaintext environment fallback", async () => {
    const config = loadConfig({
      OVIRT_INVENTORY_DB_PATH: ":memory:",
      OVIRT_INVENTORY_ADMIN_PASSWORD: "inventory admin",
      OVIRT_INVENTORY_SESSION_SECRET: "test-session-secret-with-enough-length"
    });

    expect(config.auth.adminPasswordHash).toMatch(/^scrypt\$v1\$/);
    expect(config.auth.adminPasswordHash).not.toContain("inventory admin");
    await expect(verifyPassword("inventory admin", config.auth.adminPasswordHash!)).resolves.toBe(true);
  });

  it("allows secure cookies to be disabled for HTTP deployments", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_SECURE_COOKIES: "false"
      }).auth.secureCookies
    ).toBe(false);
    expect(
      loadConfig({
        NODE_ENV: "production",
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_SECURE_COOKIES: "true"
      }).auth.secureCookies
    ).toBe(true);
    expect(() =>
      loadConfig({
        OVIRT_INVENTORY_DB_PATH: ":memory:",
        OVIRT_INVENTORY_SECURE_COOKIES: "maybe"
      })
    ).toThrow("OVIRT_INVENTORY_SECURE_COOKIES must be true or false");
  });
});

describe("application scaffold", () => {
  it("initializes SQLite schema metadata", () => {
    const db = memoryDatabase();

    expect(databaseHealth(db)).toEqual({ ok: true, schemaVersion: "3" });
  });

  it("serves a health endpoint backed by SQLite", async () => {
    const app = buildApp({ db: memoryDatabase(), config: testConfig() });

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "ovirt-inventory",
      database: { ok: true, schemaVersion: "3" }
    });
    await app.close();
  });
});
