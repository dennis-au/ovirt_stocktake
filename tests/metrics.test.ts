import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { insertMetricSamples, percentile, queryVmMetricSummary } from "../server/postgres/metrics.js";
import { replaceCurrentInventory } from "../server/postgres/inventory.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { hashPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const databases: SqliteDatabase[] = [];
const postgresPools: Array<PostgresQueryable & { end(): Promise<void> }> = [];

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(pool);
  postgresPools.push(pool);
  return pool;
}

afterEach(async () => {
  vi.useRealTimers();
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
  }
});

describe("metrics pipeline", () => {
  it("calculates P95 values deterministically", () => {
    expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 95)).toBe(95);
    expect(percentile([], 95)).toBeUndefined();
  });

  it("stores time-series samples separately and summarizes VM performance", async () => {
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const pool = await memoryPostgres();
    await pool.query("INSERT INTO managers (id, name, url, credential_status) VALUES ($1, $2, $3, $4)", [
      "manager-1",
      "Lab",
      "https://lab.example/ovirt-engine",
      "saved"
    ]);
    await insertMetricSamples(
      pool,
      Array.from({ length: 20 }, (_, index) => ({
        managerId: "manager-1",
        resourceType: "vm" as const,
        resourceId: "vm-1",
        metricName: index % 2 === 0 ? "cpu.usage.percent" : "memory.usage.percent",
        sampledAt: new Date(Date.now() - index * 60_000).toISOString(),
        value: index % 2 === 0 ? index + 1 : 30 + index
      }))
    );

    const summary = await queryVmMetricSummary(pool, "manager-1", "vm-1", 24);

    expect(summary.metricsAvailable).toBe(true);
    expect(summary.cpuP95).toBe(19);
    expect(summary.memoryP95).toBe(49);
    expect(summary.rightsizing).toBe("steady");
  });

  it("returns unavailable metrics without breaking inventory APIs", async () => {
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
    const pool = await memoryPostgres();
    await pool.query("INSERT INTO managers (id, name, url, credential_status) VALUES ($1, $2, $3, $4)", [
      "manager-1",
      "Lab",
      "https://lab.example/ovirt-engine",
      "saved"
    ]);
    await replaceCurrentInventory(pool, {
      managerId: "manager-1",
      status: "success",
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:00:01.000Z",
      resources: { vms: [{ vmId: "vm-1", name: "api-01" }] }
    });
    const app = buildApp({
      db: memoryDatabase(),
      inventoryDb: pool,
      config: testConfig({
        auth: {
          adminUsername: "admin",
          adminRole: "admin",
          adminPasswordHash: passwordHash,
          sessionSecret: "test-session-secret-with-enough-length",
          sessionTtlHours: 12,
          secureCookies: false
        }
      })
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "inventory admin" } });
    const cookie = { [login.cookies[0].name]: login.cookies[0].value };

    const metrics = await app.inject({ method: "GET", url: "/api/metrics/vms/manager-1/vm-1", cookies: cookie });
    const inventory = await app.inject({ method: "GET", url: "/api/inventory/vms", cookies: cookie });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().metrics).toMatchObject({ metricsAvailable: false, rightsizing: "unavailable" });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().inventory.rows[0]).toMatchObject({ name: "api-01" });
    await app.close();
  });
});
