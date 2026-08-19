import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listAuditLogs } from "./audit.js";
import { registerAuthRoutes } from "./auth.js";
import { registerCapacityRoutes } from "./capacity.js";
import { registerCollectionRunRoutes } from "./collection-runs.js";
import { registerCollectionRoutes } from "./collection.js";
import type { AppConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerDiagnosticRoutes } from "./diagnostics.js";
import { databaseHealth, type SqliteDatabase } from "./db.js";
import { createDurableScheduler, schedulerAvailable, type DurableScheduler } from "./durable-scheduler.js";
import { registerExceptionRoutes } from "./exceptions.js";
import { registerExcelRoutes } from "./excel.js";
import { registerInventoryRoutes } from "./inventory.js";
import { registerManagerRoutes } from "./managers.js";
import { registerMetricRoutes } from "./metrics.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { getSchedulerReconcilerState, listScheduleStates } from "./scheduler-state.js";
import { requireRole, roles } from "./rbac.js";
import { registerSavedViewRoutes } from "./saved-views.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerSnapshotInventoryRoutes } from "./snapshot-inventory.js";
import { registerSnapshotRoutes } from "./snapshots.js";

export interface BuildAppOptions {
  db: SqliteDatabase;
  config: AppConfig;
  inventoryDb?: ConnectablePostgres;
}

export function buildApp({ db, config, inventoryDb }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate("sqlite", db);
  let scheduler: DurableScheduler | undefined;

  app.get("/api/health", async () => ({
    ok: true,
    service: "ovirt-inventory",
    database: databaseHealth(db),
    scheduler: scheduler?.status ?? {
      backend: "postgres-reconciler" as const,
      available: schedulerAvailable(config, inventoryDb),
      running: false
    }
  }));

  registerAuthRoutes(app, db, config.auth);
  registerManagerRoutes(app, db, config);
  registerCollectionRoutes(app, db, config, inventoryDb);
  registerCollectionRunRoutes(app, inventoryDb);
  registerSnapshotRoutes(app, db);
  registerDashboardRoutes(app, db);
  registerDiagnosticRoutes(app, db);
  registerExcelRoutes(app, db);
  registerInventoryRoutes(app, inventoryDb);
  registerSnapshotInventoryRoutes(app, db);
  registerMetricRoutes(app, db, config, inventoryDb);
  registerCapacityRoutes(app, config, inventoryDb);
  registerExceptionRoutes(app, inventoryDb);
  registerSavedViewRoutes(app, db);
  app.get("/api/audit-logs", { preHandler: requireRole(roles.admin) }, async () => ({ auditLogs: listAuditLogs(db) }));
  app.get("/api/scheduler", { preHandler: requireRole(roles.admin) }, async (_request, reply) => {
    if (!inventoryDb) {
      return reply.code(503).send({ error: "PostgreSQL scheduling is not configured" });
    }
    const reconcilerState = await getSchedulerReconcilerState(inventoryDb);
    const schedulerStatus = scheduler?.status ?? {
      backend: "postgres-reconciler" as const,
      available: schedulerAvailable(config, inventoryDb),
      running: false
    };
    return {
      scheduler: {
        ...schedulerStatus,
        ...(schedulerStatus.lastError ? {} : reconcilerState?.lastErrorSummary ? { lastError: reconcilerState.lastErrorSummary } : {}),
        ...(schedulerStatus.lastErrorAt ? {} : reconcilerState?.lastErrorAt ? { lastErrorAt: reconcilerState.lastErrorAt } : {}),
        ...(schedulerStatus.lastPolledAt ? {} : reconcilerState?.lastPolledAt ? { lastPolledAt: reconcilerState.lastPolledAt } : {}),
        ...(schedulerStatus.lastSuccessfulPollAt
          ? {}
          : reconcilerState?.lastSuccessfulPollAt
            ? { lastSuccessfulPollAt: reconcilerState.lastSuccessfulPollAt }
            : {})
      },
      schedules: await listScheduleStates(inventoryDb)
    };
  });
  registerSettingsRoutes(app, db, config, async (settings) => {
    await scheduler?.syncSettings(settings);
  });
  app.addHook("onReady", async () => {
    if (!schedulerAvailable(config, inventoryDb) || !inventoryDb) {
      return;
    }
    scheduler = createDurableScheduler({ db, config, inventoryDb });
    try {
      await scheduler.start();
    } catch (error) {
      app.log.error(error, "durable scheduler could not start");
    }
  });
  app.addHook("onClose", async () => {
    await scheduler?.stop();
  });

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const frontendDist = [join(process.cwd(), "dist", "frontend"), join(currentDir, "..", "..", "frontend")].find(
    (path) => existsSync(path)
  );
  if (frontendDist) {
    app.register(fastifyStatic, {
      root: frontendDist,
      prefix: "/"
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      await reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
