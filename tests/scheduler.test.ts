import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startCollectionScheduler } from "../server/scheduler.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
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

describe("collection scheduler", () => {
  it("stays disabled unless collector scheduling is enabled", async () => {
    const app = Fastify();
    const db = memoryDatabase();

    const scheduler = startCollectionScheduler(app, db, testConfig());

    expect(scheduler).toBeUndefined();
    await app.close();
  });

  it("runs scheduled collection through the backend collector path", async () => {
    const app = Fastify();
    const db = memoryDatabase();
    const scheduler = startCollectionScheduler(
      app,
      db,
      testConfig({
        credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
        collector: {
          enabled: true,
          inventorySyncMinutes: 15,
          extendedSyncMinutes: 60,
          eventSyncMinutes: 5,
          metricsSyncMinutes: 5,
          backupSyncMinutes: 60,
          fullSnapshotHour: 2
        }
      })
    );

    expect(scheduler?.intervalMs).toBe(900000);
    await scheduler?.triggerNow();
    const row = db.prepare("SELECT action FROM audit_logs WHERE actor = ?").get("scheduler") as { action: string };
    expect(row.action).toBe("collection.scheduled_completed");
    scheduler?.stop();
    await app.close();
  });
});
