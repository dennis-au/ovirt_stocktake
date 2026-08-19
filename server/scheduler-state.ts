import type { PostgresQueryable } from "./postgres/migrate.js";

export type ScheduledJobType = "inventory" | "metrics";
export type ScheduleResult = "success" | "partial" | "failed";

export interface ScheduleDefinition {
  jobType: ScheduledJobType;
  enabled: boolean;
  intervalMinutes: number;
}

export interface ScheduleState extends ScheduleDefinition {
  nextRunAt?: string;
  lastQueuedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: ScheduleResult;
  lastErrorSummary?: string;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface SchedulerReconcilerState {
  lastPolledAt?: string;
  lastSuccessfulPollAt?: string;
  lastErrorAt?: string;
  lastErrorSummary?: string;
  updatedAt: string;
}

interface ScheduleStateRow {
  job_type: ScheduledJobType;
  enabled: boolean;
  interval_minutes: number;
  next_run_at: Date | string | null;
  last_queued_at: Date | string | null;
  last_started_at: Date | string | null;
  last_completed_at: Date | string | null;
  last_result: ScheduleResult | null;
  last_error_summary: string | null;
  consecutive_failures: number;
  updated_at: Date | string;
}

interface SchedulerReconcilerStateRow {
  last_polled_at: Date | string | null;
  last_successful_poll_at: Date | string | null;
  last_error_at: Date | string | null;
  last_error_summary: string | null;
  updated_at: Date | string;
}

export async function synchronizeScheduleStates(db: PostgresQueryable, schedules: ScheduleDefinition[]): Promise<void> {
  const now = await databaseNow(db);
  for (const schedule of schedules) {
    const existing = await getScheduleState(db, schedule.jobType);
    const mustReanchor =
      !existing ||
      existing.enabled !== schedule.enabled ||
      existing.intervalMinutes !== schedule.intervalMinutes ||
      (schedule.enabled && !existing.nextRunAt);
    const nextRunAt = schedule.enabled ? (mustReanchor ? addMinutes(now, schedule.intervalMinutes) : existing?.nextRunAt) : undefined;

    await db.query(
      `
        INSERT INTO scheduler_schedule_state (job_type, enabled, interval_minutes, next_run_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (job_type) DO UPDATE SET
          enabled = excluded.enabled,
          interval_minutes = excluded.interval_minutes,
          next_run_at = excluded.next_run_at,
          updated_at = CURRENT_TIMESTAMP
      `,
      [schedule.jobType, schedule.enabled, schedule.intervalMinutes, nextRunAt ?? null]
    );
  }
}

export async function claimDueSchedule(db: PostgresQueryable, jobType: ScheduledJobType): Promise<ScheduleState | undefined> {
  const current = await getScheduleState(db, jobType);
  if (!current) {
    return undefined;
  }

  const now = await databaseNow(db);
  const nextRunAt = addMinutes(now, current.intervalMinutes);
  const result = await db.query<ScheduleStateRow>(
    `
      UPDATE scheduler_schedule_state
      SET
        next_run_at = $3,
        last_queued_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_type = $1
        AND enabled = TRUE
        AND next_run_at <= $2::timestamptz
      RETURNING *
    `,
    [jobType, now.toISOString(), nextRunAt]
  );
  return result.rows[0] ? toScheduleState(result.rows[0]) : undefined;
}

export async function markScheduleStarted(db: PostgresQueryable, jobType: ScheduledJobType): Promise<void> {
  await db.query(
    `
      UPDATE scheduler_schedule_state
      SET last_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE job_type = $1
    `,
    [jobType]
  );
}

export async function markScheduleCompleted(
  db: PostgresQueryable,
  jobType: ScheduledJobType,
  result: ScheduleResult,
  errorSummary?: string
): Promise<void> {
  await db.query(
    `
      UPDATE scheduler_schedule_state
      SET
        last_completed_at = CURRENT_TIMESTAMP,
        last_result = $2,
        last_error_summary = $3,
        consecutive_failures = CASE WHEN $2 = 'failed' THEN consecutive_failures + 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE job_type = $1
    `,
    [jobType, result, errorSummary ?? null]
  );
}

export async function listScheduleStates(db: PostgresQueryable): Promise<ScheduleState[]> {
  const result = await db.query<ScheduleStateRow>(
    `
      SELECT *
      FROM scheduler_schedule_state
      ORDER BY job_type
    `
  );
  return result.rows.map(toScheduleState);
}

export async function recordSchedulerReconcilerPoll(
  db: PostgresQueryable,
  success: boolean,
  errorSummary?: string
): Promise<SchedulerReconcilerState> {
  const result = success
    ? await db.query<SchedulerReconcilerStateRow>(
        `
          INSERT INTO scheduler_reconciler_state
            (singleton, last_polled_at, last_successful_poll_at)
          VALUES (TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (singleton) DO UPDATE SET
            last_polled_at = CURRENT_TIMESTAMP,
            last_successful_poll_at = CURRENT_TIMESTAMP,
            last_error_at = NULL,
            last_error_summary = NULL,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `
      )
    : await db.query<SchedulerReconcilerStateRow>(
        `
          INSERT INTO scheduler_reconciler_state
            (singleton, last_polled_at, last_error_at, last_error_summary)
          VALUES (TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $1)
          ON CONFLICT (singleton) DO UPDATE SET
            last_polled_at = CURRENT_TIMESTAMP,
            last_error_at = CURRENT_TIMESTAMP,
            last_error_summary = $1,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `,
        [errorSummary ?? null]
      );
  return toSchedulerReconcilerState(result.rows[0]!);
}

export async function getSchedulerReconcilerState(db: PostgresQueryable): Promise<SchedulerReconcilerState | undefined> {
  const result = await db.query<SchedulerReconcilerStateRow>(
    `SELECT last_polled_at, last_successful_poll_at, last_error_at, last_error_summary, updated_at
     FROM scheduler_reconciler_state
     WHERE singleton = TRUE`
  );
  return result.rows[0] ? toSchedulerReconcilerState(result.rows[0]) : undefined;
}

async function getScheduleState(db: PostgresQueryable, jobType: ScheduledJobType): Promise<ScheduleState | undefined> {
  const result = await db.query<ScheduleStateRow>(
    "SELECT * FROM scheduler_schedule_state WHERE job_type = $1",
    [jobType]
  );
  return result.rows[0] ? toScheduleState(result.rows[0]) : undefined;
}

async function databaseNow(db: PostgresQueryable): Promise<Date> {
  const result = await db.query<{ now: Date | string }>("SELECT CURRENT_TIMESTAMP AS now");
  const value = result.rows[0]?.now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("PostgreSQL did not return a valid current timestamp");
  }
  return date;
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function toScheduleState(row: ScheduleStateRow): ScheduleState {
  return {
    jobType: row.job_type,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    ...(toIso(row.next_run_at) ? { nextRunAt: toIso(row.next_run_at) } : {}),
    ...(toIso(row.last_queued_at) ? { lastQueuedAt: toIso(row.last_queued_at) } : {}),
    ...(toIso(row.last_started_at) ? { lastStartedAt: toIso(row.last_started_at) } : {}),
    ...(toIso(row.last_completed_at) ? { lastCompletedAt: toIso(row.last_completed_at) } : {}),
    ...(row.last_result ? { lastResult: row.last_result } : {}),
    ...(row.last_error_summary ? { lastErrorSummary: row.last_error_summary } : {}),
    consecutiveFailures: row.consecutive_failures,
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString()
  };
}

function toSchedulerReconcilerState(row: SchedulerReconcilerStateRow): SchedulerReconcilerState {
  return {
    ...(toIso(row.last_polled_at) ? { lastPolledAt: toIso(row.last_polled_at) } : {}),
    ...(toIso(row.last_successful_poll_at) ? { lastSuccessfulPollAt: toIso(row.last_successful_poll_at) } : {}),
    ...(toIso(row.last_error_at) ? { lastErrorAt: toIso(row.last_error_at) } : {}),
    ...(row.last_error_summary ? { lastErrorSummary: row.last_error_summary } : {}),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString()
  };
}

function toIso(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
