import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { buildSnapshotWorkbook } from "../server/excel.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { hashPassword } from "../server/security.js";
import { emptyInventoryResources, resourceKeys, type SnapshotPayload } from "../shared/snapshot.js";
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
  return { app, cookie: { [cookie.name]: cookie.value } };
}

function snapshot(managerId: string, managerName: string): SnapshotPayload {
  return {
    managerId,
    managerName,
    managerUrl: `https://${managerName}.example/ovirt-engine`,
    collectedAt: "2026-08-11T09:00:00.000Z",
    apiVersion: "4.5",
    durationMs: 50,
    status: "success",
    resources: {
      ...emptyInventoryResources(),
      clusters: [{ id: "cluster-1", name: "Default" }],
      hosts: [{ id: "host-1", name: "host-1", status: "up" }],
      vms: [{ id: "vm-1", name: "vm-1", status: "down" }],
      storageDomains: [{ id: "sd-1", name: "data" }],
      disks: [{ id: "disk-1", name: "disk" }],
      networks: [{ id: "net-1", name: "ovirtmgmt" }]
    },
    warnings: [{ resource: "vms", message: "sample warning" }],
    errors: []
  };
}

function emptyResourceCounts(): Record<(typeof resourceKeys)[number], number> {
  return Object.fromEntries(resourceKeys.map((key) => [key, 0])) as Record<(typeof resourceKeys)[number], number>;
}

describe("Excel export", () => {
  it("builds workbook sheets without credentials", async () => {
    const workbook = buildSnapshotWorkbook({
      id: "snapshot-1",
      managerId: "manager-1",
      managerName: "Lab",
      managerUrl: "https://lab.example/ovirt-engine",
      collectedAt: "2026-08-11T09:00:00.000Z",
      apiVersion: "4.5",
      durationMs: 50,
      status: "success",
      resourceCounts: {
        ...emptyResourceCounts(),
        clusters: 1,
        hosts: 1,
        vms: 1,
        storageDomains: 1,
        disks: 1,
        networks: 1
      },
      warningsCount: 0,
      errorsCount: 0,
      createdAt: "2026-08-11T09:00:01.000Z",
      resources: {
        ...emptyInventoryResources(),
        clusters: [{ id: "cluster-1", name: "Default" }],
        hosts: [{ id: "host-1", name: "host-1", status: "up" }],
        vms: [{ id: "vm-1", name: "vm-1", status: "down" }],
        storageDomains: [{ id: "sd-1", name: "data" }],
        disks: [{ id: "disk-1", name: "disk" }],
        networks: [{ id: "net-1", name: "ovirtmgmt" }]
      },
      warnings: [],
      errors: []
    });

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "Managers",
      "Data Centers",
      "Clusters",
      "Hosts",
      "VMs",
      "Storage Domains",
      "Disks",
      "Networks",
      "vNIC Profiles",
      "Tags",
      "VM Snapshots",
      "Affinity Groups",
      "Events",
      "Warnings",
      "Errors"
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    expect(Buffer.from(buffer).toString("utf8")).not.toContain("password");
  });

  it("exports the selected snapshot as an xlsx response", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerResponse = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: cookie,
      payload: { name: "lab", url: "https://lab.example/ovirt-engine", username: "admin", password: "manager-password" }
    });
    const managerId = managerResponse.json().manager.id as string;
    const snapshotResponse = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(managerId, "lab")
    });
    const snapshotId = snapshotResponse.json().snapshot.id as string;

    const exportResponse = await app.inject({
      method: "GET",
      url: `/api/exports/excel?snapshotId=${snapshotId}`,
      cookies: cookie
    });

    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["content-type"]).toContain("spreadsheetml.sheet");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportResponse.rawPayload as never);
    expect(workbook.getWorksheet("VMs")?.rowCount).toBeGreaterThan(1);
    expect(exportResponse.rawPayload.toString("utf8")).not.toContain("manager-password");
    await app.close();
  });

  it("exports the selected snapshot as redacted JSON and CSV", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerResponse = await app.inject({
      method: "POST",
      url: "/api/managers",
      cookies: cookie,
      payload: { name: "lab", url: "https://lab.example/ovirt-engine", username: "admin", password: "manager-password" }
    });
    const managerId = managerResponse.json().manager.id as string;
    const snapshotResponse = await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(managerId, "lab")
    });
    const snapshotId = snapshotResponse.json().snapshot.id as string;

    const json = await app.inject({ method: "GET", url: `/api/exports/snapshot?format=json&snapshotId=${snapshotId}`, cookies: cookie });
    expect(json.statusCode).toBe(200);
    expect(json.json().snapshot.id).toBe(snapshotId);
    expect(json.body).not.toContain("manager-password");

    const csv = await app.inject({ method: "GET", url: `/api/exports/snapshot?format=csv&snapshotId=${snapshotId}`, cookies: cookie });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("vms");
    expect(csv.body).toContain("vm-1");
    expect(csv.body).not.toContain("manager-password");
    await app.close();
  });

  it("requires authentication for export", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/exports/excel" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
