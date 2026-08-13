import type { InventoryResources, SnapshotPayload, SnapshotStatus } from "../../shared/snapshot";

export interface HealthResponse {
  ok: boolean;
  service: string;
  database: {
    ok: boolean;
    schemaVersion: string;
  };
}

export interface SessionResponse {
  authenticated: boolean;
  user?: {
    username: string;
    role?: "admin" | "operator" | "viewer";
  };
  expiresAt?: string;
}

export interface Manager {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  ignoreTls: boolean;
  credentialStatus: "saved";
  createdAt: string;
  updatedAt: string;
}

export interface ManagerInput {
  name?: string;
  url?: string;
  enabled?: boolean;
  ignoreTls?: boolean;
  username?: string;
  password?: string;
}

export interface ManagerTestCollectionInput extends ManagerInput {
  managerId?: string;
}

export interface ManagerTestCollectionResult {
  managerName: string;
  managerUrl: string;
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  resourceCounts: Record<keyof InventoryResources, number>;
  warningsCount: number;
  errorsCount: number;
  warnings: SnapshotPayload["warnings"];
  errors: SnapshotPayload["errors"];
}

export interface SnapshotSummary {
  id: string;
  managerId: string;
  managerName: string;
  managerUrl: string;
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  resourceCounts: Record<keyof InventoryResources, number>;
  warningsCount: number;
  errorsCount: number;
  createdAt: string;
}

export interface SnapshotDetail extends SnapshotSummary {
  resources: InventoryResources;
  warnings: SnapshotPayload["warnings"];
  errors: SnapshotPayload["errors"];
}

export interface DashboardResponse {
  totals: {
    managers: number;
    clusters: number;
    hosts: number;
    vms: number;
    storageDomains: number;
    disks: number;
    networks: number;
  };
  clusters: DashboardClusterSummary[];
  vmStatuses: Record<string, number>;
  hostStatuses: Record<string, number>;
  managers: Array<{
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    lastSnapshotId?: string;
    latestInventorySnapshotId?: string;
    freshness?: string;
    lastStatus?: SnapshotStatus;
    resourceCounts: Record<keyof InventoryResources, number>;
    warningsCount: number;
    errorsCount: number;
  }>;
}

export interface DashboardClusterSummary {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  clusterId: string;
  name: string;
  dataCenterId?: string;
  dataCenterName?: string;
  version?: string;
  cpuType?: string;
  hostCount: number;
  vmCount: number;
  storageDomainCount: number;
}

export interface DashboardClusterDetail extends DashboardClusterSummary {
  vms: DashboardClusterVm[];
}

export interface DashboardClusterVm {
  vmId: string;
  name: string;
  environment?: string;
  powerState?: string;
  host?: string;
  guestOs?: string;
  ipAddress?: string;
  vcpuCount?: number;
  allocatedRamMiB?: number;
  storageAllocatedGiB?: number;
  storageUsedGiB?: number;
}

export interface SnapshotVmInventoryRow {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  dataCenterId?: string;
  dataCenterName?: string;
  clusterId?: string;
  clusterName?: string;
  vmId: string;
  name: string;
  environment?: string;
  powerState?: string;
  host?: string;
  guestOs?: string;
  ipAddress?: string;
  ipAddresses?: string[];
  vcpuCount?: number;
  allocatedRamMiB?: number;
  storageAllocatedGiB?: number;
  storageUsedGiB?: number;
  snapshotNames: string[];
}

export interface SnapshotVmInventoryResponse {
  rows: SnapshotVmInventoryRow[];
  page: number;
  pageSize: number;
  total: number;
  filters: SnapshotVmInventoryFilters;
  filterOptions: {
    managers: Array<{ value: string; label: string }>;
    clusters: Array<{ value: string; label: string }>;
    powerStates: string[];
    environments: string[];
  };
}

export interface SnapshotVmInventoryFilters {
  search?: string;
  managerId?: string;
  clusterId?: string;
  powerState?: string;
  environment?: string;
  sortBy?: SnapshotVmInventorySortKey;
  sortDirection?: SnapshotVmInventorySortDirection;
  page?: number;
  pageSize?: number;
}

