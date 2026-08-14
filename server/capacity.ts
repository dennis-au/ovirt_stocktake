import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { ConnectablePostgres } from "./postgres/inventory.js";
import { requireRole, roles } from "./rbac.js";

export type CapacityRange = "24h" | "7d" | "30d" | "90d";
export type CapacityResourceType = "cluster" | "host" | "vm" | "storageDomain";

export interface CapacityScope {
  managerId?: string;
  clusterId?: string;
  hostId?: string;
  vmId?: string;
  storageDomainId?: string;
}

export interface CapacityResource extends CapacityScope {
  id: string;
  type: CapacityResourceType;
  name: string;
  managerName: string;
  clusterName?: string;
  hostName?: string;
  status?: string;
  vmCount?: number;
  cpuCapacity?: number;
  allocatedVcpu?: number;
  memoryCapacityGib?: number;
  allocatedMemoryGib?: number;
  storageTotalTib?: number;
  storageUsedTib?: number;
  storageProvisionedTib?: number;
}

export interface CapacitySample extends CapacityScope {
  timestamp: string;
  resourceType: "host" | "vm" | "storageDomain";
  resourceId: string;
  cpuPercent?: number;
  memoryPercent?: number;
  storagePercent?: number;
  networkReceiveMbps?: number;
  networkTransmitMbps?: number;
}

export interface CapacityDataset {
  metricsAvailable: boolean;
  generatedAt: string;
  expectedIntervalMinutes: number;
  resources: CapacityResource[];
  samples: CapacitySample[];
}

const rangeDurations: Record<CapacityRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000
};

const metricFields = {
  "cpu.usage.percent": "cpuPercent",
  "memory.usage.percent": "memoryPercent",
  "storage.used.percent": "storagePercent",
  "network.rx.mbps": "networkReceiveMbps",
  "network.tx.mbps": "networkTransmitMbps"
} as const;

type CapacityMetricName = keyof typeof metricFields;

export function registerCapacityRoutes(app: FastifyInstance, config: AppConfig, inventoryDb?: ConnectablePostgres): void {
  app.get("/api/capacity", { preHandler: requireRole(roles.read) }, async (request, reply) => {
    const parsed = parseCapacityQuery(request.query);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error });
    }
    return { capacity: await queryCapacityDataset(inventoryDb, config, parsed.value) };
  });
}

export async function queryCapacityDataset(
  inventoryDb: ConnectablePostgres | undefined,
  config: Pick<AppConfig, "collector">,
  query: { range?: CapacityRange; scope?: CapacityScope } = {}
): Promise<CapacityDataset> {
  const generatedAt = new Date().toISOString();
  const range = query.range ?? "30d";
  const scope = query.scope ?? {};
  if (!inventoryDb) {
    return {
      metricsAvailable: false,
      generatedAt,
      expectedIntervalMinutes: config.collector.metricsSyncMinutes,
      resources: [],
      samples: []
    };
  }

  const allResources = await loadCapacityResources(inventoryDb);
  const resources = allResources.filter((resource) => matchesScope(resource, scope));
  const resourceIndex = new Map(allResources.map((resource) => [resourceKey(resource.managerId, metricResourceType(resource.type), resource.id), resource]));
  const rows = await inventoryDb.query<MetricRow>(
    `
      SELECT manager_id, resource_type, resource_id, metric_name, sampled_at, value
      FROM metric_samples
      WHERE sampled_at >= $1
        AND metric_name IN (
          'cpu.usage.percent',
          'memory.usage.percent',
          'storage.used.percent',
          'network.rx.mbps',
          'network.tx.mbps'
        )
      ORDER BY sampled_at ASC
    `,
    [new Date(Date.parse(generatedAt) - rangeDurations[range]).toISOString()]
  );
  const samples = mapCapacitySamples(rows.rows, resourceIndex).filter((sample) => matchesScope(sample, scope));

  return {
    metricsAvailable: samples.length > 0,
    generatedAt,
    expectedIntervalMinutes: config.collector.metricsSyncMinutes,
    resources,
    samples
  };
}

interface CapacityQuery {
  range?: CapacityRange;
  scope: CapacityScope;
}

function parseCapacityQuery(query: unknown): { ok: true; value: CapacityQuery } | { ok: false; error: string } {
  const raw = query && typeof query === "object" ? (query as Record<string, unknown>) : {};
  const range = optionalQueryValue(raw.range);
  if (range && !isCapacityRange(range)) {
    return { ok: false, error: "range must be one of 24h, 7d, 30d, or 90d" };
  }
  return {
    ok: true,
    value: {
      range: range as CapacityRange | undefined,
      scope: {
        managerId: optionalQueryValue(raw.managerId),
        clusterId: optionalQueryValue(raw.clusterId),
        hostId: optionalQueryValue(raw.hostId),
        vmId: optionalQueryValue(raw.vmId),
        storageDomainId: optionalQueryValue(raw.storageDomainId)
      }
    }
  };
}

