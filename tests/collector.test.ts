import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newDb } from "pg-mem";
import { buildApp } from "../server/app.js";
import { allowInsecureTlsForManager } from "../server/collection.js";
import { openDatabase, type SqliteDatabase } from "../server/db.js";
import { collectOvirtSnapshot, ovirtApiBase, ovirtTokenUrl, type OvirtCollectionTarget } from "../server/ovirt.js";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { hashPassword } from "../server/security.js";
import { testConfig } from "./health.test.js";

const target: OvirtCollectionTarget = {
  managerId: "manager-1",
  managerName: "Lab",
  managerUrl: "https://lab111/ovirt-engine",
  username: "admin",
  password: "secret"
};

const databases: SqliteDatabase[] = [];
const postgresPools: Array<PostgresQueryable & { end(): Promise<void> }> = [];
const encryptionKey = "test-encryption-key-that-is-long-enough";

function memoryDatabase(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  while (databases.length) {
    databases.pop()?.close();
  }
  while (postgresPools.length) {
    await postgresPools.pop()?.end();
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

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(pool);
  postgresPools.push(pool);
  return pool;
}

async function createManager(
  app: ReturnType<typeof buildApp>,
  cookie: Record<string, string>,
  input: { name: string; enabled?: boolean }
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/managers",
    cookies: cookie,
    payload: {
      name: input.name,
      url: `https://${input.name}.example/ovirt-engine`,
      enabled: input.enabled ?? true,
      username: "test-user",
      password: "manager-password"
    }
  });
  return response.json().manager.id as string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function ovirtFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/sso/oauth/token")) {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=password");
      expect(String(init?.body)).toContain("scope=ovirt-app-api");
      return jsonResponse({ access_token: "test-access-token", token_type: "bearer" });
    }

    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
    const resource = parsed.pathname.split("/").at(-1);
    const page = parsed.searchParams.get("page");

    if (resource === "datacenters") {
      return jsonResponse({ data_center: [{ id: "dc-1", name: "Default" }] });
    }
    if (resource === "clusters") {
      return jsonResponse({ cluster: [{ id: "cluster-1", name: "Default", version: { major: 4, minor: 5 } }] });
    }
    if (resource === "hosts") {
      return jsonResponse({ host: [{ id: "host-1", name: "host-1", status: "up" }] });
    }
    if (resource === "vms" && page === "1") {
      return jsonResponse({ vm: Array.from({ length: 1000 }, (_, index) => ({ id: `vm-${index}`, name: `vm-${index}` })) });
    }
    if (resource === "vms" && page === "2") {
      return jsonResponse({ vm: [{ id: "vm-1000", name: "vm-1000" }] });
    }
    if (resource === "storagedomains") {
      return jsonResponse({ storage_domain: [{ id: "sd-1", name: "data" }] });
    }
    if (resource === "disks") {
      return jsonResponse({ disk: [{ id: "disk-1", name: "disk" }] });
    }
    if (resource === "networks") {
      return jsonResponse({ network: [{ id: "net-1", name: "ovirtmgmt" }] });
    }
    if (resource === "vnicprofiles") {
      return jsonResponse({ vnic_profile: [{ id: "profile-1", name: "ovirtmgmt", network: { id: "net-1" } }] });
    }
    if (resource === "tags") {
      return jsonResponse({ tag: [{ id: "tag-1", name: "prod" }] });
    }
    if (resource === "events") {
      return jsonResponse({ event: [{ id: "event-1", time: "2026-08-11T10:00:00.000Z", description: "VM started" }] });
    }
    if (resource === "snapshots") {
      return jsonResponse({ snapshot: [{ id: `snap-${parsed.pathname.split("/").at(-2)}`, description: "Active VM" }] });
    }
    if (resource === "affinitygroups") {
      return jsonResponse({ affinity_group: [{ id: "affinity-1", name: "anti-affinity", vms: { vm: [{ id: "vm-1" }] } }] });
    }
    return jsonResponse({}, 404);
  });
}

function expandedOvirtFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const parsed = new URL(String(input));
    const resource = parsed.pathname.split("/").at(-1);
    if (parsed.pathname.endsWith("/sso/oauth/token")) {
      return jsonResponse({ access_token: "test-access-token", token_type: "bearer" });
    }
    if (resource === "datacenters") {
      return jsonResponse({ data_center: [{ id: "dc-1", name: "Default", status: "up" }] });
    }
    if (resource === "clusters") {
      return jsonResponse({ cluster: [{ id: "cluster-1", name: "Default", data_center: { id: "dc-1" }, version: { major: 4, minor: 5 } }] });
    }
    if (resource === "hosts") {
      return jsonResponse({ host: [{ id: "host-1", name: "host-1", cluster: { id: "cluster-1" }, status: "up" }] });
    }
    if (resource === "vms") {
      return jsonResponse({
        vm: [
          {
            id: "vm-1",
            name: "api-01",
            status: "up",
            cluster: { id: "cluster-1" },
            memory: 8589934592,
            guest_info: { fqdn: "api-01.example" },
            nics: { nic: [{ id: "nic-1", name: "nic1", mac: { address: "00:1a:4a:16:01:51" } }] },
            disk_attachments: {
              disk_attachment: [{ id: "attach-1", bootable: true, disk: { id: "disk-1", alias: "root", provisioned_size: 10737418240 } }]
            },
            tags: { tag: [{ id: "tag-1", name: "prod" }] }
          }
        ]
      });
    }
    if (resource === "storagedomains") {
      return jsonResponse({ storage_domain: [{ id: "sd-1", name: "data", available: 10, used: 5 }] });
    }
    if (resource === "disks") {
      return jsonResponse({ disk: [{ id: "disk-1", name: "root" }] });
    }
    if (resource === "networks") {
      return jsonResponse({ network: [{ id: "net-1", name: "ovirtmgmt", data_center: { id: "dc-1" } }] });
    }
    if (resource === "vnicprofiles") {
      return jsonResponse({ vnic_profile: [{ id: "profile-1", name: "ovirtmgmt", network: { id: "net-1" } }] });
    }
    if (resource === "tags") {
      return jsonResponse({ tag: [{ id: "tag-1", name: "prod" }] });
    }
    if (resource === "events") {
      return jsonResponse({ event: [{ id: "event-1", time: "2026-08-11T10:00:00.000Z", severity: "normal", description: "VM started" }] });
    }
    if (resource === "snapshots") {
      return jsonResponse({ snapshot: [{ id: "snapshot-1", description: "pre-change", date: "2026-08-10T10:00:00.000Z" }] });
    }
    if (resource === "affinitygroups") {
      return jsonResponse({ affinity_group: [{ id: "affinity-1", name: "anti-affinity", enforcing: true, vms: { vm: [{ id: "vm-1" }] } }] });
    }
    return jsonResponse({}, 404);
  });
}

