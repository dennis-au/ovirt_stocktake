import { PgBoss, type Queue, type QueueOptions, type SendOptions, type WorkOptions } from "pg-boss";
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
  markSchedulerRunManagerQueued,
  markSchedulerRunManagerStarted,
  listStaleSchedulerRunJobs,
  recoverStaleSchedulerRuns,
  type SchedulerDispatchRun
} from "./scheduler-runs.js";
import {
  claimDueSchedule,
  markScheduleCompleted,
  markScheduleStarted,
  synchronizeScheduleStates,
  type ScheduleDefinition,
  type ScheduleResult,
  type ScheduledJobType
} from "./scheduler-state.js";
import { getAppSettings, type AppSettings } from "./settings.js";

const inventoryDispatchQueue = "scheduler.inventory-dispatch";
const inventoryManagerQueue = "scheduler.inventory-manager-collect";
const metricsDispatchQueue = "scheduler.metrics-dispatch";
const metricsManagerQueue = "scheduler.metrics-manager-collect";
const deadLetterQueue = "scheduler.dead-letter";
const dispatchCron = "* * * * *";
const managerJobExpirySeconds = 900;

const managerQueueOptions: QueueOptions = {
  expireInSeconds: managerJobExpirySeconds,
  retentionSeconds: 14 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  retryLimit: 0,
  heartbeatSeconds: 30
};

const staleRunAfterMs = managerJobExpirySeconds * 1000 + 5 * 60_000;

const managerQueueDefinition: Omit<Queue, "name"> = {
  ...managerQueueOptions,
  policy: "key_strict_fifo"
};

export interface QueueJob<T extends object = object> {
  id: string;
  data: T;
  retryCount?: number;
  retryLimit?: number;
}

export interface QueueJobResult {
  id: string;
  status: "completed" | "failed" | "deadletter";
  output?: object;
}

export interface DurableJobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  createQueue(name: string, options?: object): Promise<void>;
  updateQueue(name: string, options?: object): Promise<void>;
  cancel(name: string, id: string): Promise<void>;
  schedule(name: string, cron: string): Promise<void>;
  work(name: string, options: object, handler: (jobs: QueueJob[]) => Promise<QueueJobResult[]>): Promise<void>;
  send(name: string, data: object, options?: object): Promise<string | null>;
  onError?(handler: (error: unknown) => void): void;
}

export interface DurableScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  syncSettings(settings?: AppSettings): Promise<void>;
  dispatchDue(jobType: ScheduledJobType): Promise<void>;
  readonly status: DurableSchedulerStatus;
}

export interface DurableSchedulerStatus {
  backend: "pg-boss";
  available: boolean;
  running: boolean;
  lastError?: string;
  lastErrorAt?: string;
}

interface DurableSchedulerOptions {
  db: SqliteDatabase;
  config: AppConfig;
  inventoryDb: ConnectablePostgres;
  queue?: DurableJobQueue;
}

interface ManagerJobData {
  managerId: string;
  runId?: string;
}

export function schedulerAvailable(config: AppConfig, inventoryDb?: ConnectablePostgres): boolean {
  return Boolean(config.collector.enabled && config.postgres.databaseUrl && inventoryDb);
}

export function createDurableScheduler(options: DurableSchedulerOptions): DurableScheduler {
  return new PgBossScheduler(options);
}

class PgBossScheduler implements DurableScheduler {
  private readonly queue: DurableJobQueue;
  private running = false;
  private lastError?: string;
  private lastErrorAt?: string;

  constructor(private readonly options: DurableSchedulerOptions) {
    this.queue = options.queue ?? createPgBossQueue(options.config);
    this.queue.onError?.((error) => {
      this.lastError = errorMessage(error);
      this.lastErrorAt = new Date().toISOString();
    });
  }

