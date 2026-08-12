import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import {
  emptyInventoryResources,
  resourceKeys,
  type CollectionIssue,
  type InventoryResource,
  type InventoryResources,
  type ResourceKey,
  type SnapshotPayload
} from "../shared/snapshot.js";

export interface OvirtCollectionTarget {
  managerId: string;
  managerName: string;
  managerUrl: string;
  username: string;
  password: string;
}

export interface OvirtCollectorOptions {
  fetchImpl?: typeof fetch;
  allowInsecureTls?: boolean;
}

interface ResourceSpec {
  key: ResourceKey;
  path: string;
  itemKey: string;
  follow?: string;
}

interface OvirtRequestInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

const PAGE_SIZE = 1000;

const topLevelResources: ResourceSpec[] = [
  { key: "dataCenters", path: "datacenters", itemKey: "data_center" },
  { key: "clusters", path: "clusters", itemKey: "cluster" },
  { key: "hosts", path: "hosts", itemKey: "host" },
  { key: "vms", path: "vms", itemKey: "vm", follow: "nics,nics.reporteddevices,diskattachments,diskattachments.disk,tags" },
  { key: "storageDomains", path: "storagedomains", itemKey: "storage_domain" },
  { key: "disks", path: "disks", itemKey: "disk" },
  { key: "networks", path: "networks", itemKey: "network" },
  { key: "vnicProfiles", path: "vnicprofiles", itemKey: "vnic_profile" },
  { key: "tags", path: "tags", itemKey: "tag" },
  { key: "events", path: "events", itemKey: "event" }
];

export async function collectOvirtSnapshot(target: OvirtCollectionTarget, options: OvirtCollectorOptions = {}): Promise<SnapshotPayload> {
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const inventory = emptyResources();
  const warnings: CollectionIssue[] = [];
  const errors: CollectionIssue[] = [];
  let apiVersion = "unknown";
  let authorization: string;

  try {
    authorization = `Bearer ${await requestAccessToken(fetchImpl, target, options)}`;
  } catch (error) {
    return {
      managerId: target.managerId,
      managerName: target.managerName,
      managerUrl: target.managerUrl,
      collectedAt: new Date(startedAt).toISOString(),
      apiVersion,
      durationMs: Date.now() - startedAt,
      status: "failed",
      resources: inventory,
      warnings,
      errors: [{ message: error instanceof Error ? error.message : "Authentication failed" }]
    };
  }

  for (const resource of topLevelResources) {
    try {
      inventory[resource.key] = await listResource(fetchImpl, target.managerUrl, resource, authorization, options);
    } catch (error) {
      errors.push({
        resource: resource.key,
        message: error instanceof Error ? error.message : "Collection failed"
      });
    }
  }

  inventory.vmSnapshots = await collectChildResources(fetchImpl, target.managerUrl, inventory.vms, "vmSnapshots", "snapshots", "snapshot", authorization, options, errors);
  inventory.affinityGroups = await collectChildResources(
    fetchImpl,
    target.managerUrl,
    inventory.clusters,
    "affinityGroups",
    "affinitygroups",
    "affinity_group",
    authorization,
    options,
    errors
  );
  appendGuestAgentWarnings(inventory, warnings);

  if (inventory.clusters.length > 0) {
    const version = inventory.clusters[0]?.version;
    if (typeof version === "object" && version && "major" in version && "minor" in version) {
      apiVersion = `${String((version as { major?: unknown }).major ?? "unknown")}.${String(
        (version as { minor?: unknown }).minor ?? "unknown"
      )}`;
    }
  }

  const populatedResourceCount = resourceKeys.filter((key) => inventory[key].length > 0).length;
  const status = errors.length === 0 ? "success" : populatedResourceCount > 0 ? "partial" : "failed";

  return {
    managerId: target.managerId,
    managerName: target.managerName,
    managerUrl: target.managerUrl,
    collectedAt: new Date(startedAt).toISOString(),
    apiVersion,
    durationMs: Date.now() - startedAt,
    status,
    resources: inventory,
    warnings,
    errors
  };
}

export function ovirtApiBase(managerUrl: string): string {
  const trimmed = managerUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/ovirt-engine/api")) {
    return trimmed;
  }
  if (trimmed.endsWith("/ovirt-engine")) {
    return `${trimmed}/api`;
  }
  return `${trimmed}/ovirt-engine/api`;
}

export function ovirtTokenUrl(managerUrl: string): string {
  return `${ovirtApiBase(managerUrl).replace(/\/api$/, "")}/sso/oauth/token`;
}

async function requestAccessToken(fetchImpl: typeof fetch, target: OvirtCollectionTarget, options: OvirtCollectorOptions): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "password",
    scope: "ovirt-app-api",
    username: target.username,
    password: target.password
  });

  const payload = await getJson(fetchImpl, new URL(ovirtTokenUrl(target.managerUrl)), options, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  if (!payload || typeof payload !== "object" || typeof (payload as { access_token?: unknown }).access_token !== "string") {
    throw new Error("oVirt returned an invalid authentication response");
  }
  return (payload as { access_token: string }).access_token;
}

async function listResource(
  fetchImpl: typeof fetch,
  managerUrl: string,
  resource: ResourceSpec,
  authorization: string,
  options: OvirtCollectorOptions
): Promise<InventoryResource[]> {
  return listResourcePath(fetchImpl, managerUrl, resource.path, resource.itemKey, authorization, options, resource.follow);
}

