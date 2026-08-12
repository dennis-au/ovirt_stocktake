import type { FastifyInstance } from "fastify";
import { queryVmMetricSummary } from "./postgres/metrics.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";

export function registerMetricRoutes(app: FastifyInstance, inventoryDb?: ConnectablePostgres): void {
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
}

function parseWindowHours(query: unknown): number {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>).windowHours : undefined;
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : undefined;
  return value && value > 0 ? Math.min(value, 24 * 90) : 24;
}
