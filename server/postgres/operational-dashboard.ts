import type { AppRole } from "../rbac.js";
import type { PostgresQueryable } from "./migrate.js";

export interface OperationalDashboard {
  kpis: Array<{
    id: string;
    label: string;
    value: number;
    href: string;
  }>;
  charts: {
    vmStatusByCluster: Array<Record<string, unknown>>;
    storageCapacity: Array<Record<string, unknown>>;
    backupCompliance: Array<Record<string, unknown>>;
    snapshotRisk: Array<Record<string, unknown>>;
    availabilityEvents: Array<Record<string, unknown>>;
    costAttribution: Array<Record<string, unknown>>;
    capacityPlaceholders: {
      cpuP95Available: boolean;
      memoryP95Available: boolean;
    };
  };
  managers: Array<Record<string, unknown>>;
}

export async function operationalDashboard(db: PostgresQueryable, role: AppRole): Promise<OperationalDashboard> {
  const [vmRows, ownershipRows, snapshotRows, eventRows, managers, storageCapacity] = await Promise.all([
    rows(db, "SELECT vm_id, cluster_name, cluster_id, status, ha_enabled, guest_agent_status FROM vms"),
    rows(
      db,
      `SELECT vm_id, environment, owner, application, criticality, backup_status, rpo_actual_hours,
              rpo_target_hours, lifecycle_status, cost_center, monthly_estimated_cost
       FROM vm_ownership`
    ),
    rows(db, "SELECT vm_id, snapshot_id, description, age_days FROM vm_snapshots"),
    rows(db, "SELECT event_time, COALESCE(severity, 'unknown') AS severity FROM events ORDER BY event_time"),
    managerFreshness(db),
    rows(db, "SELECT name, storage_domain_id, used_bytes, total_bytes FROM storage_domains ORDER BY name").then((items) =>
      items
        .map((item) => ({
          ...item,
          used_percent:
            Number(item.total_bytes ?? 0) > 0 ? Math.round((Number(item.used_bytes ?? 0) / Number(item.total_bytes)) * 10000) / 100 : 0
        }))
        .sort((left, right) => Number(right.used_percent) - Number(left.used_percent))
    )
  ]);

  const totalVms = vmRows.length;
  const productionVms = ownershipRows.filter((row) => ["prod", "production"].includes(String(row.environment))).length;
  const missingMetadata = ownershipRows.filter(
    (row) => !row.owner || !row.environment || !row.application || !row.criticality
  ).length;
  const guestAgentIssues = vmRows.filter((row) => ["missing", "unavailable", "stale"].includes(String(row.guest_agent_status))).length;
  const missingBackup = ownershipRows.filter((row) => !row.backup_status || ["missing", "unprotected", "failed"].includes(String(row.backup_status))).length;
  const rpoBreaches = ownershipRows.filter(
    (row) =>
      row.rpo_actual_hours !== null &&
      row.rpo_actual_hours !== undefined &&
      row.rpo_target_hours !== null &&
      row.rpo_target_hours !== undefined &&
      Number(row.rpo_actual_hours) > Number(row.rpo_target_hours)
  ).length;
  const snapshots3 = countVmSnapshotsOver(snapshotRows, 3);
  const snapshots7 = countVmSnapshotsOver(snapshotRows, 7);
  const snapshots30 = countVmSnapshotsOver(snapshotRows, 30);
  const idleVms = ownershipRows.filter((row) => ["idle", "retirement_candidate"].includes(String(row.lifecycle_status))).length;
  const unavailableHa = vmRows.filter((row) => row.ha_enabled === true && !["up", "powering_up"].includes(String(row.status))).length;

  const vmStatusByCluster = groupedRows(vmRows, (row) => [
    String(row.cluster_name ?? row.cluster_id ?? "unknown"),
    String(row.status ?? "unknown")
  ]).map(([cluster, status, count]) => ({ cluster, status, count }));
  const backupCompliance = groupedRows(ownershipRows, (row) => [String(row.backup_status ?? "missing")]).map(([status, count]) => ({
    status,
    count
  }));
  const snapshotRisk = [...snapshotRows]
    .sort((left, right) => Number(right.age_days ?? 0) - Number(left.age_days ?? 0))
    .slice(0, 20);
  const costAttribution =
    role === "admin"
      ? groupedSumRows(ownershipRows, (row) => String(row.cost_center ?? "unassigned"), "monthly_estimated_cost").map(
          ([cost_center, monthly_estimated_cost]) => ({ cost_center, monthly_estimated_cost })
        )
      : [];

  return {
    kpis: [
      kpi("vms.total", "VMs", totalVms, "/api/inventory/vms"),
      kpi("vms.production", "Production VMs", productionVms, "/api/inventory/vms?environment=prod"),
      kpi("governance.missing_metadata", "Missing Metadata", missingMetadata, "/api/inventory/vms?missingMetadata=true"),
      kpi("availability.ha_unavailable", "HA Unavailable", unavailableHa, "/api/inventory/vms?ha=true&status=down"),
      kpi("guest_agent.issues", "Guest Agent Issues", guestAgentIssues, "/api/inventory/vms?guestAgentStatus=missing"),
      kpi("backup.missing", "Backup Exceptions", missingBackup, "/api/inventory/vms?missingBackup=true"),
      kpi("backup.rpo_breach", "RPO Breaches", rpoBreaches, "/api/inventory/vms?rpoBreach=true"),
      kpi("snapshot.over_3_days", "Snapshots >3d", snapshots3, "/api/inventory/vms?snapshotAgeOverDays=3"),
      kpi("snapshot.over_7_days", "Snapshots >7d", snapshots7, "/api/inventory/vms?snapshotAgeOverDays=7"),
      kpi("snapshot.over_30_days", "Snapshots >30d", snapshots30, "/api/inventory/vms?snapshotAgeOverDays=30"),
      kpi("lifecycle.idle", "Idle/Retirement", idleVms, "/api/inventory/vms?idle=true"),
      kpi("events.24h", "Events 24h", countEventsSince(eventRows, 24), "/api/inventory/vms"),
      kpi("events.7d", "Events 7d", countEventsSince(eventRows, 24 * 7), "/api/inventory/vms")
    ],
    charts: {
      vmStatusByCluster,
      storageCapacity,
      backupCompliance,
      snapshotRisk,
      availabilityEvents: bucketEventsByDay(eventRows),
      costAttribution,
      capacityPlaceholders: {
        cpuP95Available: false,
        memoryP95Available: false
      }
    },
    managers
  };
}

