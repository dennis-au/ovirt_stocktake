import { randomUUID } from "node:crypto";
import type { PostgresQueryable } from "./postgres/migrate.js";
import type { ScheduledJobType, ScheduleResult } from "./scheduler-state.js";

type SchedulerDispatchStatus = "queued" | "running" | ScheduleResult;
type SchedulerManagerStatus = "pending" | "queued" | "running" | ScheduleResult | "skipped";
type SchedulerManagerTerminalStatus = ScheduleResult | "skipped";

interface SchedulerDispatchRunRow {
  id: string;
  job_type: ScheduledJobType;
  status: SchedulerDispatchStatus;
  expected_manager_count: number;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  error_summary: string | null;
  heartbeat_at: Date | string | null;
  created_at: Date | string;
}

interface SchedulerDispatchRunManagerRow {
  manager_id: string;
  queue_job_id: string | null;
  status: SchedulerManagerStatus;
  error_summary: string | null;
}

export interface SchedulerDispatchRun {
  id: string;
  jobType: ScheduledJobType;
  status: SchedulerDispatchStatus;
  expectedManagerCount: number;
  queuedManagerCount: number;
  completedManagerCount: number;
  failedManagerCount: number;
  startedAt?: string;
  completedAt?: string;
  errorSummary?: string;
  createdAt: string;
}

export async function createSchedulerRun(
  db: PostgresQueryable,
  jobType: ScheduledJobType,
  managerIds: string[]
): Promise<SchedulerDispatchRun> {
  const id = randomUUID();
  const uniqueManagerIds = [...new Set(managerIds)];
  await db.query(
    `INSERT INTO scheduler_dispatch_runs (id, job_type, expected_manager_count)
     VALUES ($1, $2, $3)`,
    [id, jobType, uniqueManagerIds.length]
  );
  for (const managerId of uniqueManagerIds) {
    await db.query(
      `INSERT INTO scheduler_dispatch_run_managers (run_id, manager_id)
       VALUES ($1, $2)`,
      [id, managerId]
    );
  }
  return requireSchedulerRun(db, id);
}

export async function getSchedulerRun(db: PostgresQueryable, runId: string): Promise<SchedulerDispatchRun | undefined> {
  const run = await getSchedulerRunRow(db, runId);
  return run ? toSchedulerRun(run, await listSchedulerRunManagers(db, runId)) : undefined;
}

export async function hasActiveSchedulerRun(db: PostgresQueryable, jobType: ScheduledJobType): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM scheduler_dispatch_runs WHERE job_type = $1 AND completed_at IS NULL LIMIT 1", [jobType]);
  return (result.rowCount ?? 0) > 0;
}

export async function recoverStaleSchedulerRuns(
  db: PostgresQueryable,
  now = new Date(),
  staleAfterMs = 20 * 60_000
): Promise<SchedulerDispatchRun[]> {
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
  const staleRuns = await db.query<{ id: string }>(
    `SELECT id
     FROM scheduler_dispatch_runs
     WHERE completed_at IS NULL
       AND COALESCE(heartbeat_at, started_at, created_at) < $1
     ORDER BY created_at, id`,
    [cutoff]
  );
  const recovered: SchedulerDispatchRun[] = [];

  for (const { id } of staleRuns.rows) {
    await db.query(
      `UPDATE scheduler_dispatch_run_managers
       SET
         status = 'skipped',
         completed_at = CURRENT_TIMESTAMP,
         error_summary = COALESCE(error_summary, 'Scheduled job expired without worker completion; skipped until next scheduled run')
       WHERE run_id = $1
         AND status IN ('pending', 'queued', 'running')`,
      [id]
    );
    const completed = await finalizeSchedulerRun(db, id);
    if (completed) {
      recovered.push(completed);
    }
  }

  return recovered;
}

export async function markSchedulerRunManagerStarted(db: PostgresQueryable, runId: string, managerId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE scheduler_dispatch_run_managers
     SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
     WHERE run_id = $1
       AND manager_id = $2
       AND status IN ('pending', 'queued', 'running')`,
    [runId, managerId]
  );
  if ((result.rowCount ?? 0) === 1) {
    await db.query(
      `UPDATE scheduler_dispatch_runs
       SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), heartbeat_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    return true;
  }

  const existing = await db.query<{ status: SchedulerManagerStatus }>(
    "SELECT status FROM scheduler_dispatch_run_managers WHERE run_id = $1 AND manager_id = $2",
    [runId, managerId]
  );
  if (!existing.rows[0]) {
    throw new Error(`Scheduler run manager ${managerId} does not exist`);
  }
  return false;
}

export async function touchSchedulerRun(db: PostgresQueryable, runId: string): Promise<void> {
  await db.query(
    `UPDATE scheduler_dispatch_runs
     SET heartbeat_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND completed_at IS NULL`,
    [runId]
  );
}

