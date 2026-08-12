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
  return { app, cookie: { [cookie.name]: cookie.value } };
}

async function createManager(app: ReturnType<typeof buildApp>, cookie: Record<string, string>, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/managers",
    cookies: cookie,
    payload: { name, url: `https://${name}.example/ovirt-engine`, username: "admin", password: "secret" }
  });
  return response.json().manager.id as string;
}

function snapshot(managerId: string, managerName: string, overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
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
      clusters: [{ id: `${managerName}-cluster` }],
      hosts: [{ id: `${managerName}-host`, status: "up" }],
      vms: [{ id: `${managerName}-vm`, status: "down" }]
    },
    warnings: [],
    errors: [],
    ...overrides
  };
}

describe("dashboard", () => {
  it("requires authentication", async () => {
    const { app } = await authenticatedApp();

    const response = await app.inject({ method: "GET", url: "/api/dashboard" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("aggregates latest inventory while preserving latest collection status", async () => {
    const { app, cookie } = await authenticatedApp();
    const firstManager = await createManager(app, cookie, "lab-a");
    const secondManager = await createManager(app, cookie, "lab-b");

    await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(firstManager, "lab-a", {
        resources: {
          ...emptyInventoryResources(),
          dataCenters: [{ id: "dc-a", name: "Default" }],
          clusters: [{ id: "cluster-a", name: "Cluster A", data_center: { id: "dc-a" }, version: { major: 4, minor: 8 } }],
          hosts: [{ id: "host-a", status: "up", cluster: { id: "cluster-a" } }],
          vms: [
            {
              id: "vm-a1",
              name: "api-01",
              status: "up",
              cluster: { id: "cluster-a" },
              host: { id: "host-a", name: "node-a" },
              cpu: { topology: { sockets: 1, cores: 2, threads: 2 } },
              memory: 8589934592,
              guest_info: { os: { name: "Linux", version: "9" } },
              custom_properties: { custom_property: [{ name: "environment", value: "prod" }] },
              nics: {
                nic: [
                  {
                    id: "nic-a1",
                    reported_devices: {
                      reported_device: [{ ips: { ip: [{ version: "v4", address: "10.0.0.10" }] } }]
                    }
                  }
                ]
              },
              disk_attachments: {
                disk_attachment: [
                  { disk: { id: "disk-a1", provisioned_size: 10737418240, actual_size: 5368709120 } }
                ]
              }
            },
            { id: "vm-a2", name: "db-01", status: "down", cluster: { id: "cluster-a" } }
          ],
          storageDomains: [{ id: "sd-a", data_center: { id: "dc-a" } }],
          disks: [{ id: "disk-a" }],
          networks: [{ id: "net-a" }]
        }
      })
    });
    await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(firstManager, "lab-a", {
        collectedAt: "2026-08-11T10:00:00.000Z",
        status: "failed",
        resources: emptyInventoryResources(),
        errors: [{ message: "network failed" }]
      })
    });
    await app.inject({
      method: "POST",
      url: "/api/snapshots",
      cookies: cookie,
      payload: snapshot(secondManager, "lab-b", {
        resources: {
          ...emptyInventoryResources(),
          clusters: [{ id: "cluster-b", name: "Cluster B" }],
          hosts: [{ id: "host-b", status: "maintenance", cluster: { id: "cluster-b" } }],
          vms: [{ id: "vm-b1", status: "up", cluster: { id: "cluster-b" } }],
          storageDomains: [],
          disks: [],
          networks: [{ id: "net-b" }]
        }
      })
    });

    const response = await app.inject({ method: "GET", url: "/api/dashboard", cookies: cookie });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totals).toMatchObject({ managers: 2, clusters: 2, hosts: 2, vms: 3, storageDomains: 1, disks: 1, networks: 2 });
    expect(body.vmStatuses).toEqual({ up: 2, down: 1 });
    expect(body.hostStatuses).toEqual({ up: 1, maintenance: 1 });
    expect(body.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          managerId: firstManager,
          clusterId: "cluster-a",
          name: "Cluster A",
          hostCount: 1,
          vmCount: 2,
          storageDomainCount: 1,
          version: "4.8"
        })
      ])
    );
    const labA = body.managers.find((manager: { name: string }) => manager.name === "lab-a");
    expect(labA.lastStatus).toBe("failed");
    expect(labA.errorsCount).toBe(1);
    expect(labA.resourceCounts.vms).toBe(2);
    expect(labA.latestInventorySnapshotId).not.toBe(labA.lastSnapshotId);

    const clusterDetail = await app.inject({
      method: "GET",
      url: `/api/dashboard/clusters/${encodeURIComponent(firstManager)}/cluster-a`,
      cookies: cookie
    });
    expect(clusterDetail.statusCode).toBe(200);
    expect(clusterDetail.json().cluster).toMatchObject({
      name: "Cluster A",
      hostCount: 1,
      vmCount: 2,
      storageDomainCount: 1,
      vms: [
        {
          name: "api-01",
          environment: "prod",
          powerState: "up",
          host: "node-a",
          guestOs: "Linux 9",
          ipAddress: "10.0.0.10",
          vcpuCount: 4,
          allocatedRamMiB: 8192,
          storageAllocatedGiB: 10,
          storageUsedGiB: 5
        },
        expect.objectContaining({ name: "db-01", powerState: "down" })
      ]
    });
    await app.close();
  });
});