export type SnapshotVmInventorySortKey =
  | "managerName"
  | "clusterName"
  | "name"
  | "powerState"
  | "host"
  | "guestOs"
  | "ipAddress"
  | "vcpuCount"
  | "allocatedRamMiB"
  | "storageAllocatedGiB"
  | "storageUsedGiB"
  | "collectedAt";

export type SnapshotVmInventorySortDirection = "asc" | "desc";

export interface RelationshipRow {
  managerId: string;
  managerName: string;
  managerUrl: string;
  snapshotId: string;
  collectedAt: string;
  clusterId?: string;
  clusterName?: string;
  hostId?: string;
  hostName?: string;
  vmId?: string;
  vmName?: string;
}

export interface RelationshipResponse {
  rows: RelationshipRow[];
  total: number;
}

export interface SavedView {
  id: string;
  ownerUsername: string;
  name: string;
  scope: string;
  filters: Record<string, unknown>;
  columns: string[];
  sort: Record<string, unknown>;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewInput {
  name?: string;
  scope?: string;
  filters?: Record<string, unknown>;
  columns?: string[];
  sort?: Record<string, unknown>;
  visibility?: "private" | "shared";
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<HealthResponse>;
}

export async function getSession(): Promise<SessionResponse> {
  const response = await fetch("/api/session");
  if (!response.ok) {
    throw new Error(`Session check failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<SessionResponse>;
}

export async function login(username: string, password: string): Promise<SessionResponse> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Login failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<SessionResponse>;
}

export async function logout(): Promise<SessionResponse> {
  const response = await fetch("/api/logout", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Logout failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<SessionResponse>;
}

export async function listManagers(): Promise<Manager[]> {
  const response = await fetch("/api/managers");
  if (!response.ok) {
    throw new Error(`Manager list failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { managers: Manager[] };
  return body.managers;
}

export async function createManager(input: Required<Pick<ManagerInput, "name" | "url" | "username" | "password">> & ManagerInput): Promise<Manager> {
  const response = await fetch("/api/managers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return managerFromResponse(response);
}

export async function updateManager(id: string, input: ManagerInput): Promise<Manager> {
  const response = await fetch(`/api/managers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  return managerFromResponse(response);
}

export async function deleteManager(id: string): Promise<void> {
  const response = await fetch(`/api/managers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Manager delete failed with HTTP ${response.status}`);
  }
}

export async function testManagerCollection(input: ManagerTestCollectionInput): Promise<ManagerTestCollectionResult> {
  const response = await fetch("/api/managers/test-collection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = (await response.json().catch(() => undefined)) as { result?: ManagerTestCollectionResult; error?: string } | undefined;
  if (!response.ok || !body?.result) {
    throw new Error(body?.error ?? `Manager test collection failed with HTTP ${response.status}`);
  }
  return body.result;
}

export async function collectManager(id: string): Promise<SnapshotDetail> {
  const response = await fetch(`/api/managers/${encodeURIComponent(id)}/collect`, { method: "POST" });
  return snapshotFromResponse(response);
}

export async function collectAllManagers(): Promise<SnapshotDetail[]> {
  const response = await fetch("/api/collect", { method: "POST" });
  const body = (await response.json().catch(() => undefined)) as { snapshots?: SnapshotDetail[]; error?: string } | undefined;
  if (!response.ok || !body?.snapshots) {
    throw new Error(body?.error ?? `Collection request failed with HTTP ${response.status}`);
  }
  return body.snapshots;
}

export async function listSnapshots(managerId?: string): Promise<SnapshotSummary[]> {
  const query = managerId ? `?managerId=${encodeURIComponent(managerId)}` : "";
  const response = await fetch(`/api/snapshots${query}`);
  if (!response.ok) {
    throw new Error(`Snapshot list failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { snapshots: SnapshotSummary[] };
  return body.snapshots;
}

export async function getSnapshot(id: string): Promise<SnapshotDetail> {
  const response = await fetch(`/api/snapshots/${encodeURIComponent(id)}`);
  return snapshotFromResponse(response);
}

export async function getDashboard(): Promise<DashboardResponse> {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    throw new Error(`Dashboard request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<DashboardResponse>;
}

export async function getDashboardCluster(managerId: string, clusterId: string): Promise<DashboardClusterDetail> {
  const response = await fetch(`/api/dashboard/clusters/${encodeURIComponent(managerId)}/${encodeURIComponent(clusterId)}`);
  const body = (await response.json().catch(() => undefined)) as { cluster?: DashboardClusterDetail; error?: string } | undefined;
  if (!response.ok || !body?.cluster) {
    throw new Error(body?.error ?? `Cluster detail request failed with HTTP ${response.status}`);
  }
  return body.cluster;
}

export async function getSnapshotVmInventory(filters: SnapshotVmInventoryFilters = {}): Promise<SnapshotVmInventoryResponse> {
  const response = await fetch(`/api/inventory/snapshot-vms${queryString(filters)}`);
  const body = (await response.json().catch(() => undefined)) as { inventory?: SnapshotVmInventoryResponse; error?: string } | undefined;
  if (!response.ok || !body?.inventory) {
    throw new Error(body?.error ?? `Inventory request failed with HTTP ${response.status}`);
  }
  return body.inventory;
}

export function snapshotVmInventoryExportUrl(format: "csv" | "pdf", filters: SnapshotVmInventoryFilters = {}): string {
  return `/api/exports/snapshot-vms${queryString({ ...filters, format })}`;
}

export async function getRelationships(): Promise<RelationshipResponse> {
  const response = await fetch("/api/inventory/relationships");
  const body = (await response.json().catch(() => undefined)) as { relationships?: RelationshipResponse; error?: string } | undefined;
  if (!response.ok || !body?.relationships) {
    throw new Error(body?.error ?? `Relationships request failed with HTTP ${response.status}`);
  }
  return body.relationships;
}

export function relationshipsExportUrl(): string {
  return "/api/exports/relationships";
}

export async function listSavedViews(scope: string): Promise<SavedView[]> {
  const response = await fetch(`/api/saved-views${queryString({ scope })}`);
  const body = (await response.json().catch(() => undefined)) as { savedViews?: SavedView[]; error?: string } | undefined;
  if (!response.ok || !body?.savedViews) {
    throw new Error(body?.error ?? `Saved views request failed with HTTP ${response.status}`);
  }
  return body.savedViews;
}

export async function createSavedView(input: SavedViewInput): Promise<SavedView> {
  return savedViewFromResponse(
    await fetch("/api/saved-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    })
  );
}

export async function updateSavedView(id: string, input: SavedViewInput): Promise<SavedView> {
  return savedViewFromResponse(
    await fetch(`/api/saved-views/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    })
  );
}

async function snapshotFromResponse(response: Response): Promise<SnapshotDetail> {
  const body = (await response.json().catch(() => undefined)) as { snapshot?: SnapshotDetail; error?: string } | undefined;
  if (!response.ok || !body?.snapshot) {
    throw new Error(body?.error ?? `Snapshot request failed with HTTP ${response.status}`);
  }
  return body.snapshot;
}

async function managerFromResponse(response: Response): Promise<Manager> {
  const body = (await response.json().catch(() => undefined)) as { manager?: Manager; error?: string } | undefined;
  if (!response.ok || !body?.manager) {
    throw new Error(body?.error ?? `Manager request failed with HTTP ${response.status}`);
  }
  return body.manager;
}

async function savedViewFromResponse(response: Response): Promise<SavedView> {
  const body = (await response.json().catch(() => undefined)) as { savedView?: SavedView; error?: string } | undefined;
  if (!response.ok || !body?.savedView) {
    throw new Error(body?.error ?? `Saved view request failed with HTTP ${response.status}`);
  }
  return body.savedView;
}

function queryString(values: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "" && value !== null) {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