export async function completeSchedulerRunManager(
  db: PostgresQueryable,
  runId: string,
  managerId: string,
  status: SchedulerManagerTerminalStatus,
  errorSummary?: string
): Promise<SchedulerDispatchRun | undefined> {
  await updateSchedulerRunManager(db, runId, managerId, status, errorSummary);
  return finalizeSchedulerRun(db, runId);
}

async function updateSchedulerRunManager(
  db: PostgresQueryable,
  runId: string,
  managerId: string,
  status: SchedulerManagerStatus,
  errorSummary?: string
): Promise<void> {
  const terminal = isTerminalStatus(status);
  const startedAtUpdate = status === "running" ? "started_at = COALESCE(started_at, CURRENT_TIMESTAMP)" : "started_at = started_at";
  const completedAtUpdate = terminal ? "completed_at = CURRENT_TIMESTAMP" : "completed_at = completed_at";
  const result = await db.query(
    `UPDATE scheduler_dispatch_run_managers
     SET
       status = $3,
       error_summary = COALESCE($4, error_summary),
       ${startedAtUpdate},
       ${completedAtUpdate}
     WHERE run_id = $1
       AND manager_id = $2
       AND status IN ('pending', 'queued', 'running')`,
    [runId, managerId, status, errorSummary ?? null]
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(`Scheduler run manager ${managerId} is not pending`);
  }
}

export async function finalizeSchedulerRun(db: PostgresQueryable, runId: string): Promise<SchedulerDispatchRun | undefined> {
  const run = await getSchedulerRunRow(db, runId);
  if (!run || run.completed_at) {
    return undefined;
  }
  const managers = await listSchedulerRunManagers(db, runId);
  if (managers.length !== run.expected_manager_count || managers.some((manager) => !isTerminalStatus(manager.status))) {
    return undefined;
  }

  const status = aggregateStatus(managers);
  const errorSummary = managers
    .filter((manager) => manager.error_summary)
    .map((manager) => `${manager.manager_id}: ${manager.error_summary}`)
    .join("; ");
  const finalized = await db.query<SchedulerDispatchRunRow>(
    `UPDATE scheduler_dispatch_runs
     SET status = $2, completed_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP, error_summary = $3
     WHERE id = $1 AND completed_at IS NULL
     RETURNING *`,
    [runId, status, errorSummary || null]
  );
  return finalized.rows[0] ? toSchedulerRun(finalized.rows[0], managers) : undefined;
}

function aggregateStatus(managers: SchedulerDispatchRunManagerRow[]): ScheduleResult {
  if (managers.length === 0 || managers.every((manager) => manager.status === "success")) {
    return "success";
  }
  return managers.every((manager) => manager.status === "failed") ? "failed" : "partial";
}

function isTerminalStatus(status: SchedulerManagerStatus): status is SchedulerManagerTerminalStatus {
  return ["success", "partial", "failed", "skipped"].includes(status);
}

async function requireSchedulerRun(db: PostgresQueryable, runId: string): Promise<SchedulerDispatchRun> {
  const run = await getSchedulerRun(db, runId);
  if (!run) {
    throw new Error(`Scheduler run ${runId} was not created`);
  }
  return run;
}

async function getSchedulerRunRow(db: PostgresQueryable, runId: string): Promise<SchedulerDispatchRunRow | undefined> {
  const result = await db.query<SchedulerDispatchRunRow>("SELECT * FROM scheduler_dispatch_runs WHERE id = $1", [runId]);
  return result.rows[0];
}

async function listSchedulerRunManagers(db: PostgresQueryable, runId: string): Promise<SchedulerDispatchRunManagerRow[]> {
  const result = await db.query<SchedulerDispatchRunManagerRow>(
    "SELECT manager_id, queue_job_id, status, error_summary FROM scheduler_dispatch_run_managers WHERE run_id = $1 ORDER BY manager_id",
    [runId]
  );
  return result.rows;
}

function toSchedulerRun(run: SchedulerDispatchRunRow, managers: SchedulerDispatchRunManagerRow[]): SchedulerDispatchRun {
  return {
    id: run.id,
    jobType: run.job_type,
    status: run.status,
    expectedManagerCount: run.expected_manager_count,
    queuedManagerCount: managers.filter((manager) => manager.queue_job_id).length,
    completedManagerCount: managers.filter((manager) => isTerminalStatus(manager.status)).length,
    failedManagerCount: managers.filter((manager) => manager.status === "failed").length,
    ...(toIso(run.started_at) ? { startedAt: toIso(run.started_at) } : {}),
    ...(toIso(run.completed_at) ? { completedAt: toIso(run.completed_at) } : {}),
    ...(run.error_summary ? { errorSummary: run.error_summary } : {}),
    createdAt: toIso(run.created_at) ?? new Date(0).toISOString()
  };
}

function toIso(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