function kpi(id: string, label: string, value: number, href: string): OperationalDashboard["kpis"][number] {
  return { id, label, value, href };
}

async function rows(db: PostgresQueryable, sql: string): Promise<Array<Record<string, unknown>>> {
  return (await db.query<Record<string, unknown>>(sql)).rows;
}

async function managerFreshness(db: PostgresQueryable): Promise<Array<Record<string, unknown>>> {
  const managers = await rows(db, "SELECT id, name, url FROM managers ORDER BY name");
  const runs = await rows(
    db,
    "SELECT manager_id, status, started_at, completed_at, warnings, errors FROM collection_runs ORDER BY started_at DESC"
  );
  const latest = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    const managerId = String(run.manager_id);
    if (!latest.has(managerId)) {
      latest.set(managerId, run);
    }
  }

  return managers.map((manager) => {
    const run = latest.get(String(manager.id));
    return {
      ...manager,
      last_status: run?.status,
      started_at: run?.started_at,
      completed_at: run?.completed_at,
      warnings_count: Array.isArray(run?.warnings) ? run.warnings.length : 0,
      errors_count: Array.isArray(run?.errors) ? run.errors.length : 0
    };
  });
}

function countEventsSince(events: Array<Record<string, unknown>>, hours: number): number {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return events.filter((event) => Date.parse(timestampString(event.event_time)) >= cutoff).length;
}

function bucketEventsByDay(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const day = timestampString(event.event_time).slice(0, 10);
    const severity = String(event.severity ?? "unknown");
    const key = `${day}:${severity}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [bucket, severity] = key.split(":");
    return { bucket, severity, count };
  });
}

function countVmSnapshotsOver(snapshots: Array<Record<string, unknown>>, days: number): number {
  const ids = new Set<string>();
  for (const snapshot of snapshots) {
    if (Number(snapshot.age_days ?? 0) > days) {
      ids.add(String(snapshot.vm_id));
    }
  }
  return ids.size;
}

function groupedRows(
  rowsToGroup: Array<Record<string, unknown>>,
  keys: (row: Record<string, unknown>) => string[]
): Array<[string, string, number] | [string, number]> {
  const counts = new Map<string, { keys: string[]; count: number }>();
  for (const row of rowsToGroup) {
    const rowKeys = keys(row);
    const key = rowKeys.join("\u0000");
    const current = counts.get(key) ?? { keys: rowKeys, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].map((item) => [...item.keys, item.count] as [string, string, number] | [string, number]);
}

function groupedSumRows(
  rowsToGroup: Array<Record<string, unknown>>,
  key: (row: Record<string, unknown>) => string,
  field: string
): Array<[string, number]> {
  const sums = new Map<string, number>();
  for (const row of rowsToGroup) {
    const rowKey = key(row);
    sums.set(rowKey, (sums.get(rowKey) ?? 0) + Number(row[field] ?? 0));
  }
  return [...sums.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function timestampString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value ?? "");
}