async function listResourcePath(
  fetchImpl: typeof fetch,
  managerUrl: string,
  path: string,
  itemKey: string,
  authorization: string,
  options: OvirtCollectorOptions,
  follow?: string
): Promise<InventoryResource[]> {
  const result: InventoryResource[] = [];
  const seen = new Set<string>();
  let page = 1;

  while (true) {
    const url = new URL(`${ovirtApiBase(managerUrl)}/${path}`);
    url.searchParams.set("max", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    if (follow) {
      url.searchParams.set("follow", follow);
    }

    const payload = await getJson(fetchImpl, url, options, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization
      }
    });
    const rows = collectionItems(payload, itemKey);
    if (rows.length === 0) {
      return result;
    }

    let added = false;
    for (const row of rows) {
      const stableId = typeof row.id === "string" ? row.id : JSON.stringify(row);
      if (!seen.has(stableId)) {
        seen.add(stableId);
        result.push(row);
        added = true;
      }
    }

    if (rows.length < PAGE_SIZE || !added) {
      return result;
    }
    page += 1;
  }
}

async function collectChildResources(
  fetchImpl: typeof fetch,
  managerUrl: string,
  parents: InventoryResource[],
  key: ResourceKey,
  childPath: string,
  itemKey: string,
  authorization: string,
  options: OvirtCollectorOptions,
  errors: CollectionIssue[]
): Promise<InventoryResource[]> {
  const result: InventoryResource[] = [];
  const parentSegment = key === "vmSnapshots" ? "vms" : "clusters";

  for (const parent of parents) {
    if (typeof parent.id !== "string" || !parent.id) {
      continue;
    }

    try {
      const rows = await listResourcePath(
        fetchImpl,
        managerUrl,
        `${parentSegment}/${encodeURIComponent(parent.id)}/${childPath}`,
        itemKey,
        authorization,
        options
      );
      result.push(...rows.map((row) => withParentReference(row, parentSegment === "vms" ? "vm" : "cluster", parent)));
    } catch (error) {
      errors.push({
        resource: key,
        message: `${displayName(parent)} ${childPath} collection failed: ${error instanceof Error ? error.message : "Collection failed"}`
      });
    }
  }

  return result;
}

async function getJson(fetchImpl: typeof fetch, url: URL, options: OvirtCollectorOptions, init: OvirtRequestInit): Promise<unknown> {
  if (!options.fetchImpl && options.allowInsecureTls) {
    return requestJson(url, init, false);
  }

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), init);
  } catch {
    throw new Error("Network or TLS failure while contacting oVirt Manager");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Authentication failed with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`oVirt returned HTTP ${response.status}`);
  }

  return response.json();
}

async function requestJson(url: URL, init: OvirtRequestInit, rejectUnauthorized: boolean): Promise<unknown> {
  const response = await new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
    const body = init.body ? Buffer.from(init.body, "utf8") : undefined;
    const requestOptions: HttpsRequestOptions = {
      method: init.method,
      headers: {
        ...init.headers,
        ...(body ? { "Content-Length": String(body.length) } : {})
      }
    };

    if (url.protocol === "https:") {
      requestOptions.rejectUnauthorized = rejectUnauthorized;
    }

    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, requestOptions, (message) => {
      const chunks: Buffer[] = [];
      message.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      message.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          statusCode: message.statusCode ?? 0
        });
      });
    });

    request.setTimeout(30_000, () => {
      request.destroy(new Error("oVirt request timed out"));
    });
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  }).catch(() => {
    throw new Error("Network or TLS failure while contacting oVirt Manager");
  });

  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new Error(`Authentication failed with HTTP ${response.statusCode}`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`oVirt returned HTTP ${response.statusCode}`);
  }

  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("oVirt returned an invalid JSON response");
  }
}

function collectionItems(payload: unknown, itemKey: string): InventoryResource[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("oVirt returned an invalid collection response");
  }

  const value = (payload as Record<string, unknown>)[itemKey];
  if (Array.isArray(value)) {
    return value.filter(isResource);
  }
  if (isResource(value)) {
    return [value];
  }
  if (value === undefined) {
    return [];
  }

  throw new Error("oVirt returned an invalid collection response");
}

function isResource(value: unknown): value is InventoryResource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function emptyResources(): InventoryResources {
  return emptyInventoryResources();
}

function withParentReference(row: InventoryResource, parentKey: "cluster" | "vm", parent: InventoryResource): InventoryResource {
  return {
    ...row,
    [parentKey]: {
      id: parent.id,
      name: typeof parent.name === "string" ? parent.name : undefined
    }
  };
}

function appendGuestAgentWarnings(inventory: InventoryResources, warnings: CollectionIssue[]): void {
  for (const vm of inventory.vms) {
    if (vm.status !== "up" || hasGuestAgentData(vm)) {
      continue;
    }
    warnings.push({
      resource: "vms",
      message: `${displayName(vm)} has no guest-agent data`
    });
  }
}

function hasGuestAgentData(vm: InventoryResource): boolean {
  return Boolean(vm.guest_info || vm.guestInfo || vm.fqdn || vm.hostname || vm.reported_devices);
}

function displayName(resource: InventoryResource): string {
  if (typeof resource.name === "string" && resource.name) {
    return resource.name;
  }
  if (typeof resource.id === "string" && resource.id) {
    return resource.id;
  }
  return "resource";
}
