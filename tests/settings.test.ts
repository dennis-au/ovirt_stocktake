import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { getAppSettings, pruneSnapshotsByRetention, saveAppSettings } from "../server/settings.js";
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

async function authenticatedApp(role: "admin" | "viewer" = "admin") {
  const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
  const db = memoryDatabase();
  const app = buildApp({
    db,
    config: testConfig({
      auth: {
        adminUsername: role,
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
    payload: { username: role, password: "inventory admin" }
  });
  const cookie = login.cookies[0];
  return { app, db, cookie: { [cookie.name]: cookie.value } };
}

function snapshot(managerId: string, collectedAt: string): SnapshotPayload {
  return {
    managerId,
    managerName: "lab",
    managerUrl: "https://lab.example/ovirt-engine",
    collectedAt,
    apiVersion: "4.8",
    durationMs: 10,
    status: "success",
    resources: emptyInventoryResources(),
    warnings: [],
    errors: []
  };
}

describe("application settings", () => {
  it("returns defaults from config and saves admin-managed misc settings", async () => {
    const { app, cookie } = await authenticatedApp();

    const initial = await app.inject({ method: "GET", url: "/api/settings", cookies: cookie });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      snapshotIntervalMinutes: 15,
      snapshotRetentionDays: 0,
      collectorEnabled: false
    });

    const update = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      cookies: cookie,
      payload: { snapshotIntervalMinutes: 30, snapshotRetentionDays: 90 }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().settings).toMatchObject({
      snapshotIntervalMinutes: 30,
      snapshotRetentionDays: 90
    });

    const stored = await app.inject({ method: "GET", url: "/api/settings", cookies: cookie });
    expect(stored.json().settings).toMatchObject({ snapshotIntervalMinutes: 30, snapshotRetentionDays: 90 });
    await app.close();
  });

  it("rejects invalid settings and requires admin access to update", async () => {
    const { app, cookie } = await authenticatedApp("viewer");

    const denied = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      cookies: cookie,
      payload: { snapshotIntervalMinutes: 30, snapshotRetentionDays: 90 }
    });
    expect(denied.statusCode).toBe(403);

    await app.close();

    const admin = await authenticatedApp();
    const invalid = await admin.app.inject({
      method: "PATCH",
      url: "/api/settings",
      cookies: admin.cookie,
      payload: { snapshotIntervalMinutes: 0, snapshotRetentionDays: -1 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Snapshot interval must be from 1 to 1440 minutes" });
    await admin.app.close();
  });

  it("stores settings in metadata and prunes snapshots older than retention", () => {
    const db = memoryDatabase();
    const config = testConfig({ collector: { ...testConfig().collector, inventorySyncMinutes: 45 } });
    expect(getAppSettings(db, config).snapshotIntervalMinutes).toBe(45);

    saveAppSettings(db, { snapshotIntervalMinutes: 20, snapshotRetentionDays: 7 });
    expect(getAppSettings(db, config)).toMatchObject({ snapshotIntervalMinutes: 20, snapshotRetentionDays: 7 });

    const oldSnapshot = snapshot("manager-1", "2026-08-01T00:00:00.000Z");
    const recentSnapshot = snapshot("manager-1", "2026-08-12T00:00:00.000Z");
    db.prepare("INSERT INTO managers (id, name, url, username_ciphertext, password_ciphertext) VALUES (?, ?, ?, ?, ?)").run(
      "manager-1",
      "lab",
      "https://lab.example/ovirt-engine",
      "user",
      "pass"
    );
    for (const item of [oldSnapshot, recentSnapshot]) {
      db.prepare(
        `INSERT INTO snapshots
          (id, manager_id, manager_name, manager_url, collected_at, api_version, duration_ms, status, resources_json, warnings_json, errors_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        item.collectedAt,
        item.managerId,
        item.managerName,
        item.managerUrl,
        item.collectedAt,
        item.apiVersion,
        item.durationMs,
        item.status,
        JSON.stringify(item.resources),
        JSON.stringify(item.warnings),
        JSON.stringify(item.errors)
      );
    }

    expect(pruneSnapshotsByRetention(db, 7, new Date("2026-08-13T00:00:00.000Z"))).toBe(1);
    const rows = db.prepare("SELECT collected_at FROM snapshots ORDER BY collected_at").all() as Array<{ collected_at: string }>;
    expect(rows.map((row) => row.collected_at)).toEqual(["2026-08-12T00:00:00.000Z"]);
  });
});
