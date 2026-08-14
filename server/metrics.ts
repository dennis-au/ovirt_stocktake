import type { FastifyInstance } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { AppConfig } from "./config.js";
import type { SqliteDatabase } from "./db.js";
import { collectEnabledManagerMetrics, metricsStorageEnabled } from "./metrics-collection.js";
import { queryVmMetricSummary } from "./postgres/metrics.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";

export function registerMetricRoutes(app: FastifyInstance, db: SqliteDatabase, config: AppConfig, inventoryDb?: ConnectablePostgres): void {
  app.get("/api/metrics/vms/:managerId/:vmId", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    if (!inventoryDb) {
      return {
        metrics: {
          metricsAvailable: false,
          rightsizing: "unavailable",
          windowHours: parseWindowHours(request.query)
        }
      };
    }

    const params = request.params as { managerId?: string; vmId?: string };
    if (!params.managerId || !params.vmId) {
      return reply.code(404).send({ error: "VM metrics not found" });
    }
    return { metrics: await queryVmMetricSummary(inventoryDb, params.managerId, params.vmId, parseWindowHours(request.query)) };
  });

  app.post("/api/metrics/collect", { preHandler: requireRole(roles.operator) }, async (request, reply) => {
    if (!metricsStorageEnabled(config, inventoryDb)) {
      return reply.code(409).send({ error: "Capacity metrics are not configured" });
    }
    try {
      const results = await collectEnabledManagerMetrics(db, config, inventoryDb);
      recordAudit(db, {
        actor: currentSession(db, request)?.username,
        action: "metrics.collection.completed",
        metadata: {
          managers: results.length,
          samples: results.reduce((total, result) => total + result.sampleCount, 0),
          errors: results.reduce((total, result) => total + result.errors.length, 0)
        }
      });
      return { collection: { results } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capacity metrics collection failed";
      recordAudit(db, {
        actor: currentSession(db, request)?.username,
        action: "metrics.collection.failed",
        metadata: { message }
      });
      return reply.code(503).send({ error: message });
    }
  });
}

function parseWindowHours(query: unknown): number {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>).windowHours : undefined;
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : undefined;
  return value && value > 0 ? Math.min(value, 24 * 90) : 24;
}
