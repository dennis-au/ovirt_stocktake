import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableScheduler } from "../server/durable-scheduler.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import type { ConnectablePostgres } from "../server/postgres/inventory.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { createSchedulerRun, getSchedulerRun, markSchedulerRunManagerStarted } from "../server/scheduler-runs.js";
import { getSchedulerReconcilerState, listScheduleStates } from "../server/scheduler-state.js";
import { saveAppSettings } from "../server/settings.js";
import { testConfig } from "./health.test.js";

const { collectManagerSnapshotById, collectManagerMetricsById } = vi.hoisted(() => ({
  collectManagerSnapshotById: vi.fn(),
  collectManagerMetricsById: vi.fn()
}));

vi.mock("../server/collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/collection.js")>()),
  collectManagerSnapshotById
}));

vi.mock("../server/metrics-collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/metrics-collection.js")>()),
  collectManagerMetricsById
}));

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

function schedulerConfig() {
  return testConfig({
    credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
    postgres: { databaseUrl: "postgres://scheduler@example.local/ovirt", ssl: false },
    metrics: { backend: "postgres" },
    collector: { ...testConfig().collector, enabled: true }
  });
}

function addManager(db: SqliteDatabase, id: string, name: string, enabled = true): void {
  db.prepare(
    `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, `https://${id}.example/ovirt-engine`, enabled ? 1 : 0, "user", "password");
}

function snapshot(id: string, status: "success" | "partial" | "failed" = "success", error = "") {
  return {
    id,
    status,
    warningsCount: 0,
    errorsCount: error ? 1 : 0,
    errors: error ? [{ message: error }] : []
  };
}

async function makeInventoryDue(inventoryDb: ConnectablePostgres): Promise<void> {
  await inventoryDb.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
}

afterEach(async () => {
  vi.clearAllMocks();
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
  }
});

describe("PostgreSQL reconciler scheduler", () => {
  it("claims an overdue inventory schedule at startup and collects enabled managers sequentially", async () => {
    const db = memoryDatabase();
    addManager(db, "manager-2", "Bravo");
    addManager(db, "manager-1", "Alpha");
    addManager(db, "manager-3", "Disabled", false);
    saveAppSettings(db, {
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: true,
      metricsCollectionEnabled: false,
      metricsIntervalMinutes: 5
    });

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const scheduler = createDurableScheduler({ db, inventoryDb, config: schedulerConfig() });
    await scheduler.syncSettings();
    await makeInventoryDue(inventoryDb);
    const calls: string[] = [];
    collectManagerSnapshotById.mockImplementation(async (_db, _config, managerId) => {
      calls.push(managerId);
      return snapshot(`snapshot-${managerId}`);
    });

    await scheduler.start();

    expect(calls).toEqual(["manager-1", "manager-2"]);
    const runs = await inventoryDb.query<{ status: string; expected_manager_count: number }>(
      "SELECT status, expected_manager_count FROM scheduler_dispatch_runs WHERE job_type = $1",
      ["inventory"]
    );
    expect(runs.rows).toEqual([{ status: "success", expected_manager_count: 2 }]);
    expect((await listScheduleStates(inventoryDb)).find((state) => state.jobType === "inventory")).toMatchObject({ lastResult: "success" });
    await scheduler.stop();
  });

  it("records a failed manager once for its cycle and only tries it again after a later due interval", async () => {
    const db = memoryDatabase();
    addManager(db, "manager-1", "Alpha");
    addManager(db, "manager-2", "Bravo");
    saveAppSettings(db, {
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: true,
      metricsCollectionEnabled: false,
      metricsIntervalMinutes: 5
    });

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const scheduler = createDurableScheduler({ db, inventoryDb, config: schedulerConfig() });
    await scheduler.syncSettings();
    await makeInventoryDue(inventoryDb);
    collectManagerSnapshotById
      .mockResolvedValueOnce(snapshot("snapshot-1", "failed", "Network or TLS failure"))
      .mockResolvedValueOnce(snapshot("snapshot-2"))
      .mockResolvedValueOnce(snapshot("snapshot-3"))
      .mockResolvedValueOnce(snapshot("snapshot-4"));

    await scheduler.start();

    expect(collectManagerSnapshotById).toHaveBeenCalledTimes(2);
    const firstRun = await inventoryDb.query<{ id: string }>("SELECT id FROM scheduler_dispatch_runs ORDER BY created_at LIMIT 1");
    expect(await getSchedulerRun(inventoryDb, firstRun.rows[0]!.id)).toMatchObject({ status: "partial", completedManagerCount: 2, failedManagerCount: 1 });

    await makeInventoryDue(inventoryDb);
    await scheduler.dispatchDue("inventory");

    expect(collectManagerSnapshotById).toHaveBeenCalledTimes(4);
    await scheduler.stop();
  });

  it("skips disabled managers without leaving an active dispatch run", async () => {
    const db = memoryDatabase();
    addManager(db, "manager-1", "Disabled", false);
    saveAppSettings(db, {
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: true,
      metricsCollectionEnabled: false,
      metricsIntervalMinutes: 5
    });

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const scheduler = createDurableScheduler({ db, inventoryDb, config: schedulerConfig() });
    await scheduler.syncSettings();
    await makeInventoryDue(inventoryDb);

    await scheduler.start();

    expect(collectManagerSnapshotById).not.toHaveBeenCalled();
    const run = await inventoryDb.query<{ status: string; expected_manager_count: number; completed_at: string }>("SELECT status, expected_manager_count, completed_at FROM scheduler_dispatch_runs");
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({ status: "success", expected_manager_count: 0 });
    expect(run.rows[0]?.completed_at).toBeTruthy();
    await scheduler.stop();
  });

  it("recovers a stale dispatch run without queue cancellation", async () => {
    const db = memoryDatabase();
    saveAppSettings(db, {
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: false,
      metricsCollectionEnabled: false,
      metricsIntervalMinutes: 5
    });
    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const staleRun = await createSchedulerRun(inventoryDb, "inventory", ["manager-1"]);
    await markSchedulerRunManagerStarted(inventoryDb, staleRun.id, "manager-1");
    await inventoryDb.query(
      "UPDATE scheduler_dispatch_runs SET heartbeat_at = CURRENT_TIMESTAMP - INTERVAL '21 minutes' WHERE id = $1",
      [staleRun.id]
    );

    const scheduler = createDurableScheduler({ db, inventoryDb, config: schedulerConfig() });
    await scheduler.start();

    expect(await getSchedulerRun(inventoryDb, staleRun.id)).toMatchObject({ status: "partial", completedManagerCount: 1 });
    await scheduler.stop();
  });

  it("persists a successful reconciliation heartbeat for the Settings status", async () => {
    const db = memoryDatabase();
    saveAppSettings(db, {
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: false,
      metricsCollectionEnabled: false,
      metricsIntervalMinutes: 5
    });
    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const scheduler = createDurableScheduler({ db, inventoryDb, config: schedulerConfig() });

    await scheduler.start();

    expect(scheduler.status).toMatchObject({
      backend: "postgres-reconciler",
      available: true,
      running: true,
      lastPolledAt: expect.any(String),
      lastSuccessfulPollAt: expect.any(String)
    });
    expect(await getSchedulerReconcilerState(inventoryDb)).toMatchObject({
      lastPolledAt: expect.any(String),
      lastSuccessfulPollAt: expect.any(String)
    });
    await scheduler.stop();
  });
});
