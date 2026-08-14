import { PgBoss, type Queue, type QueueOptions, type SendOptions, type WorkOptions } from "pg-boss";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import { collectManagerSnapshotById } from "./collection.js";
import type { SqliteDatabase } from "./db.js";
import { collectManagerMetricsById, metricsStorageEnabled } from "./metrics-collection.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
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

const managerQueueOptions: QueueOptions = {
  expireInSeconds: 900,
  retentionSeconds: 14 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 15 * 60,
  heartbeatSeconds: 30
};

const managerQueueDefinition: Omit<Queue, "name"> = {
  ...managerQueueOptions,
  policy: "key_strict_fifo"
};

export interface QueueJob<T extends object = object> {
  id: string;
  data: T;
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
  schedule(name: string, cron: string): Promise<void>;
  work(name: string, options: object, handler: (jobs: QueueJob[]) => Promise<QueueJobResult[]>): Promise<void>;
  send(name: string, data: object, options?: object): Promise<string | null>;
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
}

interface DurableSchedulerOptions {
  db: SqliteDatabase;
  config: AppConfig;
  inventoryDb: ConnectablePostgres;
  queue?: DurableJobQueue;
}

interface ManagerJobData {
  managerId: string;
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

  constructor(private readonly options: DurableSchedulerOptions) {
    this.queue = options.queue ?? createPgBossQueue(options.config);
  }

  get status(): DurableSchedulerStatus {
    return {
      backend: "pg-boss",
      available: true,
      running: this.running,
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      await this.queue.start();
      await this.createQueues();
      await this.registerWorkers();
      await this.queue.schedule(inventoryDispatchQueue, dispatchCron);
      await this.queue.schedule(metricsDispatchQueue, dispatchCron);
      await this.syncSettings();
      this.running = true;
      this.lastError = undefined;
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
    const schedule = await claimDueSchedule(this.options.inventoryDb, jobType);
    if (!schedule) {
      return;
    }

    const managerIds = listEnabledManagerIds(this.options.db);
    const queueName = jobType === "inventory" ? inventoryManagerQueue : metricsManagerQueue;
    const queued: string[] = [];
    for (const managerId of managerIds) {
      const id = await this.queue.send(queueName, { managerId }, managerSendOptions(jobType, managerId));
      if (id) {
        queued.push(managerId);
        recordAudit(this.options.db, {
          actor: "scheduler",
          action: "scheduler.manager_queued",
          resourceType: "manager",
          resourceId: managerId,
          metadata: { jobType, jobId: id }
        });
      }
    }

    recordAudit(this.options.db, {
      actor: "scheduler",
      action: "scheduler.dispatch_completed",
      metadata: { jobType, managers: managerIds.length, queuedManagers: queued.length, intervalMinutes: schedule.intervalMinutes }
    });

    if (managerIds.length === 0) {
      await markScheduleCompleted(this.options.inventoryDb, jobType, "success");
    }
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
    const { managerId } = job.data;
    await markScheduleStarted(this.options.inventoryDb, "inventory");
    try {
      const snapshot = await collectManagerSnapshotById(this.options.db, this.options.config, managerId, this.options.inventoryDb);
      const errorSummary = snapshot.errors.map((issue) => issue.message).join("; ") || undefined;
      await markScheduleCompleted(this.options.inventoryDb, "inventory", snapshot.status, errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "collection.scheduled_manager_completed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { snapshotId: snapshot.id, status: snapshot.status, warnings: snapshot.warningsCount, errors: snapshot.errorsCount }
      });

      if (snapshot.status === "failed") {
        return failedQueueResult(job.id, errorSummary ?? "Scheduled inventory collection failed");
      }
      return { id: job.id, status: "completed", output: { snapshotId: snapshot.id, status: snapshot.status } };
    } catch (error) {
      const message = errorMessage(error);
      await markScheduleCompleted(this.options.inventoryDb, "inventory", "failed", message);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "collection.scheduled_manager_failed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { message }
      });
      return failedQueueResult(job.id, message);
    }
  }

  private async runMetricsManagerJob(job: QueueJob<ManagerJobData>): Promise<QueueJobResult> {
    const { managerId } = job.data;
    await markScheduleStarted(this.options.inventoryDb, "metrics");
    try {
      const result = await collectManagerMetricsById(this.options.db, this.options.config, managerId, this.options.inventoryDb);
      const errorSummary = result.errors.map((issue) => issue.message).join("; ") || undefined;
      const status: ScheduleResult = result.errors.length === 0 ? "success" : result.sampleCount > 0 ? "partial" : "failed";
      await markScheduleCompleted(this.options.inventoryDb, "metrics", status, errorSummary);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "metrics.scheduled_manager_completed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { status, samples: result.sampleCount, warnings: result.warnings.length, errors: result.errors.length }
      });

      if (status === "failed") {
        return failedQueueResult(job.id, errorSummary ?? "Scheduled metrics collection failed");
      }
      return { id: job.id, status: "completed", output: { status, samples: result.sampleCount } };
    } catch (error) {
      const message = errorMessage(error);
      await markScheduleCompleted(this.options.inventoryDb, "metrics", "failed", message);
      recordAudit(this.options.db, {
        actor: "scheduler",
        action: "metrics.scheduled_manager_failed",
        resourceType: "manager",
        resourceId: managerId,
        metadata: { message }
      });
      return failedQueueResult(job.id, message);
    }
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

function failedQueueResult(id: string, message: string): QueueJobResult {
  return { id, status: isPermanentFailure(message) ? "deadletter" : "failed", output: { message } };
}

function isPermanentFailure(message: string): boolean {
  return /credential|decrypt|manager not found|manager is disabled|invalid credentials|unauthori[sz]ed|forbidden|malformed manager url/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Scheduled job failed";
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
    async schedule(name, cron) {
      await boss.schedule(name, cron);
    },
    async work(name, options, handler) {
      await boss.work<Record<string, unknown>>(name, options as WorkOptions, async (jobs) =>
        handler(jobs.map((job) => ({ id: job.id, data: job.data })))
      );
    },
    async send(name, data, options) {
      return boss.send(name, data, options as SendOptions | undefined);
    }
  };
}
