import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listAuditLogs } from "./audit.js";
import { registerAuthRoutes } from "./auth.js";
import { registerCollectionRunRoutes } from "./collection-runs.js";
import { registerCollectionRoutes } from "./collection.js";
import type { AppConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { databaseHealth, type SqliteDatabase } from "./db.js";
import { registerExceptionRoutes } from "./exceptions.js";
import { registerExcelRoutes } from "./excel.js";
import { registerInventoryRoutes } from "./inventory.js";
import { registerManagerRoutes } from "./managers.js";
import { registerMetricRoutes } from "./metrics.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";
import { registerSavedViewRoutes } from "./saved-views.js";
import { startCollectionScheduler } from "./scheduler.js";
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

  app.get("/api/health", async () => ({
    ok: true,
    service: "ovirt-inventory",
    database: databaseHealth(db)
  }));

  registerAuthRoutes(app, db, config.auth);
  registerManagerRoutes(app, db, config);
  registerCollectionRoutes(app, db, config, inventoryDb);
  registerCollectionRunRoutes(app, inventoryDb);
  registerSnapshotRoutes(app, db);
  registerDashboardRoutes(app, db);
  registerExcelRoutes(app, db);
  registerInventoryRoutes(app, inventoryDb);
  registerSnapshotInventoryRoutes(app, db);
  registerMetricRoutes(app, inventoryDb);
  registerExceptionRoutes(app, inventoryDb);
  registerSavedViewRoutes(app, db);
  app.get("/api/audit-logs", { preHandler: requireRole(roles.admin) }, async () => ({ auditLogs: listAuditLogs(db) }));
  startCollectionScheduler(app, db, config, inventoryDb);

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
