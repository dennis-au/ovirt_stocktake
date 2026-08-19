import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { hashPassword } from "../server/security.js";
import { emptyInventoryResources, type SnapshotPayload } from "../shared/snapshot.js";
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

async function authenticatedApp(role: "admin" | "operator" = "admin") {
  const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
  const app = buildApp({
    db: memoryDatabase(),
    config: testConfig({
      credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
      auth: {
        adminUsername: "admin",
        adminRole: role,
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
  return { app, cookie: { [cookie.name]: cookie.value } };
}

async function createManager(app: ReturnType<typeof buildApp>, cookie: Record<string, string>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/managers",
    cookies: cookie,
    payload: {
      name: "private-manager-name",
      url: "https://private-manager.example/ovirt-engine",
      username: "private-user",
      password: "private-password"
    }
  });
  return response.json().manager.id as string;
}

function snapshot(managerId: string): SnapshotPayload {
  return {
    managerId,
    managerName: "private-manager-name",
    managerUrl: "https://private-manager.example/ovirt-engine",
    collectedAt: "2026-08-19T01:00:00.000Z",
    apiVersion: "4.6",
    durationMs: 150,
    status: "partial",
    resources: {
      ...emptyInventoryResources(),
      vmSnapshots: [
        { id: "snapshot-dated", name: "private-snapshot", date: "2026-08-10T01:00:00.000Z", vm: { id: "vm-1", name: "private-vm" } },
        { id: "snapshot-missing", description: "private-missing-date", creation_date: "2026-08-09T01:00:00.000Z", vm: { id: "vm-2", name: "private-vm-2" } },
        { id: "snapshot-invalid", description: "private-invalid-date", date: "not-a-date", vm: { id: "vm-3", name: "private-vm-3" } },
        { id: "snapshot-active", description: "Active VM", date: "2026-08-19T01:00:00.000Z", vm: { id: "vm-4", name: "private-vm-4" } }
      ]
    },
    warnings: [{ resource: "vmSnapshots", message: "private-vm-2 snapshot private-missing-date has no creation date" }],
    errors: [{ resource: "vmSnapshots", message: "private-vm-3 snapshot private-invalid-date detail collection failed: oVirt returned HTTP 500" }]
  };
}

describe("snapshot age diagnostics", () => {
  it("requires an administrator", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("does not expose diagnostics to operators", async () => {
    const { app, cookie } = await authenticatedApp("operator");

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age", cookies: cookie });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns redacted snapshot date evidence without raw inventory details", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie);
    const saved = await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload: snapshot(managerId) });

    expect(saved.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        reportVersion: 1,
        managerCount: 1,
        managers: [
          expect.objectContaining({
            label: "Manager 1",
            latestInventoryRun: expect.objectContaining({
              status: "partial",
              regularSnapshotCount: 3,
              validDateCount: 1,
              missingDateCount: 1,
              invalidDateCount: 1,
              snapshotDateIssueCounts: {
                noCreationDate: 1,
                detailCollectionFailed: 1,
                listCollectionFailed: 0,
                other: 0
              },
              observedTemporalFields: { creation_date: 1, date: 2 }
            })
          })
        ]
      }
    });
    expect(response.body).not.toContain("private-manager-name");
    expect(response.body).not.toContain("private-manager.example");
    expect(response.body).not.toContain("private-vm");
    expect(response.body).not.toContain("private-snapshot");
    expect(response.body).not.toContain("private-password");
    await app.close();
  });
});
