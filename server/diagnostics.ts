import type { FastifyInstance } from "fastify";
import { emptyInventoryResources, type CollectionIssue, type InventoryResource, type InventoryResources, type SnapshotStatus } from "../shared/snapshot.js";
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

interface SnapshotAgeDiagnosticRun {
  collectedAt: string;
  apiVersion: string;
  durationMs: number;
  status: SnapshotStatus;
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
  reportVersion: 1;
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

export function registerDiagnosticRoutes(app: FastifyInstance, db: SqliteDatabase): void {
  app.get("/api/diagnostics/snapshot-age", { preHandler: requireRole(roles.admin) }, async () => ({
    diagnostics: snapshotAgeDiagnostics(db)
  }));
}

export function snapshotAgeDiagnostics(db: SqliteDatabase): SnapshotAgeDiagnostics {
  const managers = db.prepare("SELECT id, enabled FROM managers ORDER BY name COLLATE NOCASE, id").all() as ManagerRow[];
  return {
    reportVersion: 1,
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
       WHERE manager_id = ? AND status IN ('success', 'partial')
       ORDER BY collected_at DESC, created_at DESC LIMIT 1`
    )
    .get(managerId) as SnapshotRow | undefined;
}

function summarizeSnapshot(snapshot: SnapshotRow): SnapshotAgeDiagnosticRun {
  const resources = parseResources(snapshot.resources_json);
  const issues = snapshotDateIssueCounts(parseIssues(snapshot.warnings_json), parseIssues(snapshot.errors_json));
  const summary = summarizeSnapshotDates(resources.vmSnapshots);
  return {
    collectedAt: snapshot.collected_at,
    apiVersion: snapshot.api_version,
    durationMs: snapshot.duration_ms,
    status: snapshot.status,
    ...summary,
    snapshotDateIssueCounts: issues,
    findings: snapshotDateFindings(summary, issues)
  };
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
    return { ...emptyInventoryResources(), vmSnapshots: Array.isArray(parsed.vmSnapshots) ? parsed.vmSnapshots : [] };
  } catch {
    return emptyInventoryResources();
  }
}

function parseIssues(value: string): CollectionIssue[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((issue): issue is CollectionIssue => Boolean(issue && typeof issue === "object" && typeof issue.message === "string"))
      : [];
  } catch {
    return [];
  }
}
