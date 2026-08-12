import type { FastifyReply, FastifyRequest } from "fastify";
import { currentSession } from "./auth.js";
import { recordAudit } from "./audit.js";
import type { InventoryResources } from "../shared/snapshot.js";
import { resourceKeys } from "../shared/snapshot.js";

export type AppRole = "admin" | "operator" | "viewer";

const readRoles: AppRole[] = ["admin", "operator", "viewer"];
const operatorRoles: AppRole[] = ["admin", "operator"];

const hiddenForOperator = ["monthlyEstimatedCost"];
const hiddenForViewer = ["costCenter", "monthlyEstimatedCost", "publicIp", "vulnerabilityCriticalCount"];

export const roles = {
  read: readRoles,
  operator: operatorRoles,
  admin: ["admin"] as AppRole[]
};

export function isAppRole(value: string): value is AppRole {
  return value === "admin" || value === "operator" || value === "viewer";
}

export function requireRole(allowedRoles: AppRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = currentSession(request.server.sqlite, request);
    if (!session) {
      await reply.code(401).send({ error: "Authentication required" });
      return;
    }

    if (!allowedRoles.includes(session.role)) {
      recordAudit(request.server.sqlite, {
        actor: session.username,
        action: "auth.authorization_denied",
        metadata: {
          method: request.method,
          url: request.url,
          role: session.role,
          allowedRoles
        }
      });
      await reply.code(403).send({ error: "Forbidden" });
    }
  };
}

export function redactInventoryFields<T extends Record<string, unknown>>(role: AppRole, record: T): T {
  if (role === "admin") {
    return record;
  }

  const hiddenFields = role === "operator" ? hiddenForOperator : hiddenForViewer;
  return {
    ...record,
    ...Object.fromEntries(hiddenFields.map((field) => [field, undefined]))
  } as T;
}

export function redactInventoryResources(role: AppRole, resources: InventoryResources): InventoryResources {
  return Object.fromEntries(
    resourceKeys.map((key) => [key, resources[key].map((record) => redactInventoryFields(role, record))])
  ) as InventoryResources;
}