function isCapacityRange(value: string): value is CapacityRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "90d";
}

function optionalQueryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface ManagerRow {
  id: string;
  name: string;
}

interface ClusterRow {
  manager_id: string;
  cluster_id: string;
  name: string;
  status?: string;
}

interface HostRow {
  manager_id: string;
  host_id: string;
  cluster_id?: string;
  name: string;
  status?: string;
  raw_json?: unknown;
}

interface VmRow {
  manager_id: string;
  vm_id: string;
  name: string;
  status?: string;
  cluster_id?: string;
  cluster_name?: string;
  host_id?: string;
  host_name?: string;
  vcpus?: number | string;
  memory_mb?: number | string;
}

interface StorageDomainRow {
  manager_id: string;
  storage_domain_id: string;
  name: string;
  status?: string;
  total_bytes?: number | string;
  used_bytes?: number | string;
}

interface MetricRow {
  manager_id: string;
  resource_type: "host" | "vm" | "storage_domain";
  resource_id: string;
  metric_name: string;
  sampled_at: string | Date;
  value: number | string;
}

async function loadCapacityResources(inventoryDb: ConnectablePostgres): Promise<CapacityResource[]> {
  const [managersResult, clustersResult, hostsResult, vmsResult, storageDomainsResult] = await Promise.all([
    inventoryDb.query<ManagerRow>("SELECT id, name FROM managers"),
    inventoryDb.query<ClusterRow>("SELECT manager_id, cluster_id, name FROM clusters"),
    inventoryDb.query<HostRow>("SELECT manager_id, host_id, cluster_id, name, status, raw_json FROM hosts"),
    inventoryDb.query<VmRow>(
      "SELECT manager_id, vm_id, name, status, cluster_id, cluster_name, host_id, host_name, vcpus, memory_mb FROM vms"
    ),
    inventoryDb.query<StorageDomainRow>(
      "SELECT manager_id, storage_domain_id, name, status, total_bytes, used_bytes FROM storage_domains"
    )
  ]);
  const managerNames = new Map(managersResult.rows.map((manager) => [manager.id, manager.name]));
  const clusterNames = new Map(clustersResult.rows.map((cluster) => [resourceKey(cluster.manager_id, "cluster", cluster.cluster_id), cluster.name]));
  const vmsByHost = groupBy(vmsResult.rows, (vm) => (vm.host_id ? resourceKey(vm.manager_id, "host", vm.host_id) : undefined));
  const vmsByCluster = groupBy(vmsResult.rows, (vm) => (vm.cluster_id ? resourceKey(vm.manager_id, "cluster", vm.cluster_id) : undefined));
  const hostsByCluster = groupBy(hostsResult.rows, (host) => (host.cluster_id ? resourceKey(host.manager_id, "cluster", host.cluster_id) : undefined));

  const clusters: CapacityResource[] = clustersResult.rows.map((cluster) => {
    const hosts = hostsByCluster.get(resourceKey(cluster.manager_id, "cluster", cluster.cluster_id)) ?? [];
    const vms = vmsByCluster.get(resourceKey(cluster.manager_id, "cluster", cluster.cluster_id)) ?? [];
    return {
      id: cluster.cluster_id,
      type: "cluster",
      name: cluster.name,
      managerId: cluster.manager_id,
      managerName: managerNames.get(cluster.manager_id) ?? cluster.manager_id,
      clusterId: cluster.cluster_id,
      clusterName: cluster.name,
      status: cluster.status,
      vmCount: vms.length,
      cpuCapacity: sumOptional(hosts.map((host) => hostCpuCapacity(host.raw_json))),
      allocatedVcpu: sumOptional(vms.map((vm) => numberValue(vm.vcpus))),
      memoryCapacityGib: bytesToGib(sumOptional(hosts.map((host) => hostMemoryBytes(host.raw_json)))),
      allocatedMemoryGib: mibToGib(sumOptional(vms.map((vm) => numberValue(vm.memory_mb))))
    };
  });

  const hosts: CapacityResource[] = hostsResult.rows.map((host) => {
    const vms = vmsByHost.get(resourceKey(host.manager_id, "host", host.host_id)) ?? [];
    const clusterName = host.cluster_id ? clusterNames.get(resourceKey(host.manager_id, "cluster", host.cluster_id)) : undefined;
    return {
      id: host.host_id,
      type: "host",
      name: host.name,
      managerId: host.manager_id,
      managerName: managerNames.get(host.manager_id) ?? host.manager_id,
      clusterId: host.cluster_id,
      clusterName,
      hostId: host.host_id,
      hostName: host.name,
      status: host.status,
      vmCount: vms.length,
      cpuCapacity: hostCpuCapacity(host.raw_json),
      allocatedVcpu: sumOptional(vms.map((vm) => numberValue(vm.vcpus))),
      memoryCapacityGib: bytesToGib(hostMemoryBytes(host.raw_json)),
      allocatedMemoryGib: mibToGib(sumOptional(vms.map((vm) => numberValue(vm.memory_mb))))
    };
  });

  const vms: CapacityResource[] = vmsResult.rows.map((vm) => ({
    id: vm.vm_id,
    type: "vm",
    name: vm.name,
    managerId: vm.manager_id,
    managerName: managerNames.get(vm.manager_id) ?? vm.manager_id,
    clusterId: vm.cluster_id,
    clusterName: vm.cluster_name ?? (vm.cluster_id ? clusterNames.get(resourceKey(vm.manager_id, "cluster", vm.cluster_id)) : undefined),
    hostId: vm.host_id,
    hostName: vm.host_name,
    vmId: vm.vm_id,
    status: vm.status,
    cpuCapacity: numberValue(vm.vcpus),
    allocatedVcpu: numberValue(vm.vcpus),
    memoryCapacityGib: mibToGib(numberValue(vm.memory_mb)),
    allocatedMemoryGib: mibToGib(numberValue(vm.memory_mb))
  }));

  const storageDomains: CapacityResource[] = storageDomainsResult.rows.map((storageDomain) => ({
    id: storageDomain.storage_domain_id,
    type: "storageDomain",
    name: storageDomain.name,
    managerId: storageDomain.manager_id,
    managerName: managerNames.get(storageDomain.manager_id) ?? storageDomain.manager_id,
    storageDomainId: storageDomain.storage_domain_id,
    status: storageDomain.status,
    storageTotalTib: bytesToTib(numberValue(storageDomain.total_bytes)),
    storageUsedTib: bytesToTib(numberValue(storageDomain.used_bytes))
  }));

  return [...clusters, ...hosts, ...vms, ...storageDomains];
}

