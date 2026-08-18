import { newDb } from "pg-mem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableScheduler,
  type DurableJobQueue,
  type QueueJob,
  type QueueJobResult
} from "../server/durable-scheduler.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import type { ConnectablePostgres } from "../server/postgres/inventory.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { getSchedulerRun } from "../server/scheduler-runs.js";
import { listScheduleStates } from "../server/scheduler-state.js";
import { saveAppSettings } from "../server/settings.js";
import { testConfig } from "./health.test.js";

const { collectManagerSnapshotById } = vi.hoisted(() => ({ collectManagerSnapshotById: vi.fn() }));

vi.mock("../server/collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/collection.js")>()),
  collectManagerSnapshotById
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

class FakeQueue implements DurableJobQueue {
  readonly queues: string[] = [];
  readonly schedules: Array<{ name: string; cron: string }> = [];
  readonly sent: Array<{ name: string; data: object; options?: object }> = [];
  readonly workers = new Map<string, (jobs: QueueJob<object>[]) => Promise<QueueJobResult[]>>();
  readonly workerOptions = new Map<string, object>();

  constructor(private readonly sendResults?: Array<string | null | Error>) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(name: string): Promise<void> {
    this.queues.push(name);
  }
  async schedule(name: string, cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }
  async work(name: string, options: object, handler: (jobs: QueueJob<object>[]) => Promise<QueueJobResult[]>): Promise<void> {
    this.workerOptions.set(name, options);
    this.workers.set(name, handler);
  }
  async send(name: string, data: object, options?: object): Promise<string | null> {
    this.sent.push({ name, data, options });
    if (this.sendResults?.length) {
      const result = this.sendResults.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result ?? null;
    }
    return `${name}-${this.sent.length}`;
  }
}

afterEach(async () => {
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
  }
});

