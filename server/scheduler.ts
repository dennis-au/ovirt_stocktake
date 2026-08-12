import type { FastifyInstance } from "fastify";
import { recordAudit } from "./audit.js";
import { collectEnabledManagers } from "./collection.js";
import type { AppConfig } from "./config.js";
import type { SqliteDatabase } from "./db.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";

export interface CollectionScheduler {
  intervalMs: number;
  stop: () => void;
  triggerNow: () => Promise<void>;
}

export function startCollectionScheduler(
  app: FastifyInstance,
  db: SqliteDatabase,
  config: AppConfig,
  inventoryDb?: ConnectablePostgres
): CollectionScheduler | undefined {
  if (!config.collector.enabled) {
    return undefined;
  }

  const intervalMs = config.collector.inventorySyncMinutes * 60_000;
  let running = false;

  const triggerNow = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const snapshots = await collectEnabledManagers(db, config, inventoryDb);
      recordAudit(db, {
        actor: "scheduler",
        action: "collection.scheduled_completed",
        metadata: { managers: snapshots.length, intervalMinutes: config.collector.inventorySyncMinutes }
      });
    } catch (error) {
      recordAudit(db, {
        actor: "scheduler",
        action: "collection.scheduled_failed",
        metadata: { message: error instanceof Error ? error.message : "Scheduled collection failed" }
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
  app.addHook("onClose", async () => {
    stop();
  });

  return { intervalMs, stop, triggerNow };
}
