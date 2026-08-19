import type { FastifyInstance } from "fastify";
import {
  emptyInventoryResources,
  resourceKeys,
  type CollectionIssue,
  type InventoryResource,
  type InventoryResources,
  type ResourceKey,
  type SnapshotStatus
} from "../shared/snapshot.js";
import type { SqliteDatabase } from "./db.js";
import { requireRole, roles } from "./rbac.js";
import { snapshotCreatedAt } from "./snapshot-age.js";
import { isActiveVmSnapshot } from "./snapshot-semantics.js";

type SnapshotDateFinding =
  | "all_snapshot_dates_available"
  | "no_inventory_snapshot"
  | "no_vm_snapshots"
  | "snapshot_dates_missing"
  | "snapshot_date_values_invalid"
  | "snapshot_detail_requests_failed"
  | "snapshot_detail_responses_missing_date"
  | "snapshot_list_requests_failed";

interface SnapshotRow {
  collected_at: string;
  api_version: string;
  duration_ms: number;
  status: SnapshotStatus;
  resources_json: string;
  warnings_json: string;
  errors_json: string;
}

interface ManagerRow {
  id: string;
  enabled: number;
}

interface SnapshotDateIssueCounts {
  noCreationDate: number;
  detailCollectionFailed: number;
  listCollectionFailed: number;
  other: number;
}

type DiagnosticResource = ResourceKey | "general";
type ResourceCollectionState = "collected" | "empty" | "partial" | "failed";
type DiagnosticIssueSeverity = "warning" | "error";
type DiagnosticIssueOperation =
  | "resource_list"
  | "child_collection"
  | "host_certificate_detail"
  | "host_certificate_expiry"
  | "snapshot_list"
  | "snapshot_detail"
  | "snapshot_date"
  | "guest_agent"
  | "collection";
type DiagnosticFailureCategory = "authentication" | "network_tls" | "timeout" | "http_4xx" | "http_5xx" | "missing_data" | "other";

interface DiagnosticResourceState {
  resource: ResourceKey;
  recordCount: number;
  state: ResourceCollectionState;
  warningCount: number;
  errorCount: number;
}

interface DiagnosticIssueFingerprint {
  fingerprint: string;
  severity: DiagnosticIssueSeverity;
  resource: DiagnosticResource;
  operation: DiagnosticIssueOperation;
  failureCategory: DiagnosticFailureCategory;
  httpStatusClass?: "4xx" | "5xx";
  count: number;
}

interface SnapshotAgeDiagnosticRun {
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
  observedTemporalFields: Partial<Record<SnapshotTemporalField, number>>;
  snapshotDateIssueCounts: SnapshotDateIssueCounts;
  findings: SnapshotDateFinding[];
}

export interface SnapshotAgeDiagnostics {
  reportVersion: 2;
  generatedAt: string;
  managerCount: number;
  managers: Array<{
    label: string;
    enabled: boolean;
    latestInventoryRun?: SnapshotAgeDiagnosticRun;
  }>;
}

const temporalFields = ["date", "creation_date", "creationDate", "created_at", "createdAt", "creation_time", "creationTime"] as const;
type SnapshotTemporalField = (typeof temporalFields)[number];
const topLevelResourceKeys = new Set<ResourceKey>([
  "dataCenters",
  "clusters",
  "hosts",
  "vms",
  "storageDomains",
  "disks",
  "networks",
  "vnicProfiles",
  "tags",
  "events"
]);

export function registerDiagnosticRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/diagnostics/snapshot-age", { preHandler: requireRole(roles.admin) }, async () => ({
    diagnostics: snapshotAgeDiagnostics(db)
  }));
}

export function snapshotAgeDiagnostics(db: SqliteDatabase): SnapshotAgeDiagnostics {
  const managers = db.prepare("SELECT id, enabled FROM managers ORDER BY name COLLATE NOCASE, id").all() as ManagerRow[];
  return {
    reportVersion: 2,
    generatedAt: new Date().toISOString(),
    managerCount: managers.length,
    managers: managers.map((manager, index) => {
      const latestRun = latestInventoryRun(db, manager.id);
      return {
        label: `Manager ${index + 1}`,
        enabled: Boolean(manager.enabled),
        ...(latestRun ? { latestInventoryRun: summarizeSnapshot(latestRun) } : {})
      };
    })
  };
}

