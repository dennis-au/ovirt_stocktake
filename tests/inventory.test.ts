import ExcelJS from "exceljs";
import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { replaceCurrentInventory } from "../server/postgres/inventory.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { hashPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const databases: SqliteDatabase[] = [];
const postgresPools: Array<PostgresQueryable & { end(): Promise<void> }> = [];

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(pool);
  postgresPools.push(pool);
  return pool;
}

afterEach(async () => {
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
  }
});

async function authenticatedApp(role: "admin" | "operator" | "viewer" = "admin") {
  const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
  const db = memoryDatabase();
  const pool = await memoryPostgres();
  await seedInventory(pool);
  const app = buildApp({
    db,
    inventoryDb: pool,
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
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: role, password: "inventory admin" } });
  const cookie = login.cookies[0];
  return { app, db, pool, cookie: { [cookie.name]: cookie.value } };
}

async function seedInventory(pool: PostgresQueryable): Promise<void> {
  await pool.query("INSERT INTO managers (id, name, url, credential_status) VALUES ($1, $2, $3, $4)", [
    "manager-1",
    "Lab",
    "https://lab.example/ovirt-engine",
    "saved"
  ]);
  await replaceCurrentInventory(pool, {
    managerId: "manager-1",
    status: "success",
    apiVersion: "4.5",
    startedAt: "2026-08-11T10:00:00.000Z",
    completedAt: "2026-08-11T10:00:02.000Z",
    resources: {
      events: [{ eventId: "event-1", eventTime: "2026-08-11T10:01:00.000Z", resourceType: "vm", resourceId: "vm-2", message: "VM powered down" }],
      storageDomains: [
        { storageDomainId: "sd-1", name: "data", usedBytes: 850, totalBytes: 1000 },
        { storageDomainId: "sd-2", name: "archive", usedBytes: 920, totalBytes: 1000 }
      ],
      vms: [
        {
          vmId: "vm-1",
          name: "api-01",
          status: "up",
          environment: "prod",
          application: "orders",
          owner: "platform",
          criticality: "critical",
          costCenter: "FIN-001",
          monthlyEstimatedCost: 250,
          backupStatus: "protected",
          clusterId: "cluster-1",
          clusterName: "Default",
          hostId: "host-1",
          hostName: "host-01",
          osType: "linux",
          guestOsName: "Linux",
          vcpus: 4,
          memoryMb: 8192,
          guestAgentStatus: "available",
          healthScore: 100,
          healthDeductions: [],
          tags: ["prod", "orders"],
          nics: [{ nicId: "nic-1", name: "nic1", logicalNetwork: "ovirtmgmt", vnicProfile: "ovirtmgmt", ipv4Addresses: ["10.0.0.10"] }],
          disks: [{ diskId: "disk-1", alias: "root", storageDomainId: "sd-1", storageDomain: "data", provisionedSizeGib: 100, actualSizeGib: 42 }],
          snapshots: []
        },
        {
          vmId: "vm-2",
          name: "risk-01",
          status: "down",
          environment: "prod",
          application: "billing",
          backupStatus: "failed",
          rpoTargetHours: 4,
          rpoActualHours: 9,
          osEolDate: "2000-01-01",
          vulnerabilityCriticalCount: 4,
          publicIp: "203.0.113.10",
          clusterId: "cluster-1",
          clusterName: "Default",
          hostId: "host-2",
          hostName: "host-02",
          guestAgentStatus: "missing",
          lifecycleStatus: "idle",
          healthScore: 45,
          healthDeductions: [{ code: "governance.missing_owner" }],
          tags: ["prod", "risk"],
          nics: [{ nicId: "nic-2", name: "nic1", logicalNetwork: "backup", vnicProfile: "backup" }],
          disks: [{ diskId: "disk-2", alias: "root", storageDomainId: "sd-2", storageDomain: "archive", provisionedSizeGib: 50, actualSizeGib: 12 }],
          snapshots: [{ snapshotId: "snapshot-old", ageDays: 31, description: "old" }]
        }
      ]
    }
  });
}

