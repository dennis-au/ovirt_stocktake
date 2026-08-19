import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { collectManagerSnapshotById } from "./collection.js";
import type { SqliteDatabase } from "./db.js";
import { collectManagerMetricsById, metricsStorageEnabled } from "./metrics-collection.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import {
  completeSchedulerRunManager,
  createSchedulerRun,
  finalizeSchedulerRun,
  hasActiveSchedulerRun,
  markSchedulerRunManagerStarted,
  recoverStaleSchedulerRuns,
  touchSchedulerRun,
  type SchedulerDispatchRun
} from "./scheduler-runs.js";
import {
  claimDueSchedule,
  getSchedulerReconcilerState,
  markScheduleCompleted,
  markScheduleStarted,
  recordSchedulerReconcilerPoll,
  synchronizeScheduleStates,
  type ScheduleDefinition,
  type ScheduleResult,
  type ScheduledJobType,
  type SchedulerReconcilerState
} from "./scheduler-state.js";
import { getAppSettings, type AppSettings } from "./settings.js";

const defaultReconcileIntervalMs = 30_000;
const runHeartbeatIntervalMs = 30_000;
const staleRunAfterMs = 20 * 60_000;

export interface DurableScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncSettings(settings?: AppSettings): Promise<void>;
  dispatchDue(jobType: ScheduledJobType): Promise<void>;
  readonly status: DurableSchedulerStatus;
}

export interface DurableSchedulerStatus {
  backend: "postgres-reconciler";
  available: boolean;
  running: boolean;
  lastError?: string;
  lastErrorAt?: string;
  lastPolledAt?: string;
  lastSuccessfulPollAt?: string;
}

export interface DurableSchedulerOptions {
  db: SqliteDatabase;
  config: AppConfig;
  inventoryDb: ConnectablePostgres;
  reconcileIntervalMs?: number;
}

export function schedulerAvailable(config: AppConfig, inventoryDb?: ConnectablePostgres): boolean {
  return Boolean(config.collector.enabled && config.postgres.databaseUrl && inventoryDb);
}

export function createDurableScheduler(options: DurableSchedulerOptions): DurableScheduler {
  return new PostgresReconcilerScheduler(options);
}

class PostgresReconcilerScheduler implements DurableScheduler {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private reconciliation?: Promise<void>;
  private lastError?: string;
  private lastErrorAt?: string;
  private reconcilerState?: SchedulerReconcilerState;

  constructor(private readonly options: DurableSchedulerOptions) {}

