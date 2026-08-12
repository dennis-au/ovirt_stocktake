import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { recordAudit } from "../server/audit.js";
import { encryptSecret } from "../server/credentials.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { redactInventoryFields } from "../server/rbac.js";
import { hashPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const databases: SqliteDatabase[] = [];
const encryptionKey = "test-encryption-key-that-is-long-enough";

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length) {
    databases.pop()?.close();
  }
});

async function loginAs(role: "admin" | "operator" | "viewer") {
  const passwordHash = await hashPassword("inventory password", Buffer.from("0123456789abcdef"));
  const db = memoryDatabase();
  const app = buildApp({
    db,
    config: testConfig({
      credentialEncryptionKey: encryptionKey,
      auth: {
        adminUsername: role,
        adminPasswordHash: passwordHash,
        adminRole: role,
        sessionSecret: "test-session-secret-with-enough-length",
        sessionTtlHours: 12,
        secureCookies: false
      }
    })
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: role, password: "inventory password" }
  });
  const cookie = login.cookies[0];
  return { app, db, cookie: { [cookie.name]: cookie.value } };
}

function seedManager(db: SqliteDatabase): string {
  db.prepare(
    `INSERT INTO managers
      (id, name, url, enabled, username_ciphertext, password_ciphertext, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "manager-1",
    "Lab",
    "https://lab.example/ovirt-engine",
    1,
    encryptSecret("test-user", encryptionKey),
    encryptSecret("manager-password", encryptionKey),
    "2026-08-11T10:00:00.000Z",
    "2026-08-11T10:00:00.000Z"
  );
  return "manager-1";
}

describe("RBAC and audit", () => {
  it("allows viewers to read managers but denies manager writes and audits the denial", async () => {
    const { app, cookie } = await loginAs("viewer");

    const list = await app.inject({ method: "GET", url: "/api/managers", cookies: cookie });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: cookie,
      payload: {
        name: "Denied",
        url: "https://denied.example/ovirt-engine",
        username: "user",
        password: "password"
      }
    });
    expect(create.statusCode).toBe(403);

    const audit = await app.inject({ method: "GET", url: "/api/audit-logs", cookies: cookie });
    expect(audit.statusCode).toBe(403);
    expect(audit.body).not.toContain("password");
    await app.close();
  });

  it("allows operators to collect but not administer managers", async () => {
    const { app, db, cookie } = await loginAs("operator");
    const managerId = seedManager(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const parsed = new URL(String(input));
        if (parsed.pathname.endsWith("/sso/oauth/token")) {
          return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
        }
        return new Response(JSON.stringify({ cluster: [], host: [], vm: [], storage_domain: [], disk: [], network: [] }), { status: 200 });
      })
    );

    const collect = await app.inject({ method: "POST", url: `/api/managers/${managerId}/collect`, cookies: cookie });
    expect(collect.statusCode).toBe(200);

    const remove = await app.inject({ method: "DELETE", url: `/api/managers/${managerId}`, cookies: cookie });
    expect(remove.statusCode).toBe(403);
    await app.close();
  });

  it("records queryable admin audit logs without secrets", async () => {
    const { app, cookie } = await loginAs("admin");

    const create = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: cookie,
      payload: {
        name: "Lab",
        url: "https://lab.example/ovirt-engine",
        username: "test-user",
        password: "manager-password"
      }
    });
    expect(create.statusCode).toBe(201);

    const audit = await app.inject({ method: "GET", url: "/api/audit-logs", cookies: cookie });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toContain("auth.login_success");
    expect(audit.body).toContain("manager.created");
    expect(audit.body).not.toContain("manager-password");
    expect(audit.body).not.toContain("test-user");
    await app.close();
  });

  it("redacts RBAC-sensitive governance and cost fields", () => {
    const record = {
      name: "api-01",
      owner: "platform",
      costCenter: "FIN-001",
      monthlyEstimatedCost: 250,
      publicIp: "203.0.113.10",
      vulnerabilityCriticalCount: 3
    };

    expect(redactInventoryFields("admin", record)).toEqual(record);
    expect(redactInventoryFields("operator", record)).toEqual({ ...record, monthlyEstimatedCost: undefined });
    expect(redactInventoryFields("viewer", record)).toEqual({
      name: "api-01",
      owner: "platform",
      costCenter: undefined,
      monthlyEstimatedCost: undefined,
      publicIp: undefined,
      vulnerabilityCriticalCount: undefined
    });
  });

  it("sanitizes audit metadata before persistence", () => {
    const db = memoryDatabase();
    recordAudit(db, {
      actor: "admin",
      action: "test.secret_sanitized",
      metadata: {
        managerId: "manager-1",
        password: "manager-password",
        authorization: "Bearer token"
      }
    });

    const row = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = ?").get("test.secret_sanitized") as {
      metadata_json: string;
    };
    expect(row.metadata_json).toContain("manager-1");
    expect(row.metadata_json).not.toContain("manager-password");
    expect(row.metadata_json).not.toContain("Bearer token");
  });
});
