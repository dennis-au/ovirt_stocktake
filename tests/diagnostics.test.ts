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
      hosts: [{ id: "host-1", name: "private-host" }],
      vms: [{ id: "vm-1", name: "private-vm" }],
      vmSnapshots: [
        { id: "snapshot-dated", name: "private-snapshot", date: "2026-08-10T01:00:00.000Z", vm: { id: "vm-1", name: "private-vm" } },
        { id: "snapshot-missing", description: "private-missing-date", creation_date: "2026-08-09T01:00:00.000Z", vm: { id: "vm-2", name: "private-vm-2" } },
        { id: "snapshot-invalid", description: "private-invalid-date", date: "not-a-date", vm: { id: "vm-3", name: "private-vm-3" } },
        { id: "snapshot-active", description: "Active VM", date: "2026-08-19T01:00:00.000Z", vm: { id: "vm-4", name: "private-vm-4" } }
      ]
    },
    warnings: [
      { resource: "vmSnapshots", message: "private-vm-2 snapshot private-missing-date has no creation date" },
      { resource: "vms", message: "private-vm has no guest-agent data" },
      { resource: "hosts", message: "private-host certificate expiry is unavailable" }
    ],
    errors: [
      { resource: "vmSnapshots", message: "private-vm-3 snapshot private-invalid-date detail collection failed: oVirt returned HTTP 500" },
      { resource: "hosts", message: "private-host certificate detail collection failed: oVirt returned HTTP 404" },
      { resource: "hosts", message: "private-host-2 certificate detail collection failed: oVirt returned HTTP 404" },
      { resource: "affinityGroups", message: "private-cluster affinitygroups collection failed: oVirt request timed out" },
      { resource: "networks", message: "Network or TLS failure while contacting private-manager.example" }
    ]
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
        reportVersion: 2,
        managerCount: 1,
        managers: [
          expect.objectContaining({
            label: "Manager 1",
            latestInventoryRun: expect.objectContaining({
              status: "partial",
              warningCount: 3,
              errorCount: 5,
              populatedResourceCount: 3,
              totalResourceCount: 12,
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
              observedTemporalFields: { creation_date: 1, date: 2 },
              resourceStates: expect.arrayContaining([
                { resource: "hosts", recordCount: 1, state: "partial", warningCount: 1, errorCount: 2 },
                { resource: "vms", recordCount: 1, state: "collected", warningCount: 1, errorCount: 0 },
                { resource: "networks", recordCount: 0, state: "failed", warningCount: 0, errorCount: 1 },
                { resource: "vmSnapshots", recordCount: 4, state: "partial", warningCount: 1, errorCount: 1 },
                { resource: "affinityGroups", recordCount: 0, state: "failed", warningCount: 0, errorCount: 1 }
              ]),
              issueFingerprints: expect.arrayContaining([
                {
                  fingerprint: "error:hosts:host_certificate_detail:http_4xx",
                  severity: "error",
                  resource: "hosts",
                  operation: "host_certificate_detail",
                  failureCategory: "http_4xx",
                  httpStatusClass: "4xx",
                  count: 2
                },
                {
                  fingerprint: "error:affinityGroups:child_collection:timeout",
                  severity: "error",
                  resource: "affinityGroups",
                  operation: "child_collection",
                  failureCategory: "timeout",
                  count: 1
                },
                {
                  fingerprint: "error:networks:resource_list:network_tls",
                  severity: "error",
                  resource: "networks",
                  operation: "resource_list",
                  failureCategory: "network_tls",
                  count: 1
                },
                {
                  fingerprint: "warning:vms:guest_agent:missing_data",
                  severity: "warning",
                  resource: "vms",
                  operation: "guest_agent",
                  failureCategory: "missing_data",
                  count: 1
                }
              ])
            })
          })
        ]
      }
    });
    expect(response.body).not.toContain("private-manager-name");
    expect(response.body).not.toContain("private-manager.example");
    expect(response.body).not.toContain("private-vm");
    expect(response.body).not.toContain("private-snapshot");
    expect(response.body).not.toContain("private-host");
    expect(response.body).not.toContain("private-cluster");
    expect(response.body).not.toContain("private-password");
    expect(response.body).not.toContain("oVirt returned HTTP 404");
    expect(response.body).not.toContain('"message"');
    await app.close();
  });

  it("normalizes malformed issue resources before building fingerprints", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie);
    const payload = snapshot(managerId) as unknown as Omit<SnapshotPayload, "warnings" | "errors"> & {
      warnings: Array<{ resource?: string; message: unknown }>;
      errors: Array<{ resource?: string; message: unknown } | null>;
    };
    payload.warnings = [
      { resource: "private-resource-name", message: "private-warning-message" },
      { resource: "hosts", message: 404 }
    ];
    payload.errors = [
      { resource: "events", message: "Authentication failed for private-user with private-token" },
      null
    ];

    const saved = await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload });
    expect(saved.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        managers: [
          {
            latestInventoryRun: {
              warningCount: 1,
              errorCount: 1,
              issueFingerprints: [
                {
                  fingerprint: "error:events:resource_list:authentication",
                  resource: "events",
                  failureCategory: "authentication",
                  count: 1
                },
                {
                  fingerprint: "warning:general:collection:other",
                  resource: "general",
                  failureCategory: "other",
                  count: 1
                }
              ]
            }
          }
        ]
      }
    });
    expect(response.body).not.toContain("private-resource-name");
    expect(response.body).not.toContain("private-warning-message");
    expect(response.body).not.toContain("private-user");
    expect(response.body).not.toContain("private-token");
    await app.close();
  });

  it("classifies invalid host detail responses without exposing upstream details", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie);
    const payload = snapshot(managerId);
    payload.warnings = [];
    payload.errors = [{ resource: "hosts", message: "private-host certificate detail collection failed: oVirt returned an invalid resource response" }];

    const saved = await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload });
    expect(saved.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        managers: [
          {
            latestInventoryRun: {
              issueFingerprints: [
                {
                  fingerprint: "error:hosts:host_certificate_detail:invalid_response",
                  severity: "error",
                  resource: "hosts",
                  operation: "host_certificate_detail",
                  failureCategory: "invalid_response",
                  count: 1
                }
              ]
            }
          }
        ]
      }
    });
    expect(response.body).not.toContain("private-host");
    expect(response.body).not.toContain("invalid resource response");
    await app.close();
  });

  it("reports the latest failed collection without changing its status", async () => {
    const { app, cookie } = await authenticatedApp();
    const managerId = await createManager(app, cookie);
    const payload = snapshot(managerId);
    payload.status = "failed";
    payload.resources = emptyInventoryResources();
    payload.warnings = [];
    payload.errors = [{ resource: "dataCenters", message: "Authentication failed with HTTP 401 for private-user" }];

    const saved = await app.inject({ method: "POST", url: "/api/snapshots", cookies: cookie, payload });
    expect(saved.statusCode).toBe(201);

    const response = await app.inject({ method: "GET", url: "/api/diagnostics/snapshot-age", cookies: cookie });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      diagnostics: {
        managers: [
          {
            latestInventoryRun: {
              status: "failed",
              warningCount: 0,
              errorCount: 1,
              populatedResourceCount: 0,
              resourceStates: expect.arrayContaining([
                { resource: "dataCenters", recordCount: 0, state: "failed", warningCount: 0, errorCount: 1 }
              ]),
              issueFingerprints: [
                {
                  fingerprint: "error:dataCenters:resource_list:authentication",
                  severity: "error",
                  resource: "dataCenters",
                  operation: "resource_list",
                  failureCategory: "authentication",
                  httpStatusClass: "4xx",
                  count: 1
                }
              ]
            }
          }
        ]
      }
    });
    expect(response.body).not.toContain("private-user");
    await app.close();
  });
});
