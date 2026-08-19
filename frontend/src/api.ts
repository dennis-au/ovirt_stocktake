import type { InventoryResources, SnapshotPayload, SnapshotStatus } from "../../shared/snapshot";
import type { CapacityDataset } from "./capacity-model";

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

export type SnapshotDateFinding =
  | "all_snapshot_dates_available"
  | "no_inventory_snapshot"
  | "no_vm_snapshots"
  | "snapshot_dates_missing"
  | "snapshot_date_values_invalid"
  | "snapshot_detail_requests_failed"
  | "snapshot_detail_responses_missing_date"
  | "snapshot_list_requests_failed";

export type DiagnosticResource = keyof InventoryResources | "general";
export type ResourceCollectionState = "collected" | "empty" | "partial" | "failed";
export type DiagnosticIssueSeverity = "warning" | "error";
export type DiagnosticIssueOperation =
  | "resource_list"
  | "child_collection"
  | "snapshot_list"
  | "snapshot_detail"
  | "snapshot_date"
  | "guest_agent"
  | "collection";
export type DiagnosticFailureCategory = "authentication" | "network_tls" | "timeout" | "http_4xx" | "http_5xx" | "invalid_response" | "missing_data" | "other";

export interface DiagnosticResourceState {
  resource: keyof InventoryResources;
  recordCount: number;
  state: ResourceCollectionState;
  warningCount: number;
  errorCount: number;
}

export interface DiagnosticIssueFingerprint {
  fingerprint: string;
  severity: DiagnosticIssueSeverity;
  resource: DiagnosticResource;
  operation: DiagnosticIssueOperation;
  failureCategory: DiagnosticFailureCategory;
  httpStatusClass?: "4xx" | "5xx";
  count: number;
}

export interface SnapshotAgeDiagnosticRun {
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
  warningCount: number;
  errorCount: number;
  populatedResourceCount: number;
  totalResourceCount: number;
  resourceStates: DiagnosticResourceState[];
  issueFingerprints: DiagnosticIssueFingerprint[];
  regularSnapshotCount: number;
  activeSnapshotCount: number;
  validDateCount: number;
  missingDateCount: number;
  invalidDateCount: number;
  observedTemporalFields: Partial<Record<"date" | "creation_date" | "creationDate" | "created_at" | "createdAt" | "creation_time" | "creationTime", number>>;
  snapshotDateIssueCounts: {
    noCreationDate: number;
    detailCollectionFailed: number;
    listCollectionFailed: number;
    other: number;
  };
  findings: SnapshotDateFinding[];
}

export interface SnapshotAgeDiagnostics {
  reportVersion: 2;
  generatedAt: string;
  managerCount: number;
  managers: Array<{
    label: string;
    name: string;
    enabled: boolean;
    latestInventoryRun?: SnapshotAgeDiagnosticRun;
  }>;
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
  disks: DashboardClusterVmDisk[];
}

export interface DashboardClusterVmDisk {
  name: string;
  sizeGiB?: number;
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
  snapshotDetails?: SnapshotInventorySnapshot[];
}

