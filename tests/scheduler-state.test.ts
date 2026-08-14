import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { claimDueSchedule, listScheduleStates, synchronizeScheduleStates, type ScheduleDefinition } from "../server/scheduler-state.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(pool);
  return pool;
}

const schedules: ScheduleDefinition[] = [
  { jobType: "inventory", enabled: true, intervalMinutes: 15 },
  { jobType: "metrics", enabled: true, intervalMinutes: 5 }
];

describe("durable scheduler state", () => {
  it("keeps user cadence in PostgreSQL and claims each overdue schedule once", async () => {
    const db = await memoryPostgres();
    await synchronizeScheduleStates(db, schedules);

    const initial = await listScheduleStates(db);
    expect(initial.map((state) => state.jobType)).toEqual(["inventory", "metrics"]);
    expect(initial.find((state) => state.jobType === "inventory")?.intervalMinutes).toBe(15);

    await db.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);
    const firstClaim = await claimDueSchedule(db, "inventory");
    const secondClaim = await claimDueSchedule(db, "inventory");

    expect(firstClaim?.jobType).toBe("inventory");
    expect(secondClaim).toBeUndefined();
    await db.end();
  });

  it("claims an overdue schedule set with PostgreSQL time", async () => {
    const db = await memoryPostgres();
    await synchronizeScheduleStates(db, schedules);
    await db.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE job_type = $1", ["inventory"]);

    const claim = await claimDueSchedule(db, "inventory");

    expect(claim?.jobType).toBe("inventory");
    expect(claim?.nextRunAt).toBeDefined();
    await db.end();
  });

  it("reanchors the next run when an administrator changes a schedule", async () => {
    const db = await memoryPostgres();
    await synchronizeScheduleStates(db, schedules);
    await db.query("UPDATE scheduler_schedule_state SET next_run_at = CURRENT_TIMESTAMP + INTERVAL '10 days' WHERE job_type = $1", ["inventory"]);

    await synchronizeScheduleStates(db, [
      { jobType: "inventory", enabled: true, intervalMinutes: 30 },
      { jobType: "metrics", enabled: false, intervalMinutes: 5 }
    ]);

    const states = await listScheduleStates(db);
    expect(states.find((state) => state.jobType === "inventory")?.intervalMinutes).toBe(30);
    expect(states.find((state) => state.jobType === "metrics")?.enabled).toBe(false);
    expect(states.find((state) => state.jobType === "metrics")?.nextRunAt).toBeUndefined();
    await db.end();
  });
});
