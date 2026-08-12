export const resourceKeys = [
  "dataCenters",
  "clusters",
  "hosts",
  "vms",
  "storageDomains",
  "disks",
  "networks",
  "vnicProfiles",
  "tags",
  "vmSnapshots",
  "affinityGroups",
  "events"
] as const;

export type ResourceKey = (typeof resourceKeys)[number];

export type InventoryResource = Record<string, unknown>;

export type InventoryResources = Record<ResourceKey, InventoryResource[]>;

export function emptyInventoryResources(): InventoryResources {
  return Object.fromEntries(resourceKeys.map((key) => [key, []])) as unknown as InventoryResources;
}

export type SnapshotStatus = "success" | "partial" | "failed";

export interface CollectionIssue {
  resource?: ResourceKey;
  message: string;
}

export interface SnapshotPayload {
  managerId: string;
  managerName: string;
  managerUrl: string;
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  resources: InventoryResources;
  warnings: CollectionIssue[];
  errors: CollectionIssue[];
}
