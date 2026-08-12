import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { hashPassword, verifyPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const databases: SqliteDatabase[] = [];

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length) {
    databases.pop()?.close();
  }
});

describe("password hashing", () => {
  it("verifies only the original password", async () => {
    const hash = await hashPassword("correct horse battery staple", Buffer.from("0123456789abcdef"));

    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
    expect(hash).not.toContain("correct horse battery staple");
  });
});

describe("app login and sessions", () => {
  it("rejects protected app data without a session", async () => {
    const app = buildApp({ db: memoryDatabase(), config: testConfig() });

    const response = await app.inject({ method: "GET", url: "/api/managers" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required" });
    await app.close();
  });

  it("logs in, keeps a reload session, and logs out", async () => {
    const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
    const app = buildApp({
      db: memoryDatabase(),
      config: testConfig({
        auth: {
          adminUsername: "admin",
          adminPasswordHash: passwordHash,
          sessionSecret: "test-session-secret-with-enough-length",
          sessionTtlHours: 12,
          secureCookies: false
        }
      })
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "inventory admin" }
    });
    const cookie = login.cookies[0];

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ authenticated: true, user: { username: "admin" } });
    expect(cookie.name).toBe("ovirt_inventory_session");
    expect(cookie.httpOnly).toBe(true);

    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      cookies: { [cookie.name]: cookie.value }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, user: { username: "admin" } });

    const managers = await app.inject({
      method: "GET",
      url: "/api/managers",
      cookies: { [cookie.name]: cookie.value }
    });
    expect(managers.statusCode).toBe(200);
    expect(managers.json()).toEqual({ managers: [] });

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      cookies: { [cookie.name]: cookie.value }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ authenticated: false });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/managers",
      cookies: { [cookie.name]: cookie.value }
    });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });

  it("does not allow login until auth secrets are configured", async () => {
    const app = buildApp({ db: memoryDatabase(), config: testConfig() });

    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "admin", password: "anything" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Authentication is not configured" });
    await app.close();
  });
});
