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

async function authenticatedApp() {
  const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
  const app = buildApp({
    db: memoryDatabase(),
    config: testConfig({
      credentialEncryptionKey: "test-encryption-key-that-is-long-enough",
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

async function createManager(app: ReturnType<typeof buildApp>, cookie: Record<string, string>, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/managers",
    cookies: cookie,
    payload: { name, url: `https://${name}.example/ovirt-engine`, username: "admin", password: "manager-password" }
  });
  return response.json().manager.id as string;
}

function snapshot(managerId: string, managerName: string): SnapshotPayload {
  return {
    managerId,
    managerName,
    managerUrl: `https://${managerName}.example/ovirt-engine`,
    collectedAt: "2026-08-12T04:00:00.000Z",
    apiVersion: "4.8",
    durationMs: 100,
    status: "success",
    resources: {
      ...emptyInventoryResources(),
      dataCenters: [{ id: "dc-1", name: "Default" }],
      clusters: [{ id: "cluster-1", name: "Default", data_center: { id: "dc-1" } }],
      hosts: [{ id: "host-1", name: "node-01", cluster: { id: "cluster-1" } }],
      storageDomains: [{ id: "sd-1", name: "data", data_center: { id: "dc-1" } }],
      vms: [
        {
          id: "vm-1",
          name: "api-01",
          status: "up",
          cluster: { id: "cluster-1", name: "Default" },
          host: { id: "host-1", name: "node-01" },
          cpu: { topology: { sockets: 1, cores: 2, threads: 2 } },
          memory: 8589934592,
          guest_info: {
            os: { name: "Linux", version: "9" },
            ips: { ip: [{ version: "v4", address: "10.0.0.12" }, { version: "v4", address: "10.0.0.10" }] }
          },
          custom_properties: { custom_property: [{ name: "environment", value: "prod" }] },
          nics: {
            nic: [
              {
                reported_devices: {
                  reported_device: [{ ips: { ip: [{ version: "v4", address: "10.0.0.10" }, { version: "v4", address: "10.0.0.11" }] } }]
                }
              }
            ]
          },
          disk_attachments: {
            disk_attachment: [
              {
                disk: {
                  id: "disk-1",
                  provisioned_size: 10737418240,
                  actual_size: 5368709120,
                  storage_domains: { storage_domain: [{ id: "sd-1" }] }
                }
              }
            ]
          }
        },
        {
          id: "vm-2",
          name: "web-10",
          status: "down",
          cluster: { id: "cluster-1", name: "Default" },
          host: { id: "host-1", name: "node-01" },
          cpu: { topology: { sockets: 1, cores: 1, threads: 1 } },
          memory: 4299161600,
          guest_info: { os: { name: "Linux", version: "8" } },
          nics: {
            nic: [
              {
                reported_devices: {
                  reported_device: [{ ips: { ip: [{ version: "v4", address: "10.0.0.20" }] } }]
                }
              }
            ]
          }
        }
      ],
      vmSnapshots: [
        { id: "snap-1", name: "before-patch", vm: { id: "vm-1", name: "api-01" } },
        { id: "snap-2", description: "pre-upgrade", vm: { id: "vm-1", name: "api-01" } },
        { id: "snap-active", description: "Active VM", vm: { id: "vm-2", name: "web-10" } }
      ]
    },
    warnings: [],
    errors: []
  };
}

describe("snapshot-backed VM inventory", () => {
  it("lists, filters, and exports latest snapshot VM inventory", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie, "lab");
    await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload: snapshot(managerId, "lab") });

    const list = await app.inject({
      method: "GET",
      url: "/api/inventory/snapshot-vms?search=api&environment=prod&page=1&pageSize=25",
      cookies: cookie
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().inventory.rows[0]).toMatchObject({
      managerName: "lab",
      clusterName: "Default",
      name: "api-01",
      environment: "prod",
      powerState: "up",
      host: "node-01",
      guestOs: "Linux 9",
      ipAddress: "10.0.0.10",
      ipAddresses: ["10.0.0.10", "10.0.0.11", "10.0.0.12"],
      vcpuCount: 4,
      allocatedRamMiB: 8192,
      storageAllocatedGiB: 10,
      storageUsedGiB: 5,
      snapshotNames: ["before-patch", "pre-upgrade"]
    });
    expect(list.json().inventory.filterOptions.clusters).toEqual([{ value: "cluster-1", label: "Default" }]);

    const allVms = await app.inject({ method: "GET", url: "/api/inventory/snapshot-vms", cookies: cookie });
    expect(allVms.statusCode).toBe(200);
    expect(allVms.json().inventory.rows.find((row: { name: string }) => row.name === "web-10").snapshotNames).toEqual([]);

    const allCsv = await app.inject({ method: "GET", url: "/api/exports/snapshot-vms?format=csv", cookies: cookie });
    expect(allCsv.statusCode).toBe(200);
    const webRow = allCsv.body.split("\n").find((line) => line.includes("web-10"));
    expect(webRow).toBeDefined();
    expect(webRow).not.toContain("Active VM");

    const csv = await app.inject({ method: "GET", url: "/api/exports/snapshot-vms?format=csv&search=api", cookies: cookie });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("api-01");
    expect(csv.body).toContain("Snapshots");
    expect(csv.body).toContain("before-patch; pre-upgrade");
    expect(csv.body).toContain("IP Addresses");
    expect(csv.body).toContain("10.0.0.10; 10.0.0.11; 10.0.0.12");
    expect(csv.body).toContain("8,192 MiB (~8 GiB)");
    expect(csv.body).not.toContain("Environment");
    expect(csv.body).not.toContain("manager-password");

    const pdf = await app.inject({ method: "GET", url: "/api/exports/snapshot-vms?format=pdf&search=api", cookies: cookie });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    expect(pdf.rawPayload.toString("utf8")).not.toContain("manager-password");
    await app.close();
  });

  it("sorts latest snapshot VM inventory before pagination", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie, "lab");
    await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload: snapshot(managerId, "lab") });

    const nameSort = await app.inject({
      method: "GET",
      url: "/api/inventory/snapshot-vms?sortBy=name&sortDirection=desc&page=1&pageSize=1",
      cookies: cookie
    });
    expect(nameSort.statusCode).toBe(200);
    expect(nameSort.json().inventory.rows.map((row: { name: string }) => row.name)).toEqual(["web-10"]);
    expect(nameSort.json().inventory.total).toBe(2);

    const ramSort = await app.inject({
      method: "GET",
      url: "/api/inventory/snapshot-vms?sortBy=allocatedRamMiB&sortDirection=asc&page=1&pageSize=2",
      cookies: cookie
    });
    expect(ramSort.statusCode).toBe(200);
    expect(ramSort.json().inventory.rows.map((row: { name: string }) => row.name)).toEqual(["web-10", "api-01"]);
    await app.close();
  });

  it("lists and exports latest manager cluster host VM relationships", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie, "lab");
    await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload: snapshot(managerId, "lab") });

    const list = await app.inject({
      method: "GET",
      url: "/api/inventory/relationships",
      cookies: cookie
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().relationships.rows).toEqual([
      expect.objectContaining({
        managerName: "lab",
        clusterName: "Default",
        hostName: "node-01",
        vmName: "api-01",
        storageDomainNames: ["data"]
      }),
      expect.objectContaining({
        managerName: "lab",
        clusterName: "Default",
        hostName: "node-01",
        vmName: "web-10",
        storageDomainNames: []
      })
    ]);
    expect(list.json().relationships.total).toBe(2);

    const csv = await app.inject({ method: "GET", url: "/api/exports/relationships", cookies: cookie });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("Manager,Cluster,Host,VM,Storage Domains,Collected At");
    expect(csv.body).toContain("lab,Default,node-01,api-01,data");
    expect(csv.body).toContain("lab,Default,node-01,web-10,-");
    expect(csv.body).not.toContain("manager-password");

    const customCsv = await app.inject({
      method: "GET",
      url: "/api/exports/relationships?columns=vmName,storageDomainNames,hostName,managerName",
      cookies: cookie
    });
    expect(customCsv.statusCode).toBe(200);
    expect(customCsv.body.split("\n")[0]).toBe("VM,Storage Domains,Host,Manager");
    expect(customCsv.body).toContain("api-01,data,node-01,lab");
    expect(customCsv.body).toContain("web-10,-,node-01,lab");

    const fallbackCsv = await app.inject({
      method: "GET",
      url: "/api/exports/relationships?columns=password,token",
      cookies: cookie
    });
    expect(fallbackCsv.statusCode).toBe(200);
    expect(fallbackCsv.body.split("\n")[0]).toBe("Manager,Cluster,Host,VM,Storage Domains,Collected At");
    expect(fallbackCsv.body).not.toContain("manager-password");
    await app.close();
  });
});
