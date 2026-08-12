import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { encryptSecret } from "../server/credentials.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { normalizeManagerUrl } from "../server/managers.js";
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
  while (databases.length) {
    databases.pop()?.close();
  }
});

async function authenticatedApp() {
  const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
  const db = memoryDatabase();
  const app = buildApp({
    db,
    config: testConfig({
      credentialEncryptionKey: encryptionKey,
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
  return { app, db, cookie: { [cookie.name]: cookie.value } };
}

describe("manager URL normalization", () => {
  it("normalizes oVirt engine URLs and rejects query strings", () => {
    expect(normalizeManagerUrl("https://lab111/ovirt-engine/")).toBe("https://lab111/ovirt-engine");
    expect(normalizeManagerUrl("https://lab111/ovirt-engine/api")).toBe("https://lab111/ovirt-engine");
    expect(normalizeManagerUrl("ftp://lab111/ovirt-engine")).toBeUndefined();
    expect(normalizeManagerUrl("https://lab111/ovirt-engine?x=1")).toBeUndefined();
  });
});

describe("manager registry", () => {
  it("creates, lists, updates, redacts credentials, and deletes managers", async () => {
    const { app, db, cookie } = await authenticatedApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: cookie,
      payload: {
        name: "Lab Manager",
        url: "https://lab111/ovirt-engine/",
        ignoreTls: true,
        username: "test-user",
        password: "manager-password"
      }
    });
    expect(create.statusCode).toBe(201);
    const created = create.json().manager as { id: string; url: string; ignoreTls: boolean; credentialStatus: string; password?: string };
    expect(created.url).toBe("https://lab111/ovirt-engine");
    expect(created.ignoreTls).toBe(true);
    expect(created.credentialStatus).toBe("saved");
    expect(created.password).toBeUndefined();

    const stored = db
      .prepare("SELECT ignore_tls, username_ciphertext, password_ciphertext FROM managers WHERE id = ?")
      .get(created.id) as { ignore_tls: number; username_ciphertext: string; password_ciphertext: string };
    expect(stored.ignore_tls).toBe(1);
    expect(stored.username_ciphertext).not.toContain("test-user");
    expect(stored.password_ciphertext).not.toContain("manager-password");

    const list = await app.inject({ method: "GET", url: "/api/managers", cookies: cookie });
    expect(list.statusCode).toBe(200);
    expect(list.json().managers[0]).toMatchObject({ ignoreTls: true });
    expect(JSON.stringify(list.json())).not.toContain("manager-password");

    const update = await app.inject({
      method: "PATCH",
      url: `/api/managers/${created.id}`,
      cookies: cookie,
      payload: { name: "Lab Manager Updated", enabled: false, ignoreTls: false }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().manager).toMatchObject({ name: "Lab Manager Updated", enabled: false, ignoreTls: false });

    const credential = await app.inject({
      method: "POST",
      url: `/api/managers/${created.id}/collection-credential`,
      cookies: cookie
    });
    expect(credential.statusCode).toBe(404);
    expect(credential.body).not.toContain("test-user");
    expect(credential.body).not.toContain("manager-password");

    const remove = await app.inject({ method: "DELETE", url: `/api/managers/${created.id}`, cookies: cookie });
    expect(remove.statusCode).toBe(204);
    const afterDelete = await app.inject({ method: "GET", url: "/api/managers", cookies: cookie });
    expect(afterDelete.json()).toEqual({ managers: [] });
    await app.close();
  });

  it("refuses to save credentials without an encryption key", async () => {
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

    const create = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: { [cookie.name]: cookie.value },
      payload: { name: "Lab", url: "https://lab111/ovirt-engine", username: "admin", password: "secret" }
    });

    expect(create.statusCode).toBe(503);
    expect(create.json()).toEqual({ error: "OVIRT_INVENTORY_ENCRYPTION_KEY is required" });
    await app.close();
  });

  it("encrypts with authenticated encryption", () => {
    const payload = encryptSecret("sensitive", encryptionKey);

    expect(payload).toMatch(/^v1:/);
    expect(payload).not.toContain("sensitive");
  });
});
