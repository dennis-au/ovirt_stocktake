import type { VmRecord, VmSnapshotRecord } from "./postgres/inventory.js";

export interface HealthDeduction {
  code: string;
  points: number;
  evidence: Record<string, unknown>;
  recommendedAction: string;
}

export interface HealthResult {
  score: number;
  deductions: HealthDeduction[];
  governanceExceptions: HealthDeduction[];
}

const productionValues = new Set(["prod", "production"]);
const missingProductionFields = ["owner", "environment", "application", "criticality"] as const;

export function applyGovernanceAndHealth(vm: VmRecord, collectedAt = new Date()): VmRecord {
  const result = evaluateVmHealth(vm, collectedAt);
  return {
    ...vm,
    healthScore: result.score,
    healthDeductions: result.deductions
  };
}

export function evaluateVmHealth(vm: VmRecord, collectedAt = new Date()): HealthResult {
  const deductions: HealthDeduction[] = [];

  if (isProductionVm(vm)) {
    const missing = missingProductionFields.filter((field) => !hasText(vm[field]));
    for (const field of missing) {
      deductions.push({
        code: `governance.missing_${toSnakeCase(field)}`,
        points: 10,
        evidence: { vmId: vm.vmId, field, environment: vm.environment, tags: vm.tags ?? [] },
        recommendedAction: `Set VM ${field} metadata for production inventory ownership.`
      });
    }
  }

  if (!hasAnyIp(vm)) {
    deductions.push({
      code: "network.unknown_ip",
      points: 5,
      evidence: { vmId: vm.vmId, nicCount: vm.nics?.length ?? 0 },
      recommendedAction: "Verify guest-agent data or document the VM network identity."
    });
  }

  if (vm.publicIp) {
    deductions.push({
      code: "security.public_exposure",
      points: 15,
      evidence: { vmId: vm.vmId, publicIp: vm.publicIp },
      recommendedAction: "Confirm the public exposure is approved and protected."
    });
  }

  if (vm.guestAgentStatus === "missing" || vm.guestAgentStatus === "unavailable") {
    deductions.push({
      code: "guest_agent.unavailable",
      points: 10,
      evidence: { vmId: vm.vmId, guestAgentStatus: vm.guestAgentStatus },
      recommendedAction: "Install, start, or repair the guest agent."
    });
  } else if (isOlderThanHours(vm.lastGuestAgentUpdate, collectedAt, 24)) {
    deductions.push({
      code: "guest_agent.stale",
      points: 10,
      evidence: { vmId: vm.vmId, lastGuestAgentUpdate: vm.lastGuestAgentUpdate },
      recommendedAction: "Refresh guest-agent telemetry or investigate agent health."
    });
  }

  if (!vm.backupStatus || ["missing", "unprotected", "failed"].includes(vm.backupStatus)) {
    deductions.push({
      code: "backup.not_compliant",
      points: 20,
      evidence: { vmId: vm.vmId, backupStatus: vm.backupStatus ?? "missing" },
      recommendedAction: "Assign a backup policy and verify the latest successful backup."
    });
  }

  if (vm.rpoActualHours !== undefined && vm.rpoTargetHours !== undefined && vm.rpoActualHours > vm.rpoTargetHours) {
    deductions.push({
      code: "backup.rpo_breach",
      points: 20,
      evidence: { vmId: vm.vmId, rpoActualHours: vm.rpoActualHours, rpoTargetHours: vm.rpoTargetHours },
      recommendedAction: "Investigate backup lag and restore RPO compliance."
    });
  }

  if (vm.osEolDate && Date.parse(vm.osEolDate) < collectedAt.getTime()) {
    deductions.push({
      code: "security.unsupported_os",
      points: 20,
      evidence: { vmId: vm.vmId, osEolDate: vm.osEolDate, guestOsName: vm.guestOsName },
      recommendedAction: "Upgrade or retire the unsupported operating system."
    });
  }

  if ((vm.vulnerabilityCriticalCount ?? 0) > 0) {
    deductions.push({
      code: "security.critical_vulnerabilities",
      points: 20,
      evidence: { vmId: vm.vmId, vulnerabilityCriticalCount: vm.vulnerabilityCriticalCount },
      recommendedAction: "Patch or isolate the VM until critical vulnerabilities are remediated."
    });
  }

  const oldestSnapshot = oldestSnapshotAge(vm.snapshots ?? []);
  if (oldestSnapshot !== undefined && oldestSnapshot > 30) {
    deductions.push(snapshotDeduction(vm, oldestSnapshot, 15, "snapshot.older_than_30_days"));
  } else if (oldestSnapshot !== undefined && oldestSnapshot > 7) {
    deductions.push(snapshotDeduction(vm, oldestSnapshot, 10, "snapshot.older_than_7_days"));
  } else if (oldestSnapshot !== undefined && oldestSnapshot > 3) {
    deductions.push(snapshotDeduction(vm, oldestSnapshot, 5, "snapshot.older_than_3_days"));
  }

  if (vm.lifecycleStatus === "idle" || vm.lifecycleStatus === "retirement_candidate") {
    deductions.push({
      code: "lifecycle.idle_or_retirement_candidate",
      points: 5,
      evidence: { vmId: vm.vmId, lifecycleStatus: vm.lifecycleStatus },
      recommendedAction: "Confirm ownership and retire or resize the VM through an approved change."
    });
  }

  const score = Math.max(0, 100 - deductions.reduce((total, deduction) => total + deduction.points, 0));
  return {
    score,
    deductions,
    governanceExceptions: deductions.filter((deduction) => deduction.code.startsWith("governance."))
  };
}

export function isProductionVm(vm: VmRecord): boolean {
  if (vm.environment && productionValues.has(vm.environment.toLowerCase())) {
    return true;
  }
  return (vm.tags ?? []).some((tag) => productionValues.has(tag.toLowerCase()));
}

function snapshotDeduction(vm: VmRecord, ageDays: number, points: number, code: string): HealthDeduction {
  return {
    code,
    points,
    evidence: { vmId: vm.vmId, oldestSnapshotAgeDays: ageDays },
    recommendedAction: "Review snapshot owner, ticket, and retention need; remove through an approved change when safe."
  };
}

function oldestSnapshotAge(snapshots: VmSnapshotRecord[]): number | undefined {
  return snapshots.reduce<number | undefined>((oldest, snapshot) => {
    if (snapshot.ageDays === undefined) {
      return oldest;
    }
    return oldest === undefined ? snapshot.ageDays : Math.max(oldest, snapshot.ageDays);
  }, undefined);
}

function hasAnyIp(vm: VmRecord): boolean {
  if (vm.publicIp) {
    return true;
  }
  return (vm.nics ?? []).some((nic) => (nic.ipv4Addresses?.length ?? 0) > 0 || (nic.ipv6Addresses?.length ?? 0) > 0);
}

function isOlderThanHours(value: string | undefined, collectedAt: Date, hours: number): boolean {
  return Boolean(value && collectedAt.getTime() - Date.parse(value) > hours * 60 * 60 * 1000);
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
