import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { queryCapacityDataset } from "../server/capacity.js";
import { encryptSecret } from "../server/credentials.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { replaceCurrentInventory } from "../server/postgres/inventory.js";
import { insertMetricSamples } from "../server/postgres/metrics.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { hashPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const databases: SqliteDatabase[] = [];
const postgresPools: Array<PostgresQueryable & { end(): Promise<void> }> = [];
const encryptionKey = "test-encryption-key-that-is-long-enough";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function capacityFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const parsed = new URL(String(input));
    if (parsed.pathname.endsWith("/sso/oauth/token")) {
      return jsonResponse({ access_token: "metrics-token" });
    }
    if (parsed.pathname.endsWith("/hosts")) {
      return jsonResponse({ host: [{ id: "host-1", statistics: { statistic: [{ name: "cpu.current.total", unit: "percent", values: { value: [{ datum: 61 }] } }] } }] });
    }
    if (parsed.pathname.endsWith("/vms")) {
      return jsonResponse({ vm: [{ id: "vm-1", statistics: { statistic: [{ name: "memory.usage.percent", unit: "percent", values: { value: [{ datum: 54 }] } }] } }] });
    }
    if (parsed.pathname.endsWith("/storagedomains")) {
      return jsonResponse({ storage_domain: [{ id: "storage-1", total: 100, used: 75 }] });
    }
    return jsonResponse({}, 404);
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
  }
});

describe("capacity backend", () => {
  it("collects oVirt capacity samples into the separate PostgreSQL metrics store", async () => {
    const db = memoryDatabase();
    const pool = await memoryPostgres();
    db.prepare(
      `INSERT INTO managers (id, name, url, username_ciphertext, password_ciphertext)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      "manager-1",
      "Lab",
      "https://lab.example/ovirt-engine",
      encryptSecret("metrics-user", encryptionKey),
      encryptSecret("metrics-password", encryptionKey)
    );
    const fetchMock = capacityFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
    const app = buildApp({
      db,
      inventoryDb: pool,
      config: testConfig({
        credentialEncryptionKey: encryptionKey,
        metrics: { backend: "postgres" },
        auth: {
          adminUsername: "admin",
          adminPasswordHash: passwordHash,
          sessionSecret: "test-session-secret-with-enough-length",
          sessionTtlHours: 12,
          secureCookies: false
        }
      })
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "inventory admin" } });
    const cookie = { [login.cookies[0].name]: login.cookies[0].value };
    const response = await app.inject({ method: "POST", url: "/api/metrics/collect", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("metrics-password");
    expect(response.json().collection.results).toMatchObject([{ managerId: "manager-1", sampleCount: 3, errors: [] }]);
    const samples = await pool.query<{ metric_name: string; value: number }>("SELECT metric_name, value FROM metric_samples ORDER BY metric_name");
    expect(samples.rows).toEqual([
      { metric_name: "cpu.usage.percent", value: 61 },
      { metric_name: "memory.usage.percent", value: 54 },
      { metric_name: "storage.used.percent", value: 75 }
    ]);
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "GET")).toBe(true);
    await app.close();
  });

  it("serves scoped Capacity data without leaking manager credentials", async () => {
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const db = memoryDatabase();
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
      startedAt: "2026-08-14T11:00:00.000Z",
      completedAt: "2026-08-14T11:00:01.000Z",
      resources: {
        clusters: [{ clusterId: "cluster-1", name: "Production" }],
        hosts: [
          {
            hostId: "host-1",
            clusterId: "cluster-1",
            name: "hypervisor-1",
            raw: { cpu: { topology: { sockets: 2, cores: 8, threads: 2 } }, memory: 68719476736 }
          }
        ],
        vms: [{ vmId: "vm-1", name: "api-01", clusterId: "cluster-1", hostId: "host-1", vcpus: 4, memoryMb: 8192 }],
        storageDomains: [{ storageDomainId: "storage-1", name: "fast-data", totalBytes: 1099511627776, usedBytes: 549755813888 }]
      }
    });
    await insertMetricSamples(pool, [
      { managerId: "manager-1", resourceType: "host", resourceId: "host-1", metricName: "cpu.usage.percent", sampledAt: "2026-08-14T11:55:00.000Z", value: 61 },
      { managerId: "manager-1", resourceType: "vm", resourceId: "vm-1", metricName: "memory.usage.percent", sampledAt: "2026-08-14T11:55:00.000Z", value: 54 },
      { managerId: "manager-1", resourceType: "storage_domain", resourceId: "storage-1", metricName: "storage.used.percent", sampledAt: "2026-08-14T11:55:00.000Z", value: 50 }
    ]);

    const dataset = await queryCapacityDataset(pool, testConfig(), { range: "24h", scope: { hostId: "host-1" } });
    expect(dataset.metricsAvailable).toBe(true);
    expect(dataset.resources.map((resource) => resource.id)).toEqual(["host-1", "vm-1"]);
    expect(dataset.resources[0]).toMatchObject({ cpuCapacity: 32, allocatedVcpu: 4, memoryCapacityGib: 64, allocatedMemoryGib: 8 });
    expect(dataset.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "host", resourceId: "host-1", cpuPercent: 61 }),
        expect.objectContaining({ resourceType: "vm", resourceId: "vm-1", memoryPercent: 54 })
      ])
    );

    const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
    const app = buildApp({
      db,
      inventoryDb: pool,
      config: testConfig({
        auth: {
          adminUsername: "admin",
          adminPasswordHash: passwordHash,
          sessionSecret: "test-session-secret-with-enough-length",
          sessionTtlHours: 12,
          secureCookies: false
        }
      })
    });
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: "inventory admin" } });
    const cookie = { [login.cookies[0].name]: login.cookies[0].value };
    const response = await app.inject({ method: "GET", url: "/api/capacity?range=24h&hostId=host-1", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("metrics-password");
    expect(response.json().capacity).toMatchObject({ metricsAvailable: true, expectedIntervalMinutes: 5 });
    expect(response.json().capacity.resources.map((resource: { id: string }) => resource.id)).toEqual(["host-1", "vm-1"]);
    const invalid = await app.inject({ method: "GET", url: "/api/capacity?range=month", cookies: cookie });
    expect(invalid.statusCode).toBe(400);
    const unauthenticated = await app.inject({ method: "GET", url: "/api/capacity" });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
  });
});