describe("VM inventory API", () => {
  it("lists collection runs and returns collection run detail", async () => {
    const { app, cookie } = await authenticatedApp();

    const list = await app.inject({ method: "GET", url: "/api/collection-runs", cookies: cookie });

    expect(list.statusCode).toBe(200);
    const run = list.json().collectionRuns[0] as { id: string; managerName: string; status: string; warningsCount: number; errorsCount: number };
    expect(run).toMatchObject({ managerName: "Lab", status: "success", warningsCount: 0, errorsCount: 0 });

    const detail = await app.inject({ method: "GET", url: `/api/collection-runs/${run.id}`, cookies: cookie });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().collectionRun).toMatchObject({ id: run.id, managerId: "manager-1", status: "success", warnings: [], errors: [] });
    expect(detail.body).not.toContain("password");
    await app.close();
  });

  it("returns operational dashboard KPIs and chart-ready drill-down data", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/dashboard/operational", cookies: cookie });

    expect(response.statusCode).toBe(200);
    const dashboard = response.json().dashboard;
    expect(dashboard.kpis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "governance.missing_metadata", value: 1, href: "/api/inventory/vms?missingMetadata=true" }),
        expect.objectContaining({ id: "backup.missing", value: 1, href: "/api/inventory/vms?missingBackup=true" }),
        expect.objectContaining({ id: "snapshot.over_30_days", value: 1, href: "/api/inventory/vms?snapshotAgeOverDays=30" })
      ])
    );
    expect(dashboard.charts.vmStatusByCluster).toEqual(expect.arrayContaining([expect.objectContaining({ cluster: "Default", status: "up" })]));
    expect(dashboard.charts.storageCapacity).toEqual(expect.arrayContaining([expect.objectContaining({ name: "archive" })]));
    expect(dashboard.charts.backupCompliance).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed", count: 1 })]));
    expect(dashboard.charts.costAttribution).toEqual(expect.arrayContaining([expect.objectContaining({ cost_center: "FIN-001" })]));
    expect(dashboard.managers[0]).toMatchObject({ name: "Lab", last_status: "success" });
    await app.close();
  });

  it("returns backup, security, lifecycle, and snapshot exception views", async () => {
    const { app, cookie } = await authenticatedApp();

    const all = await app.inject({ method: "GET", url: "/api/exceptions", cookies: cookie });
    const backup = await app.inject({ method: "GET", url: "/api/exceptions?type=backup_non_compliance", cookies: cookie });
    const integrations = await app.inject({ method: "GET", url: "/api/integrations/status", cookies: cookie });

    expect(all.statusCode).toBe(200);
    expect(all.json().exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "backup_non_compliance", vmId: "vm-2" }),
        expect.objectContaining({ type: "rpo_breach", vmId: "vm-2" }),
        expect.objectContaining({ type: "unsupported_os", vmId: "vm-2" }),
        expect.objectContaining({ type: "critical_vulnerabilities", vmId: "vm-2" }),
        expect.objectContaining({ type: "public_exposure", vmId: "vm-2" }),
        expect.objectContaining({ type: "retirement_candidate", vmId: "vm-2" }),
        expect.objectContaining({ type: "snapshot_risk", vmId: "vm-2" })
      ])
    );
    expect(backup.json().exceptions.every((item: { type: string }) => item.type === "backup_non_compliance")).toBe(true);
    expect(integrations.json().integrations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "commvault", status: "unavailable" })])
    );
    await app.close();
  });

  it("exports exception views and VM detail evidence as JSON, CSV, and Excel", async () => {
    const { app, cookie } = await authenticatedApp();

    const exceptionsJson = await app.inject({
      method: "GET",
      url: "/api/exports/exceptions?format=json&type=backup_non_compliance",
      cookies: cookie
    });
    expect(exceptionsJson.statusCode).toBe(200);
    expect(exceptionsJson.json().exceptions).toEqual([expect.objectContaining({ type: "backup_non_compliance", vmId: "vm-2" })]);

    const exceptionsCsv = await app.inject({
      method: "GET",
      url: "/api/exports/exceptions?format=csv&type=snapshot_risk",
      cookies: cookie
    });
    expect(exceptionsCsv.statusCode).toBe(200);
    expect(exceptionsCsv.headers["content-type"]).toContain("text/csv");
    expect(exceptionsCsv.body).toContain("snapshot_risk");

    const exceptionsExcel = await app.inject({ method: "GET", url: "/api/exports/exceptions?format=excel", cookies: cookie });
    expect(exceptionsExcel.statusCode).toBe(200);
    const exceptionWorkbook = new ExcelJS.Workbook();
    await exceptionWorkbook.xlsx.load(exceptionsExcel.rawPayload as never);
    expect(exceptionWorkbook.getWorksheet("Exceptions")?.rowCount).toBeGreaterThan(1);

    const detailJson = await app.inject({
      method: "GET",
      url: "/api/exports/vm-detail?format=json&managerId=manager-1&vmId=vm-2",
      cookies: cookie
    });
    expect(detailJson.statusCode).toBe(200);
    expect(detailJson.json().vm.health.deductions[0]).toMatchObject({ code: "governance.missing_owner" });

    const detailCsv = await app.inject({
      method: "GET",
      url: "/api/exports/vm-detail?format=csv&managerId=manager-1&vmId=vm-2",
      cookies: cookie
    });
    expect(detailCsv.statusCode).toBe(200);
    expect(detailCsv.headers["content-type"]).toContain("text/csv");
    expect(detailCsv.body).toContain("governance.missing_owner");

    const detailExcel = await app.inject({
      method: "GET",
      url: "/api/exports/vm-detail?format=excel&managerId=manager-1&vmId=vm-2",
      cookies: cookie
    });
    expect(detailExcel.statusCode).toBe(200);
    const detailWorkbook = new ExcelJS.Workbook();
    await detailWorkbook.xlsx.load(detailExcel.rawPayload as never);
    expect(detailWorkbook.getWorksheet("VM Detail Evidence")?.rowCount).toBeGreaterThan(1);
    expect(detailExcel.rawPayload.toString("utf8")).not.toContain("manager-password");
    await app.close();
  });

  it("redacts sensitive exception evidence for viewer role", async () => {
    const { app, cookie } = await authenticatedApp("viewer");

    const response = await app.inject({ method: "GET", url: "/api/exceptions?type=public_exposure", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("public_exposure");
    expect(response.body).not.toContain("203.0.113.10");
    await app.close();
  });

  it("filters and paginates VM inventory on the server", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/inventory/vms?environment=prod&tag=orders&page=1&pageSize=1&columns=name,status,owner,healthScore",
      cookies: cookie
    });

    expect(response.statusCode).toBe(200);
    const inventory = response.json().inventory;
    expect(inventory.total).toBe(1);
    expect(inventory.pageSize).toBe(1);
    expect(inventory.columns).toEqual(["name", "status", "owner", "healthScore"]);
    expect(inventory.rows[0]).toMatchObject({ vmId: "vm-1", name: "api-01", owner: "platform", healthScore: 100 });
    await app.close();
  });

  it("supports exception filters for missing backup, snapshots, and metadata", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/inventory/vms?missingBackup=true&snapshotAgeOverDays=30&missingMetadata=true",
      cookies: cookie
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().inventory.rows.map((row: { name: string }) => row.name)).toEqual(["risk-01"]);
    await app.close();
  });

  it("redacts sensitive inventory fields for viewer role", async () => {
    const { app, cookie } = await authenticatedApp("viewer");

    const response = await app.inject({ method: "GET", url: "/api/inventory/vms?tag=orders", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("api-01");
    expect(response.body).not.toContain("FIN-001");
    expect(response.body).not.toContain("monthlyEstimatedCost");
    await app.close();
  });

  it("exports filtered inventory as JSON, CSV, and Excel without secrets", async () => {
    const { app, cookie } = await authenticatedApp();

    const json = await app.inject({ method: "GET", url: "/api/exports/inventory?format=json&tag=orders", cookies: cookie });
    expect(json.statusCode).toBe(200);
    expect(json.json().inventory.rows).toHaveLength(1);

    const csv = await app.inject({ method: "GET", url: "/api/exports/inventory?format=csv&tag=orders&columns=name,owner", cookies: cookie });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("api-01,platform");

    const excel = await app.inject({ method: "GET", url: "/api/exports/inventory?format=excel&tag=orders", cookies: cookie });
    expect(excel.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.rawPayload as never);
    expect(workbook.getWorksheet("VM Inventory")?.rowCount).toBe(2);
    expect(excel.rawPayload.toString("utf8")).not.toContain("manager-password");
    await app.close();
  });

  it("returns a structured VM detail response with tabs and health evidence", async () => {
    const { app, cookie } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/inventory/vms/manager-1/vm-2", cookies: cookie });

    expect(response.statusCode).toBe(200);
    const vm = response.json().vm;
    expect(vm.tabs.overview).toMatchObject({ name: "risk-01", status: "down", clusterName: "Default" });
    expect(vm.tabs.performance).toMatchObject({ metricsAvailable: false });
    expect(vm.tabs.storageSnapshots.snapshots[0]).toMatchObject({ snapshot_id: "snapshot-old", age_days: 31 });
    expect(vm.tabs.network.nics[0]).toMatchObject({ nic_id: "nic-2", logical_network: "backup" });
    expect(vm.tabs.backupDr).toMatchObject({ backupStatus: "failed", lifecycleStatus: "idle" });
    expect(vm.tabs.eventsAudit.events[0]).toMatchObject({ event_id: "event-1", message: "VM powered down" });
    expect(vm.tabs.eventsAudit.history).toHaveLength(1);
    expect(vm.health.deductions[0]).toMatchObject({ code: "governance.missing_owner" });
    expect(response.body).not.toContain("raw_json");
    await app.close();
  });

  it("redacts sensitive VM detail fields for viewer role", async () => {
    const { app, cookie } = await authenticatedApp("viewer");

    const response = await app.inject({ method: "GET", url: "/api/inventory/vms/manager-1/vm-1", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("api-01");
    expect(response.body).not.toContain("FIN-001");
    expect(response.body).not.toContain("monthlyEstimatedCost");
    await app.close();
  });
});

describe("saved views", () => {
  it("saves, restores, updates, deletes, and audits inventory view state", async () => {
    const { app, cookie } = await authenticatedApp();

    const create = await app.inject({
      method: "POST",
      url: "/api/saved-views",
      cookies: cookie,
      payload: {
        name: "Production risks",
        scope: "inventory.vms",
        filters: { environment: "prod", missingBackup: true },
        columns: ["name", "owner", "healthScore"],
        visibility: "shared"
      }
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().savedView.id as string;

    const list = await app.inject({ method: "GET", url: "/api/saved-views?scope=inventory.vms", cookies: cookie });
    expect(list.json().savedViews[0]).toMatchObject({ name: "Production risks", filters: { missingBackup: true } });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/saved-views/${id}`,
      cookies: cookie,
      payload: { name: "Production backup risks" }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().savedView.name).toBe("Production backup risks");

    const remove = await app.inject({ method: "DELETE", url: `/api/saved-views/${id}`, cookies: cookie });
    expect(remove.statusCode).toBe(204);

    const audit = await app.inject({ method: "GET", url: "/api/audit-logs", cookies: cookie });
    expect(audit.body).toContain("saved_view.created");
    expect(audit.body).toContain("saved_view.updated");
    expect(audit.body).toContain("saved_view.deleted");
    await app.close();
  });
});