function latestInventoryRun(db: SqliteDatabase, managerId: string): SnapshotRow | undefined {
  return db
    .prepare(
      `SELECT collected_at, api_version, duration_ms, status, resources_json, warnings_json, errors_json
       FROM snapshots
       WHERE manager_id = ?
       ORDER BY collected_at DESC, created_at DESC LIMIT 1`
    )
    .get(managerId) as SnapshotRow | undefined;
}

function summarizeSnapshot(snapshot: SnapshotRow): SnapshotAgeDiagnosticRun {
  const resources = parseResources(snapshot.resources_json);
  const warnings = parseIssues(snapshot.warnings_json);
  const errors = parseIssues(snapshot.errors_json);
  const issues = snapshotDateIssueCounts(warnings, errors);
  const summary = summarizeSnapshotDates(resources.vmSnapshots);
  return {
    collectedAt: snapshot.collected_at,
    apiVersion: snapshot.api_version,
    durationMs: snapshot.duration_ms,
    status: snapshot.status,
    warningCount: warnings.length,
    errorCount: errors.length,
    populatedResourceCount: resourceKeys.filter((key) => resources[key].length > 0).length,
    totalResourceCount: resourceKeys.length,
    resourceStates: diagnosticResourceStates(resources, warnings, errors),
    issueFingerprints: diagnosticIssueFingerprints(warnings, errors),
    ...summary,
    snapshotDateIssueCounts: issues,
    findings: snapshotDateFindings(summary, issues)
  };
}

function diagnosticResourceStates(
  resources: InventoryResources,
  warnings: CollectionIssue[],
  errors: CollectionIssue[]
): DiagnosticResourceState[] {
  return resourceKeys.map((resource) => {
    const recordCount = resources[resource].length;
    const warningCount = warnings.filter((issue) => issue.resource === resource).length;
    const errorCount = errors.filter((issue) => issue.resource === resource).length;
    const state: ResourceCollectionState = errorCount > 0 ? (recordCount > 0 ? "partial" : "failed") : recordCount > 0 ? "collected" : "empty";
    return { resource, recordCount, state, warningCount, errorCount };
  });
}

