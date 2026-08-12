import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { hashPassword } from "../server/security.js";
import { emptyInventoryResources, type SnapshotPayload } from "../shared/snapshot.js";
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
  const app = buildApp({
    db: memoryDatabase(),
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
  const createManager = await app.inject({
    method: "POST",
    url: "/api/managers",
    cookies: { [cookie.name]: cookie.value },
    payload: {
      name: "Lab",
      url: "https://lab111/ovirt-engine",
      username: "test-user",
      password: "manager-password"
    }
  });
  return {
    app,
    cookie: { [cookie.name]: cookie.value },
    managerId: createManager.json().manager.id as string
  };
}

function snapshot(managerId: string, overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    managerId,
    managerName: "Lab",
    managerUrl: "https://lab111/ovirt-engine",
    collectedAt: "2026-08-11T09:00:00.000Z",
    apiVersion: "4.5",
    durationMs: 123,
    status: "success",
    resources: {
      ...emptyInventoryResources(),
      clusters: [{ id: "cluster-1", name: "Default" }],
      hosts: [{ id: "host-1", name: "host-1", status: "up" }],
      vms: [{ id: "vm-1", name: "vm-1", status: "up" }],
    },
    warnings: [],
    errors: [],
    ...overrides
  };
}

describe("snapshot persistence and history", () => {
  it("saves, lists, details, and returns the latest successful snapshot", async () => {
    const { app, cookie, managerId } = await authenticatedApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(managerId)
    });
    expect(create.statusCode).toBe(201);
    const saved = create.json().snapshot as { id: string; resourceCounts: { vms: number } };
    expect(saved.resourceCounts.vms).toBe(1);

    const list = await app.inject({ method: "GET", url: "/api/snapshots", cookies: cookie });
    expect(list.statusCode).toBe(200);
    expect(list.json().snapshots).toHaveLength(1);

    const detail = await app.inject({ method: "GET", url: `/api/snapshots/${saved.id}`, cookies: cookie });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().snapshot.resources.vms[0]).toMatchObject({ name: "vm-1" });

    const latest = await app.inject({ method: "GET", url: "/api/snapshots/latest", cookies: cookie });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().snapshot.id).toBe(saved.id);
    await app.close();
  });

  it("keeps prior successful history when a later collection fails", async () => {
    const { app, cookie, managerId } = await authenticatedApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(managerId, { collectedAt: "2026-08-11T09:00:00.000Z" })
    });
    const failed = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(managerId, {
        collectedAt: "2026-08-11T10:00:00.000Z",
        status: "failed",
        resources: emptyInventoryResources(),
        errors: [{ message: "Network or TLS failure while contacting oVirt Manager" }]
      })
    });

    expect(first.statusCode).toBe(201);
    expect(failed.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/api/snapshots?managerId=${managerId}`, cookies: cookie });
    expect(list.json().snapshots.map((item: { status: string }) => item.status)).toEqual(["failed", "success"]);

    const latest = await app.inject({ method: "GET", url: `/api/snapshots/latest?managerId=${managerId}`, cookies: cookie });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().snapshot.status).toBe("success");
    await app.close();
  });

  it("rejects malformed snapshots and accidental secrets", async () => {
    const { app, cookie, managerId } = await authenticatedApp();

    const missingResources = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: { ...snapshot(managerId), resources: { clusters: [] } }
    });
    expect(missingResources.statusCode).toBe(400);

    const secretPayload = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: {
        ...snapshot(managerId),
        resources: {
          ...emptyInventoryResources(),
          ...snapshot(managerId).resources,
          vms: [{ id: "vm-1", password: "must-not-save" }]
        }
      }
    });
    expect(secretPayload.statusCode).toBe(400);
    expect(secretPayload.json()).toEqual({ error: "Snapshot must not contain credentials or authorization data" });
    await app.close();
  });
});