describe("oVirt backend collector", () => {
  it("builds API base URLs from manager URLs", () => {
    expect(ovirtApiBase("https://lab111/ovirt-engine")).toBe("https://lab111/ovirt-engine/api");
    expect(ovirtApiBase("https://lab111/ovirt-engine/api")).toBe("https://lab111/ovirt-engine/api");
    expect(ovirtApiBase("https://lab111")).toBe("https://lab111/ovirt-engine/api");
    expect(ovirtTokenUrl("https://lab111/ovirt-engine")).toBe("https://lab111/ovirt-engine/sso/oauth/token");
  });

  it("collects resources with GET requests and pagination", async () => {
    const fetchMock = ovirtFetchMock();
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const snapshot = await collectOvirtSnapshot(target, { fetchImpl });

    expect(snapshot.status).toBe("success");
    expect(snapshot.apiVersion).toBe("4.5");
    expect(snapshot.resources.vms).toHaveLength(1001);
    expect(snapshot.resources.hosts[0]).toMatchObject({ name: "host-1" });
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "GET")).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded"
    });
  });

  it("collects the revamp inventory resource coverage with read-only API calls", async () => {
    const fetchMock = expandedOvirtFetchMock();
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const snapshot = await collectOvirtSnapshot(target, { fetchImpl });

    expect(snapshot.status).toBe("success");
    expect(snapshot.resources.dataCenters).toHaveLength(1);
    expect(snapshot.resources.vnicProfiles).toHaveLength(1);
    expect(snapshot.resources.tags).toHaveLength(1);
    expect(snapshot.resources.vmSnapshots).toHaveLength(1);
    expect(snapshot.resources.affinityGroups).toHaveLength(1);
    expect(snapshot.resources.events).toHaveLength(1);
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "GET")).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/vms/vm-1/snapshots"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/clusters/cluster-1/affinitygroups"))).toBe(true);
  });

  it("keeps partial results when one resource fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      if (parsed.pathname.endsWith("/sso/oauth/token")) {
        return jsonResponse({ access_token: "test-access-token", token_type: "bearer" });
      }
      const resource = parsed.pathname.split("/").at(-1);
      if (resource === "hosts") {
        return jsonResponse({}, 500);
      }
      return jsonResponse({ cluster: [], vm: [], storage_domain: [], disk: [], network: [] });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const snapshot = await collectOvirtSnapshot(target, { fetchImpl });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.errors).toEqual([{ resource: "hosts", message: "oVirt returned HTTP 500" }]);
  });

  it("labels authentication and network failures", async () => {
    const authFailMock = vi.fn(async () => jsonResponse({}, 401));
    const authFailFetch = authFailMock as unknown as typeof fetch;
    const authSnapshot = await collectOvirtSnapshot(target, { fetchImpl: authFailFetch });
    expect(authSnapshot.errors[0]).toEqual({ message: "Authentication failed with HTTP 401" });

    const networkFailMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const networkFailFetch = networkFailMock as unknown as typeof fetch;
    const networkSnapshot = await collectOvirtSnapshot(target, { fetchImpl: networkFailFetch });
    expect(networkSnapshot.status).toBe("failed");
    expect(networkSnapshot.errors[0]?.message).toContain("Network or TLS failure");
    expect(networkSnapshot.warnings).toEqual([]);
  });
});