function diagnosticIssueFingerprints(warnings: CollectionIssue[], errors: CollectionIssue[]): DiagnosticIssueFingerprint[] {
  const fingerprints = new Map<string, DiagnosticIssueFingerprint>();
  for (const [severity, issues] of [
    ["warning", warnings],
    ["error", errors]
  ] as const) {
    for (const issue of issues) {
      const resource = issue.resource ?? "general";
      const operation = diagnosticIssueOperation(issue);
      const failureCategory = diagnosticFailureCategory(issue.message);
      const httpStatusClass = diagnosticHttpStatusClass(issue.message);
      const fingerprint = `${severity}:${resource}:${operation}:${failureCategory}`;
      const existing = fingerprints.get(fingerprint);
      if (existing) {
        existing.count += 1;
      } else {
        fingerprints.set(fingerprint, {
          fingerprint,
          severity,
          resource,
          operation,
          failureCategory,
          ...(httpStatusClass ? { httpStatusClass } : {}),
          count: 1
        });
      }
    }
  }
  return [...fingerprints.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function diagnosticIssueOperation(issue: CollectionIssue): DiagnosticIssueOperation {
  const message = issue.message.toLowerCase();
  if (issue.resource === "hosts" && message.includes("certificate detail collection failed")) {
    return "host_certificate_detail";
  }
  if (issue.resource === "hosts" && message.includes("certificate expiry is unavailable")) {
    return "host_certificate_expiry";
  }
  if (issue.resource === "vmSnapshots" && message.includes("snapshots collection failed")) {
    return "snapshot_list";
  }
  if (issue.resource === "vmSnapshots" && message.includes("detail collection failed")) {
    return "snapshot_detail";
  }
  if (issue.resource === "vmSnapshots" && message.includes("no creation date")) {
    return "snapshot_date";
  }
  if (issue.resource === "vms" && message.includes("no guest-agent data")) {
    return "guest_agent";
  }
  if (issue.resource === "affinityGroups" || (issue.resource && !topLevelResourceKeys.has(issue.resource) && message.includes("collection failed"))) {
    return "child_collection";
  }
  if (issue.resource && topLevelResourceKeys.has(issue.resource)) {
    return "resource_list";
  }
  return "collection";
}

function diagnosticFailureCategory(message: string): DiagnosticFailureCategory {
  const normalized = message.toLowerCase();
  if (normalized.includes("authentication failed") || /http (401|403)\b/.test(normalized)) {
    return "authentication";
  }
  if (normalized.includes("network or tls failure")) {
    return "network_tls";
  }
  if (normalized.includes("timed out")) {
    return "timeout";
  }
  const statusClass = diagnosticHttpStatusClass(message);
  if (statusClass === "4xx") {
    return "http_4xx";
  }
  if (statusClass === "5xx") {
    return "http_5xx";
  }
  if (normalized.includes("unavailable") || normalized.includes("no creation date") || normalized.includes("no guest-agent data")) {
    return "missing_data";
  }
  return "other";
}

function diagnosticHttpStatusClass(message: string): "4xx" | "5xx" | undefined {
  const status = /http (\d{3})\b/i.exec(message)?.[1];
  if (status?.startsWith("4")) {
    return "4xx";
  }
  if (status?.startsWith("5")) {
    return "5xx";
  }
  return undefined;
}

function summarizeSnapshotDates(snapshots: InventoryResource[]) {
  let activeSnapshotCount = 0;
  let regularSnapshotCount = 0;
  let validDateCount = 0;
  let missingDateCount = 0;
  let invalidDateCount = 0;
  const observedTemporalFields: Partial<Record<SnapshotTemporalField, number>> = {};

  for (const snapshot of snapshots) {
    if (isActiveVmSnapshot(snapshot)) {
      activeSnapshotCount += 1;
      continue;
    }

    regularSnapshotCount += 1;
    for (const field of temporalFields) {
      if (snapshot[field] !== undefined && snapshot[field] !== null && snapshot[field] !== "") {
        observedTemporalFields[field] = (observedTemporalFields[field] ?? 0) + 1;
      }
    }

    if (snapshot.date === undefined || snapshot.date === null || snapshot.date === "") {
      missingDateCount += 1;
    } else if (snapshotCreatedAt(snapshot.date)) {
      validDateCount += 1;
    } else {
      invalidDateCount += 1;
    }
  }

  return { regularSnapshotCount, activeSnapshotCount, validDateCount, missingDateCount, invalidDateCount, observedTemporalFields };
}

function snapshotDateIssueCounts(warnings: CollectionIssue[], errors: CollectionIssue[]): SnapshotDateIssueCounts {
  const result: SnapshotDateIssueCounts = {
    noCreationDate: 0,
    detailCollectionFailed: 0,
    listCollectionFailed: 0,
    other: 0
  };

  for (const issue of [...warnings, ...errors]) {
    if (issue.resource !== "vmSnapshots") {
      continue;
    }
    if (issue.message.includes("has no creation date")) {
      result.noCreationDate += 1;
    } else if (issue.message.includes("detail collection failed")) {
      result.detailCollectionFailed += 1;
    } else if (issue.message.includes("snapshots collection failed")) {
      result.listCollectionFailed += 1;
    } else {
      result.other += 1;
    }
  }

  return result;
}

function snapshotDateFindings(
  summary: ReturnType<typeof summarizeSnapshotDates>,
  issues: SnapshotDateIssueCounts
): SnapshotDateFinding[] {
  if (summary.regularSnapshotCount === 0) {
    return ["no_vm_snapshots"];
  }

  const findings: SnapshotDateFinding[] = [];
  if (summary.missingDateCount > 0) {
    findings.push("snapshot_dates_missing");
  }
  if (summary.invalidDateCount > 0) {
    findings.push("snapshot_date_values_invalid");
  }
  if (issues.detailCollectionFailed > 0) {
    findings.push("snapshot_detail_requests_failed");
  }
  if (issues.noCreationDate > 0) {
    findings.push("snapshot_detail_responses_missing_date");
  }
  if (issues.listCollectionFailed > 0) {
    findings.push("snapshot_list_requests_failed");
  }
  return findings.length ? findings : ["all_snapshot_dates_available"];
}

function parseResources(value: string): InventoryResources {
  try {
    const parsed = JSON.parse(value) as Partial<InventoryResources>;
    const resources = emptyInventoryResources();
    for (const key of resourceKeys) {
      resources[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
    }
    return resources;
  } catch {
    return emptyInventoryResources();
  }
}

function parseIssues(value: string): CollectionIssue[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.flatMap((issue): CollectionIssue[] => {
          if (!issue || typeof issue !== "object" || !("message" in issue) || typeof issue.message !== "string") {
            return [];
          }
          const resource = "resource" in issue && resourceKeys.includes(issue.resource as ResourceKey) ? (issue.resource as ResourceKey) : undefined;
          return [{ message: issue.message, ...(resource ? { resource } : {}) }];
        })
      : [];
  } catch {
    return [];
  }
}