  get status(): DurableSchedulerStatus {
    return {
      backend: "pg-boss",
      available: true,
      running: this.running,
      ...(this.lastError ? { lastError: this.lastError, lastErrorAt: this.lastErrorAt } : {})
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      await this.queue.start();
      await this.createQueues();
      await this.syncSettings();
      await this.recoverStaleRuns();
      await this.registerWorkers();
      await this.queue.schedule(inventoryDispatchQueue, dispatchCron);
      await this.queue.schedule(metricsDispatchQueue, dispatchCron);
      this.running = true;
      this.lastError = undefined;
      this.lastErrorAt = undefined;
    } catch (error) {
      this.lastError = errorMessage(error);
      await this.queue.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    await this.queue.stop();
  }

  async syncSettings(settings = getAppSettings(this.options.db, this.options.config)): Promise<void> {
    await synchronizeScheduleStates(this.options.inventoryDb, scheduleDefinitions(settings, this.options.config, this.options.inventoryDb));
  }

  async dispatchDue(jobType: ScheduledJobType): Promise<void> {
    await this.recoverStaleRuns();
    if (await hasActiveSchedulerRun(this.options.inventoryDb, jobType)) {
      return;
    }
    const schedule = await claimDueSchedule(this.options.inventoryDb, jobType);
    if (!schedule) {
      return;
    }

    const managerIds = listEnabledManagerIds(this.options.db);
    const queueName = jobType === "inventory" ? inventoryManagerQueue : metricsManagerQueue;
    const queued: string[] = [];
    const run = await createSchedulerRun(this.options.inventoryDb, jobType, managerIds);
    await markScheduleStarted(this.options.inventoryDb, jobType);
    let completedRun = managerIds.length === 0 ? await finalizeSchedulerRun(this.options.inventoryDb, run.id) : undefined;
    for (const managerId of managerIds) {
      try {
        const id = await this.queue.send(queueName, { managerId, runId: run.id }, managerSendOptions(jobType, managerId));
        if (id) {
          await markSchedulerRunManagerQueued(this.options.inventoryDb, run.id, managerId, id);
          queued.push(managerId);
          recordAudit(this.options.db, {
            actor: "scheduler",
            action: "scheduler.manager_queued",
            resourceType: "manager",
            resourceId: managerId,
            metadata: { jobType, jobId: id, runId: run.id }
          });
        } else {
          completedRun =
            (await completeSchedulerRunManager(
              this.options.inventoryDb,
              run.id,
              managerId,
              "skipped",
              "A matching scheduler job is already active"
            )) ?? completedRun;
        }
      } catch (error) {
        completedRun =
          (await completeSchedulerRunManager(this.options.inventoryDb, run.id, managerId, "failed", errorMessage(error))) ?? completedRun;
      }
    }
    await this.completeScheduleRun(jobType, completedRun);

    recordAudit(this.options.db, {
      actor: "scheduler",
      action: "scheduler.dispatch_completed",
      metadata: { jobType, runId: run.id, managers: managerIds.length, queuedManagers: queued.length, intervalMinutes: schedule.intervalMinutes }
    });
  }

  private async createQueues(): Promise<void> {
    await this.queue.createQueue(deadLetterQueue, {
      retentionSeconds: 30 * 24 * 60 * 60,
      deleteAfterSeconds: 30 * 24 * 60 * 60
    });
    await this.queue.createQueue(inventoryDispatchQueue, managerQueueOptions);
    await this.queue.createQueue(metricsDispatchQueue, managerQueueOptions);
    await this.queue.createQueue(inventoryManagerQueue, managerQueueDefinition);
    await this.queue.createQueue(metricsManagerQueue, managerQueueDefinition);
    await this.queue.updateQueue(inventoryManagerQueue, managerQueueOptions);
    await this.queue.updateQueue(metricsManagerQueue, managerQueueOptions);
  }

  private async registerWorkers(): Promise<void> {
    await this.queue.work(inventoryDispatchQueue, dispatcherWorkOptions, async (jobs) =>
      Promise.all(jobs.map((job) => this.runDispatcherJob(job, "inventory")))
    );
    await this.queue.work(metricsDispatchQueue, dispatcherWorkOptions, async (jobs) =>
      Promise.all(jobs.map((job) => this.runDispatcherJob(job, "metrics")))
    );
    await this.queue.work(inventoryManagerQueue, this.managerWorkOptions, async (jobs) =>
      Promise.all(jobs.map((job) => this.runInventoryManagerJob(job as unknown as QueueJob<ManagerJobData>)))
    );
    await this.queue.work(metricsManagerQueue, this.managerWorkOptions, async (jobs) =>
      Promise.all(jobs.map((job) => this.runMetricsManagerJob(job as unknown as QueueJob<ManagerJobData>)))
    );
  }

  private get managerWorkOptions(): WorkOptions {
    return {
      localConcurrency: this.options.config.scheduler.workerConcurrency,
      includeMetadata: true,
      perJobResults: true,
      heartbeatRefreshSeconds: 15
    };
  }

  private async runDispatcherJob(job: QueueJob, jobType: ScheduledJobType): Promise<QueueJobResult> {
    try {
      await this.dispatchDue(jobType);
      return { id: job.id, status: "completed" };
    } catch (error) {
      this.lastError = errorMessage(error);
      return { id: job.id, status: "failed", output: { message: this.lastError } };
    }
  }

  private async runInventoryManagerJob(job: QueueJob<ManagerJobData>): Promise<QueueJobResult> {
    const { managerId, runId } = job.data;
    if (!runId) {
      this.recordLegacyJobDiscarded("inventory", managerId, job.id);
      return skippedFailureQueueResult(job.id, "Scheduled job is missing its dispatch run and was skipped");
    }
    if (!(await this.startManagerRun("inventory", runId, managerId))) {
      return { id: job.id, status: "completed", output: { skipped: true } };
    }
    try {
      const snapshot = await collectManagerSnapshotById(this.options.db, this.options.config, managerId, this.options.inventoryDb);
      const errorSummary = snapshot.errors.map((issue) => issue.message).join("; ") || undefined;
      await this.completeManagerRun("inventory", runId, managerId, snapshot.status, errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "collection.scheduled_manager_completed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
      });

      if (snapshot.status === "failed") {
        return skippedFailureQueueResult(job.id, errorSummary ?? "Scheduled inventory collection failed");
      }
      return { id: job.id, status: "completed", output: { snapshotId: snapshot.id, status: snapshot.status } };
    } catch (error) {
      const message = errorMessage(error);
      await this.completeManagerRun("inventory", runId, managerId, "failed", message);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "collection.scheduled_manager_failed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { message }
      });
      return skippedFailureQueueResult(job.id, message);
    }
  }

  private async runMetricsManagerJob(job: QueueJob<ManagerJobData>): Promise<QueueJobResult> {
    const { managerId, runId } = job.data;
    if (!runId) {
      this.recordLegacyJobDiscarded("metrics", managerId, job.id);
      return skippedFailureQueueResult(job.id, "Scheduled job is missing its dispatch run and was skipped");
    }
    if (!(await this.startManagerRun("metrics", runId, managerId))) {
      return { id: job.id, status: "completed", output: { skipped: true } };
    }
    try {
      const result = await collectManagerMetricsById(this.options.db, this.options.config, managerId, this.options.inventoryDb);
      const errorSummary = result.errors.map((issue) => issue.message).join("; ") || undefined;
      const status: ScheduleResult = result.errors.length === 0 ? "success" : result.sampleCount > 0 ? "partial" : "failed";
      await this.completeManagerRun("metrics", runId, managerId, status, errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "metrics.scheduled_manager_completed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { status, samples: result.sampleCount, warnings: result.warnings.length, errors: result.errors.length }
      });

      if (status === "failed") {
        return skippedFailureQueueResult(job.id, errorSummary ?? "Scheduled metrics collection failed");
      }
      return { id: job.id, status: "completed", output: { status, samples: result.sampleCount } };
    } catch (error) {
      const message = errorMessage(error);
      await this.completeManagerRun("metrics", runId, managerId, "failed", message);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "metrics.scheduled_manager_failed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { message }
      });
      return skippedFailureQueueResult(job.id, message);
    }
  }

  private async startManagerRun(jobType: ScheduledJobType, runId: string | undefined, managerId: string): Promise<boolean> {
    if (runId) {
      return markSchedulerRunManagerStarted(this.options.inventoryDb, runId, managerId);
    }
    await markScheduleStarted(this.options.inventoryDb, jobType);
    return true;
  }

  private async completeManagerRun(
    jobType: ScheduledJobType,
    runId: string | undefined,
    managerId: string,
    status: ScheduleResult,
    errorSummary?: string
  ): Promise<void> {
    if (!runId) {
      await markScheduleCompleted(this.options.inventoryDb, jobType, status, errorSummary);
      return;
    }
    await this.completeScheduleRun(jobType, await completeSchedulerRunManager(this.options.inventoryDb, runId, managerId, status, errorSummary));
  }

  private async completeScheduleRun(jobType: ScheduledJobType, run: SchedulerDispatchRun | undefined): Promise<void> {
    if (run && run.status !== "queued" && run.status !== "running") {
      await markScheduleCompleted(this.options.inventoryDb, jobType, run.status, run.errorSummary);
    }
  }

  private async recoverStaleRuns(): Promise<void> {
    const now = new Date();
    const staleJobs = await listStaleSchedulerRunJobs(this.options.inventoryDb, now, staleRunAfterMs);
    for (const job of staleJobs) {
      if (!job.queueJobId) {
        continue;
      }
      const queueName = job.jobType === "inventory" ? inventoryManagerQueue : metricsManagerQueue;
      try {
        await this.queue.cancel(queueName, job.queueJobId);
      } catch (error) {
        recordAudit(this.options.db, {
          actor: "scheduler",
          action: "scheduler.stale_job_cancel_failed",
          resourceType: "manager",
          resourceId: job.managerId,
          metadata: { jobType: job.jobType, jobId: job.queueJobId, message: errorMessage(error) }
        });
      }
    }
    const recovered = await recoverStaleSchedulerRuns(this.options.inventoryDb, now, staleRunAfterMs);
    for (const run of recovered) {
      if (run.status !== "success" && run.status !== "partial" && run.status !== "failed") {
        continue;
      }
      await markScheduleCompleted(this.options.inventoryDb, run.jobType, run.status, run.errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "scheduler.stale_run_skipped",
        resourceType: "scheduler_dispatch_run",
        resourceId: run.id,
        metadata: { jobType: run.jobType, status: run.status, completedManagers: run.completedManagerCount }
      });
    }
  }

  private recordLegacyJobDiscarded(jobType: ScheduledJobType, managerId: string, jobId: string): void {
    recordAudit(this.options.db, {
      actor: "scheduler",
      action: "scheduler.legacy_job_skipped",
      resourceType: "manager",
      resourceId: managerId,
      metadata: { jobType, jobId, reason: "missing_dispatch_run" }
    });
  }
}

