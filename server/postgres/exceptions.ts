import { redactInventoryFields, type AppRole } from "../rbac.js";
import type { PostgresQueryable } from "./migrate.js";

export type ExceptionType =
  | "backup_non_compliance"
  | "rpo_breach"
  | "restore_test_gap"
  | "unsupported_os"
  | "critical_vulnerabilities"
  | "public_exposure"
  | "retirement_candidate"
  | "snapshot_risk";

export interface ExceptionItem extends Record<string, unknown> {
  type: ExceptionType;
  severity: "info" | "warning" | "critical";
  managerId: string;
  vmId: string;
  name: string;
  evidence: Record<string, unknown>;
  recommendedAction: string;
  href: string;
}

interface ExceptionVmRow extends Record<string, unknown> {
  manager_id: string;
  vm_id: string;
  name: string;
  backup_status: string | null;
  rpo_actual_hours: number | null;
  rpo_target_hours: number | null;
  last_restore_test_at: Date | string | null;
  os_eol_date: Date | string | null;
  vulnerability_critical_count: number | null;
  public_ip: string | null;
  lifecycle_status: string | null;
  retire_date: Date | string | null;
}

export async function queryExceptions(db: PostgresQueryable, role: AppRole, type?: ExceptionType): Promise<ExceptionItem[]> {
  const vms = (
    await db.query<ExceptionVmRow>(
      `
        SELECT v.manager_id, v.vm_id, v.name, o.backup_status, o.rpo_actual_hours, o.rpo_target_hours,
               o.last_restore_test_at, o.os_eol_date, o.vulnerability_critical_count, o.public_ip,
               o.lifecycle_status, o.retire_date
        FROM vms v
        LEFT JOIN vm_ownership o ON o.manager_id = v.manager_id AND o.vm_id = v.vm_id
      `
    )
  ).rows;
  const snapshots = (
    await db.query<{ manager_id: string; vm_id: string; age_days: number | null; snapshot_id: string }>(
      "SELECT manager_id, vm_id, age_days, snapshot_id FROM vm_snapshots WHERE age_days > 3"
    )
  ).rows;

  const items = [...vms.flatMap(vmExceptions), ...snapshots.map(snapshotException)].filter((item) => !type || item.type === type);
  return items.map((item) => ({
    ...item,
    evidence: redactInventoryFields(role, item.evidence)
  }));
}

export function integrationStatuses(): Array<Record<string, unknown>> {
  return [
    unavailable("commvault", "Backup job status and restore-test evidence adapter"),
    unavailable("cmdb", "CMDB CI ownership and lifecycle adapter"),
    unavailable("ticketing", "Change ticket and remediation approval adapter"),
    unavailable("showback_chargeback", "Cost allocation and chargeback adapter")
  ];
}

function vmExceptions(vm: ExceptionVmRow): ExceptionItem[] {
  const result: ExceptionItem[] = [];
  if (!vm.backup_status || ["missing", "unprotected", "failed"].includes(vm.backup_status)) {
    result.push(item(vm, "backup_non_compliance", "critical", { backupStatus: vm.backup_status ?? "missing" }, "Assign and verify backup protection."));
  }
  if (
    vm.rpo_actual_hours !== null &&
    vm.rpo_target_hours !== null &&
    vm.rpo_actual_hours !== undefined &&
    vm.rpo_target_hours !== undefined &&
    Number(vm.rpo_actual_hours) > Number(vm.rpo_target_hours)
  ) {
    result.push(
      item(
        vm,
        "rpo_breach",
        "critical",
        { rpoActualHours: vm.rpo_actual_hours, rpoTargetHours: vm.rpo_target_hours },
        "Investigate backup lag and restore RPO compliance."
      )
    );
  }
  if (!vm.last_restore_test_at) {
    result.push(item(vm, "restore_test_gap", "warning", { lastRestoreTestAt: undefined }, "Record restore-test evidence for this VM."));
  }
  if (vm.os_eol_date && Date.parse(String(vm.os_eol_date)) < Date.now()) {
    result.push(item(vm, "unsupported_os", "critical", { osEolDate: dateString(vm.os_eol_date) }, "Upgrade or retire the unsupported OS."));
  }
  if ((vm.vulnerability_critical_count ?? 0) > 0) {
    result.push(
      item(
        vm,
        "critical_vulnerabilities",
        "critical",
        { vulnerabilityCriticalCount: vm.vulnerability_critical_count },
        "Patch or isolate the VM until critical vulnerabilities are remediated."
      )
    );
  }
  if (vm.public_ip) {
    result.push(item(vm, "public_exposure", "warning", { publicIp: vm.public_ip }, "Confirm public exposure is approved and protected."));
  }
  if (vm.lifecycle_status === "idle" || vm.lifecycle_status === "retirement_candidate" || retired(vm.retire_date)) {
    result.push(
      item(
        vm,
        "retirement_candidate",
        "info",
        { lifecycleStatus: vm.lifecycle_status, retireDate: dateString(vm.retire_date) },
        "Confirm ownership and retire through an approved change."
      )
    );
  }
  return result;
}

function snapshotException(snapshot: { manager_id: string; vm_id: string; age_days: number | null; snapshot_id: string }): ExceptionItem {
  return {
    type: "snapshot_risk",
    severity: Number(snapshot.age_days ?? 0) > 30 ? "critical" : "warning",
    managerId: snapshot.manager_id,
    vmId: snapshot.vm_id,
    name: snapshot.vm_id,
    evidence: { snapshotId: snapshot.snapshot_id, ageDays: snapshot.age_days },
    recommendedAction: "Review snapshot retention need and remove through an approved change when safe.",
    href: `/api/inventory/vms/${encodeURIComponent(snapshot.manager_id)}/${encodeURIComponent(snapshot.vm_id)}`
  };
}

function item(
  vm: ExceptionVmRow,
  type: ExceptionType,
  severity: ExceptionItem["severity"],
  evidence: Record<string, unknown>,
  recommendedAction: string
): ExceptionItem {
  return {
    type,
    severity,
    managerId: vm.manager_id,
    vmId: vm.vm_id,
    name: vm.name,
    evidence,
    recommendedAction,
    href: `/api/inventory/vms/${encodeURIComponent(vm.manager_id)}/${encodeURIComponent(vm.vm_id)}`
  };
}

function unavailable(id: string, description: string): Record<string, unknown> {
  return {
    id,
    status: "unavailable",
    description,
    message: "Adapter placeholder only; no integration is configured in the MVP."
  };
}

function retired(value: unknown): boolean {
  return Boolean(value && Date.parse(String(value)) <= Date.now());
}

function dateString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return typeof value === "string" && value ? value.slice(0, 10) : undefined;
}