describe("manual backend collection API", () => {
  it("combines global and per-manager insecure TLS settings", () => {
    expect(allowInsecureTlsForManager(false, { ignore_tls: 0 })).toBe(false);
    expect(allowInsecureTlsForManager(false, { ignore_tls: 1 })).toBe(true);
    expect(allowInsecureTlsForManager(true, { ignore_tls: 0 })).toBe(true);
  });

  it("tests a manager connection without saving credentials or snapshots", async () => {
    const { app, cookie } = await authenticatedApp();
    const fetchMock = expandedOvirtFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/managers/test-collection",
      cookies: cookie,
      payload: {
        name: "lab-test",
        url: "https://lab-test.example/ovirt-engine",
        username: "test-user",
        password: "manager-password",
        ignoreTls: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("manager-password");
    expect(response.body).not.toContain("test-user");
    expect(response.json().result).toMatchObject({
      managerName: "lab-test",
      managerUrl: "https://lab-test.example/ovirt-engine",
      status: "success",
      resourceCounts: { vms: 1, clusters: 1, hosts: 1 }
    });
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "GET")).toBe(true);

    const managers = await app.inject({ method: "GET", url: "/api/managers", cookies: cookie });
    expect(managers.json().managers).toEqual([]);
    const snapshots = await app.inject({ method: "GET", url: "/api/snapshots", cookies: cookie });
    expect(snapshots.json().snapshots).toEqual([]);
    await app.close();
  });

  it("tests an existing manager using saved credentials when password is blank", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie, { name: "saved-lab" });
    vi.stubGlobal("fetch", expandedOvirtFetchMock());

    const response = await app.inject({
      method: "POST",
      url: "/api/managers/test-collection",
      cookies: cookie,
      payload: {
        managerId,
        name: "saved-lab",
        url: "https://saved-lab.example/ovirt-engine",
        ignoreTls: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("manager-password");
    expect(response.body).not.toContain("test-user");
    expect(response.json().result.status).toBe("success");

    const snapshots = await app.inject({ method: "GET", url: `/api/snapshots?managerId=${managerId}`, cookies: cookie });
    expect(snapshots.json().snapshots).toEqual([]);
    await app.close();
  });

  it("collects one manager, saves a snapshot, and never returns credentials", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie, { name: "lab" });
    const fetchMock = ovirtFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: `/api/managers/${managerId}/collect`,
      cookies: cookie
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("manager-password");
    expect(response.body).not.toContain("test-user");
    const body = response.json();
    expect(body.snapshot.status).toBe("success");
    expect(body.snapshot.resourceCounts.vms).toBe(1001);
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => init?.method === "GET")).toBe(true);

    const snapshots = await app.inject({ method: "GET", url: `/api/snapshots?managerId=${managerId}`, cookies: cookie });
    expect(snapshots.json().snapshots).toHaveLength(1);
    const inventory = await app.inject({ method: "GET", url: "/api/inventory/snapshot-vms", cookies: cookie });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().inventory.total).toBe(1001);
    await app.close();
  });

  it("populates normalized PostgreSQL current inventory and history during manual collection", async () => {
    const pool = await memoryPostgres();
    const passwordHash = await hashPassword("inventory admin", Buffer.from("0123456789abcdef"));
    const app = buildApp({
      db: memoryDatabase(),
      inventoryDb: pool,
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
    const cookie = { [login.cookies[0].name]: login.cookies[0].value };
    const managerId = await createManager(app, cookie, { name: "lab-normalized" });
    vi.stubGlobal("fetch", expandedOvirtFetchMock());

    const response = await app.inject({ method: "POST", url: `/api/managers/${managerId}/collect`, cookies: cookie });

    expect(response.statusCode).toBe(200);
    const vms = await pool.query<{ name: string; memory_mb: number; health_score: number; health_deductions: unknown[] }>(
      "SELECT name, memory_mb, health_score, health_deductions FROM vms WHERE manager_id = $1",
      [managerId]
    );
    expect(vms.rows[0]).toMatchObject({ name: "api-01", memory_mb: 8192, health_score: expect.any(Number) });
    expect(JSON.stringify(vms.rows[0].health_deductions)).toContain("governance.missing_owner");
    const history = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM inventory_history WHERE manager_id = $1", [managerId]);
    expect(Number(history.rows[0].count)).toBe(1);
    const runs = await pool.query<{ status: string }>("SELECT status FROM collection_runs WHERE manager_id = $1", [managerId]);
    expect(runs.rows).toEqual([{ status: "success" }]);
    await app.close();
  });

  it("collects all enabled managers only", async () => {
    const { app, cookie } = await authenticatedApp();
    await createManager(app, cookie, { name: "enabled" });
    await createManager(app, cookie, { name: "disabled", enabled: false });
    vi.stubGlobal("fetch", ovirtFetchMock());

    const response = await app.inject({ method: "POST", url: "/api/collect", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshots).toHaveLength(1);
    expect(response.json().snapshots[0].managerName).toBe("enabled");
    await app.close();
  });

  it("requires authentication and refuses disabled managers", async () => {
    const { app, cookie } = await authenticatedApp();
    const disabledManagerId = await createManager(app, cookie, { name: "disabled", enabled: false });

    const unauthenticated = await app.inject({ method: "POST", url: `/api/managers/${disabledManagerId}/collect` });
    expect(unauthenticated.statusCode).toBe(401);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/managers/${disabledManagerId}/collect`,
      cookies: cookie
    });
    expect(disabled.statusCode).toBe(409);
    await app.close();
  });
});
