export type CapacityRange = "24h" | "7d" | "30d" | "90d";
export type CapacityResourceType = "cluster" | "host" | "vm" | "storageDomain";
export type CapacityResourceTab = "clusters" | "hosts" | "vms" | "storageDomains";

export interface CapacityScope {
  managerId?: string;
  clusterId?: string;
  hostId?: string;
  vmId?: string;
  storageDomainId?: string;
}

export interface CapacitySample extends CapacityScope {
  timestamp: string;
  resourceType: "estate" | CapacityResourceType;
  resourceId: string;
  cpuPercent?: number;
  memoryPercent?: number;
  storagePercent?: number;
  networkReceiveMbps?: number;
  networkTransmitMbps?: number;
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

export interface CapacityDataset {
  metricsAvailable: boolean;
  generatedAt: string;
  expectedIntervalMinutes: number;
  resources: CapacityResource[];
  samples: CapacitySample[];
}

const rangeMilliseconds: Record<CapacityRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000
};

export function filterCapacitySamples(
  samples: CapacitySample[],
  range: CapacityRange,
  scope: CapacityScope,
  asOf = new Date().toISOString()
): CapacitySample[] {
  const end = Date.parse(asOf);
  const cutoff = end - rangeMilliseconds[range];
  return samples.filter((sample) => {
    const timestamp = Date.parse(sample.timestamp);
    return timestamp >= cutoff && timestamp <= end && matchesCapacityScope(sample, scope);
  });
}

export function matchesCapacityScope(value: CapacityScope, scope: CapacityScope): boolean {
  return (
    (!scope.managerId || value.managerId === scope.managerId) &&
    (!scope.clusterId || value.clusterId === scope.clusterId) &&
    (!scope.hostId || value.hostId === scope.hostId) &&
    (!scope.vmId || value.vmId === scope.vmId) &&
    (!scope.storageDomainId || value.storageDomainId === scope.storageDomainId)
  );
}

export function capacityPercentile(values: Array<number | undefined>, percentileRank: number): number | undefined {
  const sorted = values.filter((value): value is number => value !== undefined && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return undefined;
  }
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

export function capacityPeak(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return present.length ? Math.max(...present) : undefined;
}

export function capacityCoverage(values: Array<number | undefined>): number {
  if (values.length === 0) {
    return 0;
  }
  const present = values.filter((value) => value !== undefined && Number.isFinite(value)).length;
  return Math.round((present / values.length) * 1000) / 10;
}

export function capacityRatio(allocated: number | undefined, capacity: number | undefined): number | undefined {
  if (allocated === undefined || capacity === undefined || capacity <= 0) {
    return undefined;
  }
  return Math.round((allocated / capacity) * 100) / 100;
}

export function rangeDurationMilliseconds(range: CapacityRange): number {
  return rangeMilliseconds[range];
}

export function capacityTimeline(range: CapacityRange, asOf: string, intervalMinutes: number): string[] {
  const end = Date.parse(asOf);
  const interval = intervalMinutes * 60 * 1000;
  if (!Number.isFinite(end) || !Number.isFinite(interval) || interval <= 0) {
    return [];
  }
  const start = end - rangeMilliseconds[range];
  const timestamps: string[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += interval) {
    timestamps.push(new Date(timestamp).toISOString());
  }
  if (Date.parse(timestamps.at(-1) ?? "") !== end) {
    timestamps.push(new Date(end).toISOString());
  }
  return timestamps;
}