function mapCapacitySamples(rows: MetricRow[], resourceIndex: Map<string, CapacityResource>): CapacitySample[] {
  const samples = new Map<string, CapacitySample>();
  for (const row of rows) {
    if (!isCapacityMetricName(row.metric_name)) {
      continue;
    }
    const resource = resourceIndex.get(resourceKey(row.manager_id, row.resource_type, row.resource_id));
    const value = numberValue(row.value);
    if (!resource || value === undefined) {
      continue;
    }
    const timestamp = new Date(row.sampled_at).toISOString();
    const key = `${resourceKey(row.manager_id, row.resource_type, row.resource_id)}:${timestamp}`;
    const sample = samples.get(key) ?? {
      timestamp,
      resourceType: sampleResourceType(row.resource_type),
      resourceId: row.resource_id,
      managerId: resource.managerId,
      clusterId: resource.clusterId,
      hostId: resource.hostId,
      vmId: resource.vmId,
      storageDomainId: resource.storageDomainId
    };
    sample[metricFields[row.metric_name]] = value;
    samples.set(key, sample);
  }
  return [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function isCapacityMetricName(value: string): value is CapacityMetricName {
  return value in metricFields;
}

function metricResourceType(type: CapacityResourceType): "host" | "vm" | "storage_domain" | "cluster" {
  return type === "storageDomain" ? "storage_domain" : type;
}

function sampleResourceType(type: MetricRow["resource_type"]): CapacitySample["resourceType"] {
  return type === "storage_domain" ? "storageDomain" : type;
}

function matchesScope(value: CapacityScope, scope: CapacityScope): boolean {
  return (
    (!scope.managerId || value.managerId === scope.managerId) &&
    (!scope.clusterId || value.clusterId === scope.clusterId) &&
    (!scope.hostId || value.hostId === scope.hostId) &&
    (!scope.vmId || value.vmId === scope.vmId) &&
    (!scope.storageDomainId || value.storageDomainId === scope.storageDomainId)
  );
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = key(item);
    if (!group) {
      continue;
    }
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return groups;
}

function resourceKey(managerId: string | undefined, resourceType: string, resourceId: string): string {
  return `${managerId ?? ""}:${resourceType}:${resourceId}`;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
}

function mibToGib(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1024;
}

function bytesToGib(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1024 / 1024 / 1024;
}

function bytesToTib(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1024 / 1024 / 1024 / 1024;
}

function hostCpuCapacity(raw: unknown): number | undefined {
  const topology = recordValue(recordValue(raw)?.cpu)?.topology;
  const sockets = numberValue(recordValue(topology)?.sockets);
  const cores = numberValue(recordValue(topology)?.cores);
  const threads = numberValue(recordValue(topology)?.threads);
  return sockets && cores && threads ? sockets * cores * threads : undefined;
}

function hostMemoryBytes(raw: unknown): number | undefined {
  return numberValue(recordValue(raw)?.memory);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return recordValue(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
