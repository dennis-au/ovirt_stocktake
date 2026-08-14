import type { FastifyInstance } from "fastify";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { SqliteDatabase } from "./db.js";
import { collectEnabledManagerMetrics, metricsStorageEnabled } from "./metrics-collection.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";

export interface MetricsScheduler {
  intervalMs: number;
  stop: () => void;
  triggerNow: () => Promise<void>;
}

export function startMetricsScheduler(
  app: FastifyInstance,
  db: SqliteDatabase,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres,
  options: { registerCloseHook?: boolean } = {}
): MetricsScheduler | undefined {
  if (!config.collector.enabled || !metricsStorageEnabled(config, inventoryDb)) {
    return undefined;
  }

  const intervalMs = config.collector.metricsSyncMinutes * 60_000;
  let running = false;
  const triggerNow = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const results = await collectEnabledManagerMetrics(db, config, inventoryDb);
      recordAudit(db, {
        actor: "scheduler",
        action: "metrics.scheduled_completed",
        metadata: {
          managers: results.length,
          samples: results.reduce((total, result) => total + result.sampleCount, 0),
          errors: results.reduce((total, result) => total + result.errors.length, 0),
          intervalMinutes: config.collector.metricsSyncMinutes
        }
      });
    } catch (error) {
      recordAudit(db, {
        actor: "scheduler",
        action: "metrics.scheduled_failed",
        metadata: { message: error instanceof Error ? error.message : "Scheduled metrics collection failed" }
      });
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void triggerNow();
  }, intervalMs);
  handle.unref();

  const stop = (): void => {
    clearInterval(handle);
  };
  if (options.registerCloseHook ?? true) {
    app.addHook("onClose", async () => {
      stop();
    });
  }
  return { intervalMs, stop, triggerNow };
}
