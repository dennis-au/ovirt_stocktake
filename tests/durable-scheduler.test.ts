import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDurableScheduler,
  type DurableJobQueue,
  type QueueJob,
  type QueueJobResult
} from "../server/durable-scheduler.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import type { ConnectablePostgres } from "../server/postgres/inventory.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { listScheduleStates } from "../server/scheduler-state.js";
import { saveAppSettings } from "../server/settings.js";
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

class FakeQueue implements DurableJobQueue {
  readonly queues: string[] = [];
  readonly schedules: Array<{ name: string; cron: string }> = [];
  readonly sent: Array<{ name: string; data: object; options?: object }> = [];
  readonly workers = new Map<string, (jobs: QueueJob<object>[]) => Promise<QueueJobResult[]>>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(name: string): Promise<void> {
    this.queues.push(name);
  }
  async schedule(name: string, cron: string): Promise<void> {
    this.schedules.push({ name, cron });
  }
  async work(name: string, _options: object, handler: (jobs: QueueJob<object>[]) => Promise<QueueJobResult[]>): Promise<void> {
    this.workers.set(name, handler);
  }
  async send(name: string, data: object, options?: object): Promise<string> {
    this.sent.push({ name, data, options });
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
    expect(queue.sent.map((job) => job.data)).toEqual([{ managerId: "manager-1" }, { managerId: "manager-2" }]);
    expect(queue.sent.every((job) => (job.options as { singletonKey?: string }).singletonKey?.startsWith("inventory:"))).toBe(true);

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
});
