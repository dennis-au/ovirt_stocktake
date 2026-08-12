import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { AuthConfig } from "./config.js";
import { recordAudit } from "./audit.js";
import type { SqliteDatabase } from "./db.js";
import type { AppRole } from "./rbac.js";
import { verifyPassword } from "./security.js";

const SESSION_COOKIE = "ovirt_inventory_session";

export interface CurrentSession {
  username: string;
  role: AppRole;
  expiresAt: string;
}

export function authConfigured(config: AuthConfig): boolean {
  return Boolean(config.sessionSecret && config.adminPasswordHash);
}

export function registerAuthRoutes(app: FastifyInstance, db: SqliteDatabase, config: AuthConfig): void {
  app.register(fastifyCookie, {
    secret: config.sessionSecret ?? randomBytes(32).toString("base64url")
  });

  app.post("/api/login", async (request, reply) => {
    if (!authConfigured(config)) {
      return reply.code(503).send({ error: "Authentication is not configured" });
    }

    const body = parseLoginBody(request.body);
    if (!body) {
      return reply.code(400).send({ error: "Username and password are required" });
    }

    const usernameMatches = body.username === config.adminUsername;
    const passwordMatches = await verifyPassword(body.password, config.adminPasswordHash!);
    if (!usernameMatches || !passwordMatches) {
      recordAudit(db, {
        actor: body.username,
        action: "auth.login_failed",
        metadata: { reason: "invalid_credentials" }
      });
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const session = createSession(db, config.adminUsername, config.adminRole, config.sessionTtlHours);
    setSessionCookie(reply, session.token, config);
    recordAudit(db, {
      actor: config.adminUsername,
      action: "auth.login_success",
      metadata: { role: config.adminRole }
    });
    return { authenticated: true, user: { username: config.adminUsername, role: config.adminRole }, expiresAt: session.expiresAt };
  });

  app.post("/api/logout", async (request, reply) => {
    const token = readSessionToken(request);
    const session = token ? currentSession(db, request) : undefined;
    if (token) {
      deleteSession(db, token);
    }
    clearSessionCookie(reply, config);
    if (session) {
      recordAudit(db, {
        actor: session.username,
        action: "auth.logout",
        metadata: { role: session.role }
      });
    }
    return { authenticated: false };
  });

  app.get("/api/session", async (request) => {
    const session = currentSession(db, request);
    if (!session) {
      return { authenticated: false };
    }
    return { authenticated: true, user: { username: session.username, role: session.role }, expiresAt: session.expiresAt };
  });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!currentSession(request.server.sqlite, request)) {
    await reply.code(401).send({ error: "Authentication required" });
  }
}

export function currentSession(db: SqliteDatabase, request: FastifyRequest): CurrentSession | undefined {
  const token = readSessionToken(request);
  if (!token) {
    return undefined;
  }

  const session = db
    .prepare("SELECT username, role, expires_at AS expiresAt FROM app_sessions WHERE id_hash = ? AND expires_at > ?")
    .get(hashToken(token), new Date().toISOString()) as (Omit<CurrentSession, "role"> & { role: string }) | undefined;

  return session ? { ...session, role: roleFromDatabase(session.role) } : undefined;
}

function createSession(db: SqliteDatabase, username: string, role: AppRole, ttlHours: number): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO app_sessions (id_hash, username, role, expires_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    username,
    role,
    expiresAt
  );
  return { token, expiresAt };
}

function deleteSession(db: SqliteDatabase, token: string): void {
  db.prepare("DELETE FROM app_sessions WHERE id_hash = ?").run(hashToken(token));
}

function readSessionToken(request: FastifyRequest): string | undefined {
  const signed = request.cookies?.[SESSION_COOKIE];
  if (!signed) {
    return undefined;
  }

  const result = request.unsignCookie(signed);
  return result.valid ? result.value : undefined;
}

function setSessionCookie(reply: FastifyReply, token: string, config: AuthConfig): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies,
    signed: true,
    maxAge: config.sessionTtlHours * 60 * 60
  });
}

function clearSessionCookie(reply: FastifyReply, config: AuthConfig): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: config.secureCookies
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function parseLoginBody(body: unknown): { username: string; password: string } | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const value = body as Record<string, unknown>;
  if (typeof value.username !== "string" || typeof value.password !== "string") {
    return undefined;
  }

  const username = value.username.trim();
  if (!username || !value.password) {
    return undefined;
  }

  return { username, password: value.password };
}

function roleFromDatabase(value: string): AppRole {
  if (value === "operator" || value === "viewer") {
    return value;
  }
  return "admin";
}