export interface SnapshotInventorySnapshot {
  name: string;
  createdAt?: string;
  ageDays?: number;
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

export interface SnapshotHostInventoryRow {
  managerId: string;
  managerName: string;
  snapshotId: string;
  collectedAt: string;
  clusterId?: string;
  clusterName?: string;
  hostId: string;
  hostName: string;
  status?: string;
  hostOs?: string;
  vdsmVersion?: string;
  physicalCpuThreads?: number;
  physicalMemoryMiB?: number;
  hostedVmCount: number;
  allocatedVcpu?: number;
  allocatedRamMiB?: number;
}

export interface SnapshotHostInventoryResponse {
  rows: SnapshotHostInventoryRow[];
  page: number;
  pageSize: number;
  total: number;
  filters: SnapshotHostInventoryFilters;
  filterOptions: {
    managers: Array<{ value: string; label: string }>;
    clusters: Array<{ value: string; label: string }>;
  };
}

export interface SnapshotHostInventoryFilters {
  search?: string;
  managerId?: string;
  clusterId?: string;
  page?: number;
  pageSize?: number;
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
  powerState?: string;
  ipAddresses: string[];
  vcpuCount?: number;
  allocatedRamMiB?: number;
  virtualDisks: RelationshipVirtualDisk[];
  storageDomainNames: string[];
}

export interface RelationshipVirtualDisk {
  name: string;
  sizeGiB?: number;
}

export interface RelationshipResponse {
  rows: RelationshipRow[];
  total: number;
}

export type RelationshipColumnKey = keyof RelationshipRow;

export interface RelationshipExportScope {
  managerId?: string;
  clusterId?: string;
  hostId?: string;
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

export interface AppSettings {
  snapshotIntervalMinutes: number;
  snapshotRetentionDays: number;
  inventoryCollectionEnabled: boolean;
  metricsCollectionEnabled: boolean;
  metricsIntervalMinutes: number;
  collectorEnabled: boolean;
  updatedAt?: string;
}

export interface AppSettingsInput {
  snapshotIntervalMinutes: number;
  snapshotRetentionDays: number;
  inventoryCollectionEnabled: boolean;
  metricsCollectionEnabled: boolean;
  metricsIntervalMinutes: number;
}

export interface SchedulerStatus {
  backend: "postgres-reconciler";
  available: boolean;
  running: boolean;
  lastError?: string;
  lastErrorAt?: string;
  lastPolledAt?: string;
  lastSuccessfulPollAt?: string;
}

export interface SchedulerSchedule {
  jobType: "inventory" | "metrics";
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt?: string;
  lastQueuedAt?: string;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastResult?: "success" | "partial" | "failed";
  consecutiveFailures: number;
}

export interface SchedulerResponse {
  scheduler: SchedulerStatus;
  schedules: SchedulerSchedule[];
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

export async function getCapacity(): Promise<CapacityDataset> {
  const response = await fetch("/api/capacity");
  const body = (await response.json().catch(() => undefined)) as { capacity?: CapacityDataset; error?: string } | undefined;
  if (!response.ok || !body?.capacity) {
    throw new Error(body?.error ?? `Capacity request failed with HTTP ${response.status}`);
  }
  return body.capacity;
}

export async function getSettings(): Promise<AppSettings> {
  const response = await fetch("/api/settings");
  const body = (await response.json().catch(() => undefined)) as { settings?: AppSettings; error?: string } | undefined;
  if (!response.ok || !body?.settings) {
    throw new Error(body?.error ?? `Settings request failed with HTTP ${response.status}`);
  }
  return body.settings;
}

export async function updateSettings(input: AppSettingsInput): Promise<AppSettings> {
  const response = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const body = (await response.json().catch(() => undefined)) as { settings?: AppSettings; error?: string } | undefined;
  if (!response.ok || !body?.settings) {
    throw new Error(body?.error ?? `Settings update failed with HTTP ${response.status}`);
  }
  return body.settings;
}

export async function getScheduler(): Promise<SchedulerResponse> {
  const response = await fetch("/api/scheduler");
  const body = (await response.json().catch(() => undefined)) as SchedulerResponse | { error?: string } | undefined;
  if (!response.ok || !body || !("scheduler" in body)) {
    throw new Error((body && "error" in body && body.error) || `Scheduler request failed with HTTP ${response.status}`);
  }
  return body;
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

export async function collectAllManagers(): Promise<SnapshotSummary[]> {
  const response = await fetch("/api/collect", { method: "POST" });
  const body = (await response.json().catch(() => undefined)) as { snapshots?: SnapshotSummary[]; error?: string } | undefined;
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

export async function getSnapshotAgeDiagnostics(): Promise<SnapshotAgeDiagnostics> {
  const response = await fetch("/api/diagnostics/snapshot-age");
  const body = (await response.json().catch(() => undefined)) as { diagnostics?: SnapshotAgeDiagnostics; error?: string } | undefined;
  if (!response.ok || !body?.diagnostics) {
    throw new Error(body?.error ?? `Diagnostics request failed with HTTP ${response.status}`);
  }
  return body.diagnostics;
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

export async function getSnapshotHostInventory(filters: SnapshotHostInventoryFilters = {}): Promise<SnapshotHostInventoryResponse> {
  const response = await fetch(`/api/inventory/snapshot-hosts${queryString(filters)}`);
  const body = (await response.json().catch(() => undefined)) as { inventory?: SnapshotHostInventoryResponse; error?: string } | undefined;
  if (!response.ok || !body?.inventory) {
    throw new Error(body?.error ?? `Hardware inventory request failed with HTTP ${response.status}`);
  }
  return body.inventory;
}

export function snapshotVmInventoryExportUrl(format: "csv" | "pdf", filters: SnapshotVmInventoryFilters = {}): string {
  return `/api/exports/snapshot-vms${queryString({ ...filters, format })}`;
}

export function snapshotHostInventoryExportUrl(format: "csv" | "pdf", filters: SnapshotHostInventoryFilters = {}): string {
  return `/api/exports/snapshot-hosts${queryString({ ...filters, format })}`;
}

export async function getRelationships(): Promise<RelationshipResponse> {
  const response = await fetch("/api/inventory/relationships");
  const body = (await response.json().catch(() => undefined)) as { relationships?: RelationshipResponse; error?: string } | undefined;
  if (!response.ok || !body?.relationships) {
    throw new Error(body?.error ?? `Relationships request failed with HTTP ${response.status}`);
  }
  return body.relationships;
}

export function relationshipsExportUrl(columns?: RelationshipColumnKey[], scope: RelationshipExportScope = {}): string {
  return `/api/exports/relationships${queryString({ columns: columns?.join(","), ...scope })}`;
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