  get status(): DurableSchedulerStatus {
    const lastError = this.lastError ?? this.reconcilerState?.lastErrorSummary;
    const lastErrorAt = this.lastErrorAt ?? this.reconcilerState?.lastErrorAt;
    return {
      backend: "postgres-reconciler",
      available: true,
      running: this.running,
      ...(lastError ? { lastError, lastErrorAt } : {}),
      ...(this.reconcilerState?.lastPolledAt ? { lastPolledAt: this.reconcilerState.lastPolledAt } : {}),
      ...(this.reconcilerState?.lastSuccessfulPollAt ? { lastSuccessfulPollAt: this.reconcilerState.lastSuccessfulPollAt } : {})
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.syncSettings();
    this.reconcilerState = await getSchedulerReconcilerState(this.options.inventoryDb);
    this.running = true;
    await this.reconcile();
    this.armNextPoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.reconciliation;
  }

  async syncSettings(settings = getAppSettings(this.options.db, this.options.config)): Promise<void> {
    await synchronizeScheduleStates(this.options.inventoryDb, scheduleDefinitions(settings, this.options.config, this.options.inventoryDb));
  }

  async dispatchDue(jobType: ScheduledJobType): Promise<void> {
    if (await hasActiveSchedulerRun(this.options.inventoryDb, jobType)) {
      return;
    }

    const schedule = await claimDueSchedule(this.options.inventoryDb, jobType);
    if (!schedule) {
      return;
    }

    const managerIds = listEnabledManagerIds(this.options.db);
    const run = await createSchedulerRun(this.options.inventoryDb, jobType, managerIds);
    await markScheduleStarted(this.options.inventoryDb, jobType);

    recordAudit(this.options.db, {
      actor: "scheduler",
      action: "scheduler.dispatch_started",
      resourceType: "scheduler_dispatch_run",
      resourceId: run.id,
      metadata: { jobType, managers: managerIds.length, intervalMinutes: schedule.intervalMinutes, execution: "sequential" }
    });

    let completedRun = managerIds.length === 0 ? await finalizeSchedulerRun(this.options.inventoryDb, run.id) : undefined;
    for (const managerId of managerIds) {
      if (!(await markSchedulerRunManagerStarted(this.options.inventoryDb, run.id, managerId))) {
        continue;
      }

      completedRun = await this.collectManager(jobType, run, managerId);
    }

    await this.completeScheduleRun(jobType, completedRun);
    recordAudit(this.options.db, {
      actor: "scheduler",
      action: "scheduler.dispatch_completed",
      resourceType: "scheduler_dispatch_run",
      resourceId: run.id,
      metadata: {
        jobType,
        managers: managerIds.length,
        status: completedRun?.status ?? "running",
        execution: "sequential"
      }
    });
  }

  private async reconcile(): Promise<void> {
    if (this.reconciliation) {
      return this.reconciliation;
    }

    this.reconciliation = this.reconcileOnce()
      .catch(() => undefined)
      .finally(() => {
        this.reconciliation = undefined;
      });
    return this.reconciliation;
  }

  private async reconcileOnce(): Promise<void> {
    try {
      await this.recoverStaleRuns();
      await this.dispatchDue("inventory");
      await this.dispatchDue("metrics");
      this.reconcilerState = await recordSchedulerReconcilerPoll(this.options.inventoryDb, true);
      this.lastError = undefined;
      this.lastErrorAt = undefined;
    } catch (error) {
      const message = errorMessage(error);
      this.lastError = message;
      this.lastErrorAt = new Date().toISOString();
      try {
        this.reconcilerState = await recordSchedulerReconcilerPoll(this.options.inventoryDb, false, message);
      } catch {
        // PostgreSQL may be unavailable, so preserve the in-memory error for Settings and retry on the next poll.
      }
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "scheduler.reconciler_failed",
        metadata: { message }
      });
    }
  }

  private armNextPoll(): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(async () => {
      await this.reconcile();
      this.armNextPoll();
    }, this.options.reconcileIntervalMs ?? defaultReconcileIntervalMs);
  }

  private async collectManager(
    jobType: ScheduledJobType,
    run: SchedulerDispatchRun,
    managerId: string
  ): Promise<SchedulerDispatchRun | undefined> {
    try {
      if (jobType === "inventory") {
        const snapshot = await this.withRunHeartbeat(run.id, () =>
          collectManagerSnapshotById(this.options.db, this.options.config, managerId, this.options.inventoryDb)
        );
        const errorSummary = snapshot.errors.map((issue) => issue.message).join("; ") || undefined;
        const completed = await completeSchedulerRunManager(this.options.inventoryDb, run.id, managerId, snapshot.status, errorSummary);
        recordAudit(this.options.db, {
          actor: "scheduler",
          action: "collection.scheduled_manager_completed",
          resourceType: "manager",
          resourceId: managerId,
          metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
        });
        return completed;
      }

      const result = await this.withRunHeartbeat(run.id, () =>
        collectManagerMetricsById(this.options.db, this.options.config, managerId, this.options.inventoryDb)
      );
      const errorSummary = result.errors.map((issue) => issue.message).join("; ") || undefined;
      const status: ScheduleResult = result.errors.length === 0 ? "success" : result.sampleCount > 0 ? "partial" : "failed";
      const completed = await completeSchedulerRunManager(this.options.inventoryDb, run.id, managerId, status, errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "metrics.scheduled_manager_completed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { status, samples: result.sampleCount, warnings: result.warnings.length, errors: result.errors.length }
      });
      return completed;
    } catch (error) {
      const message = errorMessage(error);
      const completed = await completeSchedulerRunManager(this.options.inventoryDb, run.id, managerId, "failed", message);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: jobType === "inventory" ? "collection.scheduled_manager_failed" : "metrics.scheduled_manager_failed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { message }
      });
      return completed;
    }
  }

  private async withRunHeartbeat<T>(runId: string, action: () => Promise<T>): Promise<T> {
    await touchSchedulerRun(this.options.inventoryDb, runId);
    const heartbeat = setInterval(() => {
      void touchSchedulerRun(this.options.inventoryDb, runId).catch(() => undefined);
    }, runHeartbeatIntervalMs);
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      await touchSchedulerRun(this.options.inventoryDb, runId);
    }
  }

  private async completeScheduleRun(jobType: ScheduledJobType, run: SchedulerDispatchRun | undefined): Promise<void> {
    if (!run) {
      return;
    }
    const result = asScheduleResult(run.status);
    if (result) {
      await markScheduleCompleted(this.options.inventoryDb, jobType, result, run.errorSummary);
    }
  }

  private async recoverStaleRuns(): Promise<void> {
    const recovered = await recoverStaleSchedulerRuns(this.options.inventoryDb, new Date(), staleRunAfterMs);
    for (const run of recovered) {
      const result = asScheduleResult(run.status);
      if (result) {
        await markScheduleCompleted(this.options.inventoryDb, run.jobType, result, run.errorSummary);
      }
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "scheduler.stale_run_skipped",
        resourceType: "scheduler_dispatch_run",
        resourceId: run.id,
        metadata: { jobType: run.jobType, status: run.status, completedManagers: run.completedManagerCount }
      });
    }
  }
}

function asScheduleResult(status: SchedulerDispatchRun["status"]): ScheduleResult | undefined {
  return status === "success" || status === "partial" || status === "failed" ? status : undefined;
}

function scheduleDefinitions(settings: AppSettings, config: AppConfig, inventoryDb: ConnectablePostgres): ScheduleDefinition[] {
  return [
    {
      jobType: "inventory",
      enabled: config.collector.enabled && settings.inventoryCollectionEnabled,
      intervalMinutes: settings.snapshotIntervalMinutes
    },
    {
      jobType: "metrics",
      enabled: config.collector.enabled && settings.metricsCollectionEnabled && metricsStorageEnabled(config, inventoryDb),
      intervalMinutes: settings.metricsIntervalMinutes
    }
  ];
}

function listEnabledManagerIds(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT id FROM managers WHERE enabled = 1 ORDER BY name COLLATE NOCASE").all() as Array<{ id: string }>).map((manager) => manager.id);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Scheduler reconciliation failed";
}