const dispatcherWorkOptions: WorkOptions = { localConcurrency: 1, perJobResults: true };

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

function managerSendOptions(jobType: ScheduledJobType, managerId: string): SendOptions {
  return {
    ...managerQueueOptions,
    singletonKey: `${jobType}:${managerId}`,
    deadLetter: deadLetterQueue
  };
}

function skippedFailureQueueResult(id: string, message: string): QueueJobResult {
  return { id, status: "deadletter", output: { message, skippedUntilNextSchedule: true } };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Scheduled job failed";
}

function createPgBossQueue(config: AppConfig): DurableJobQueue {
  if (!config.postgres.databaseUrl) {
    throw new Error("OVIRT_INVENTORY_DATABASE_URL is required for durable scheduling");
  }

  const boss = new PgBoss({
    connectionString: config.postgres.databaseUrl,
    ssl: config.postgres.ssl ? { rejectUnauthorized: true } : undefined,
    schema: "pgboss",
    supervise: true,
    migrate: true,
    createSchema: true
  });

  return {
    async start() {
      await boss.start();
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 30_000, close: true });
    },
    async createQueue(name, options) {
      await boss.createQueue(name, options as Omit<Queue, "name"> | undefined);
    },
    async updateQueue(name, options) {
      await boss.updateQueue(name, options as Omit<Queue, "name"> | undefined);
    },
    async cancel(name, id) {
      await boss.cancel(name, id);
    },
    async schedule(name, cron) {
      await boss.schedule(name, cron);
    },
    async work(name, options, handler) {
      await boss.work<Record<string, unknown>>(name, options as WorkOptions, async (jobs) =>
        handler(
          jobs.map((job) => {
            const metadata = job as { retryCount?: unknown; retryLimit?: unknown };
            return {
              id: job.id,
              data: job.data,
              ...(typeof metadata.retryCount === "number" ? { retryCount: metadata.retryCount } : {}),
              ...(typeof metadata.retryLimit === "number" ? { retryLimit: metadata.retryLimit } : {})
            };
          })
        )
      );
    },
    async send(name, data, options) {
      return boss.send(name, data, options as SendOptions | undefined);
    },
    onError(handler) {
      boss.on("error", handler);
    }
  };
}