describe("durable scheduler", () => {
  it("queues one singleton inventory job per enabled manager and reanchors user settings", async () => {
    const db = memoryDatabase();
    db.prepare(
      `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("manager-1", "Lab 1", "https://lab-1.example/ovirt-engine", 1, "user", "password");
    db.prepare(
      `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("manager-2", "Lab 2", "https://lab-2.example/ovirt-engine", 1, "user", "password");
    db.prepare(
      `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("manager-3", "Disabled", "https://disabled.example/ovirt-engine", 0, "user", "password");

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const queue = new FakeQueue();
    const scheduler = createDurableScheduler({
      db,
      inventoryDb,
      queue,
      config: testConfig({
        credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
        postgres: { databaseUrl: "postgres://scheduler@example.local/ovirt", ssl: false },
        metrics: { backend: "postgres" },
        collector: { ...testConfig().collector, enabled: true }
      })
    });

    await scheduler.start();
    await inventoryDb.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
    await scheduler.dispatchDue("inventory");

    expect(queue.queues).toEqual(
      expect.arrayContaining(["scheduler.inventory-dispatch", "scheduler.inventory-manager-collect", "scheduler.metrics-dispatch", "scheduler.metrics-manager-collect"])
    );
    expect(queue.schedules).toEqual(
      expect.arrayContaining([
        { name: "scheduler.inventory-dispatch", cron: "* * * * *" },
        { name: "scheduler.metrics-dispatch", cron: "* * * * *" }
      ])
    );
    expect(queue.sent).toHaveLength(2);
    expect(queue.sent.map((job) => job.data)).toEqual([
      expect.objectContaining({ managerId: "manager-1", runId: expect.any(String) }),
      expect.objectContaining({ managerId: "manager-2", runId: expect.any(String) })
    ]);
    expect(queue.sent.every((job) => (job.options as { singletonKey?: string }).singletonKey?.startsWith("inventory:"))).toBe(true);
    expect(queue.workerOptions.get("scheduler.inventory-manager-collect")).toMatchObject({ includeMetadata: true });

    const runId = (queue.sent[0]?.data as { runId: string }).runId;
    expect(await getSchedulerRun(inventoryDb, runId)).toMatchObject({
      status: "queued",
      expectedManagerCount: 2,
      queuedManagerCount: 2,
      completedManagerCount: 0
    });

    await inventoryDb.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
    await scheduler.dispatchDue("inventory");
    expect(queue.sent).toHaveLength(2);

    saveAppSettings(db, {
      snapshotIntervalMinutes: 30,
      snapshotRetentionDays: 0,
      inventoryCollectionEnabled: true,
      metricsCollectionEnabled: true,
      metricsIntervalMinutes: 10
    });
    await scheduler.syncSettings();

    const inventorySchedule = (await listScheduleStates(inventoryDb)).find((state) => state.jobType === "inventory");
    expect(inventorySchedule?.intervalMinutes).toBe(30);
    await scheduler.stop();
  });

  it("records queue errors and singleton conflicts as one partial scheduler result", async () => {
    const db = memoryDatabase();
    for (const managerId of ["manager-1", "manager-2"]) {
      db.prepare(
        `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(managerId, managerId, `https://${managerId}.example/ovirt-engine`, 1, "user", "password");
    }

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const queue = new FakeQueue([new Error("queue unavailable"), null]);
    const scheduler = createDurableScheduler({
      db,
      inventoryDb,
      queue,
      config: testConfig({
        credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
        postgres: { databaseUrl: "postgres://scheduler@example.local/ovirt", ssl: false },
        metrics: { backend: "postgres" },
        collector: { ...testConfig().collector, enabled: true }
      })
    });

    await scheduler.start();
    await inventoryDb.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
    await scheduler.dispatchDue("inventory");

    const runId = (queue.sent[0]?.data as { runId: string }).runId;
    expect(await getSchedulerRun(inventoryDb, runId)).toMatchObject({
      status: "partial",
      expectedManagerCount: 2,
      queuedManagerCount: 0,
      completedManagerCount: 2,
      failedManagerCount: 1,
      errorSummary: expect.stringContaining("queue unavailable")
    });
    const inventorySchedule = (await listScheduleStates(inventoryDb)).find((state) => state.jobType === "inventory");
    expect(inventorySchedule).toMatchObject({ lastResult: "partial" });
    await scheduler.stop();
  });

  it("keeps a dispatch active through a transient manager retry and finalizes it after the successful retry", async () => {
    const db = memoryDatabase();
    db.prepare(
      `INSERT INTO managers (id, name, url, enabled, username_ciphertext, password_ciphertext)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("manager-1", "Lab 1", "https://lab-1.example/ovirt-engine", 1, "user", "password");

    const inventoryDb = (await memoryPostgres()) as ConnectablePostgres;
    const queue = new FakeQueue();
    const scheduler = createDurableScheduler({
      db,
      inventoryDb,
      queue,
      config: testConfig({
        credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
        postgres: { databaseUrl: "postgres://scheduler@example.local/ovirt", ssl: false },
        metrics: { backend: "postgres" },
        collector: { ...testConfig().collector, enabled: true }
      })
    });
    collectManagerSnapshotById
      .mockResolvedValueOnce({ id: "snapshot-1", status: "failed", warningsCount: 0, errorsCount: 1, errors: [{ message: "temporary network failure" }] })
      .mockResolvedValueOnce({ id: "snapshot-2", status: "success", warningsCount: 0, errorsCount: 0, errors: [] });

    await scheduler.start();
    await inventoryDb.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
    await scheduler.dispatchDue("inventory");

    const queuedJob = queue.sent[0];
    const runId = (queuedJob?.data as { runId: string }).runId;
    const worker = queue.workers.get("scheduler.inventory-manager-collect");
    expect(worker).toBeDefined();

    const firstAttempt = await worker?.([{ id: "job-1", data: queuedJob?.data ?? {}, retryCount: 0, retryLimit: 1 }]);
    expect(firstAttempt).toEqual([expect.objectContaining({ id: "job-1", status: "failed" })]);
    expect(await getSchedulerRun(inventoryDb, runId)).toMatchObject({ status: "running", completedManagerCount: 0 });

    const secondAttempt = await worker?.([{ id: "job-1", data: queuedJob?.data ?? {}, retryCount: 1, retryLimit: 1 }]);
    expect(secondAttempt).toEqual([expect.objectContaining({ id: "job-1", status: "completed" })]);
    expect(await getSchedulerRun(inventoryDb, runId)).toMatchObject({ status: "success", completedManagerCount: 1 });
    await scheduler.stop();
  });
});
