import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeSchedulerRunManager,
  createSchedulerRun,
  getSchedulerRun,
  markSchedulerRunManagerQueued,
  markSchedulerRunManagerStarted,
  recoverStaleSchedulerRuns
} from "../server/scheduler-runs.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";

const databases: Array<PostgresQueryable & { end(): Promise<void> }> = [];

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const db = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(db);
  databases.push(db);
  return db;
}

afterEach(async () => {
  while (databases.length) {
    await databases.pop()?.end();
  }
});

describe("scheduler dispatch runs", () => {
  it("keeps a mixed manager outcome partial regardless of completion order", async () => {
    const db = await memoryPostgres();
    const run = await createSchedulerRun(db, "inventory", ["manager-1", "manager-2"]);

    await markSchedulerRunManagerQueued(db, run.id, "manager-1", "job-1");
    await markSchedulerRunManagerQueued(db, run.id, "manager-2", "job-2");
    await markSchedulerRunManagerStarted(db, run.id, "manager-1");
    await markSchedulerRunManagerStarted(db, run.id, "manager-2");

    expect(await completeSchedulerRunManager(db, run.id, "manager-2", "success")).toBeUndefined();
    const completed = await completeSchedulerRunManager(db, run.id, "manager-1", "failed", "oVirt returned HTTP 500");

    expect(completed).toMatchObject({
      id: run.id,
      jobType: "inventory",
      status: "partial",
      expectedManagerCount: 2,
      completedManagerCount: 2,
      errorSummary: expect.stringContaining("manager-1")
    });
    expect(await getSchedulerRun(db, run.id)).toMatchObject({ status: "partial", completedManagerCount: 2 });
  });

  it("marks a dispatch as failed only when every manager fails", async () => {
    const db = await memoryPostgres();
    const run = await createSchedulerRun(db, "metrics", ["manager-1", "manager-2"]);

    await markSchedulerRunManagerQueued(db, run.id, "manager-1", "job-1");
    await markSchedulerRunManagerQueued(db, run.id, "manager-2", "job-2");
    expect(await completeSchedulerRunManager(db, run.id, "manager-1", "failed", "authentication failed")).toBeUndefined();

    expect(await completeSchedulerRunManager(db, run.id, "manager-2", "failed", "network failure")).toMatchObject({
      status: "failed",
      completedManagerCount: 2,
      failedManagerCount: 2
    });
  });

  it("does not reopen a terminal manager result when pg-boss retries its job", async () => {
    const db = await memoryPostgres();
    const run = await createSchedulerRun(db, "inventory", ["manager-1"]);

    await markSchedulerRunManagerQueued(db, run.id, "manager-1", "job-1");
    expect(await markSchedulerRunManagerStarted(db, run.id, "manager-1")).toBe(true);
    expect(await markSchedulerRunManagerStarted(db, run.id, "manager-1")).toBe(true);
    await completeSchedulerRunManager(db, run.id, "manager-1", "failed", "temporary network failure");

    expect(await markSchedulerRunManagerStarted(db, run.id, "manager-1")).toBe(false);
    expect(await getSchedulerRun(db, run.id)).toMatchObject({
      status: "failed",
      completedManagerCount: 1,
      failedManagerCount: 1
    });
  });

  it("skips abandoned manager jobs and releases a stale dispatch run", async () => {
    const db = await memoryPostgres();
    const run = await createSchedulerRun(db, "inventory", ["manager-1", "manager-2"]);
    await markSchedulerRunManagerQueued(db, run.id, "manager-1", "job-1");
    await markSchedulerRunManagerQueued(db, run.id, "manager-2", "job-2");
    await db.query("UPDATE scheduler_dispatch_runs SET created_at = CURRENT_TIMESTAMP - INTERVAL '21 minutes' WHERE id = $1", [run.id]);

    const recovered = await recoverStaleSchedulerRuns(db, new Date(), 20 * 60_000);

    expect(recovered).toEqual([expect.objectContaining({ id: run.id, status: "partial", completedManagerCount: 2 })]);
    expect(await getSchedulerRun(db, run.id)).toMatchObject({ status: "partial", completedManagerCount: 2 });
  });
});
