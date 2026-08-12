import { describe, expect, it } from "vitest";
import { applyGovernanceAndHealth, evaluateVmHealth, isProductionVm } from "../server/governance.js";
import type { VmRecord } from "../server/postgres/inventory.js";

const collectedAt = new Date("2026-08-11T12:00:00.000Z");

describe("governance and VM health score", () => {
  it("keeps a healthy production VM at 100 with no deductions", () => {
    const vm: VmRecord = {
      vmId: "vm-1",
      name: "api-01",
      environment: "prod",
      application: "orders",
      owner: "platform",
      criticality: "critical",
      guestAgentStatus: "available",
      backupStatus: "protected",
      nics: [{ nicId: "nic-1", name: "nic1", ipv4Addresses: ["10.0.0.10"] }],
      snapshots: []
    };

    expect(isProductionVm(vm)).toBe(true);
    expect(evaluateVmHealth(vm, collectedAt)).toEqual({ score: 100, deductions: [], governanceExceptions: [] });
  });

  it("explains deductions for production governance and operational risks", () => {
    const risky: VmRecord = {
      vmId: "vm-2",
      name: "risk-01",
      tags: ["prod"],
      guestAgentStatus: "missing",
      backupStatus: "failed",
      rpoTargetHours: 4,
      rpoActualHours: 9,
      osEolDate: "2026-01-01",
      vulnerabilityCriticalCount: 2,
      publicIp: "203.0.113.10",
      lifecycleStatus: "idle",
      snapshots: [{ snapshotId: "snapshot-1", ageDays: 31 }]
    };

    const result = evaluateVmHealth(risky, collectedAt);

    expect(result.score).toBe(0);
    expect(result.governanceExceptions.map((deduction) => deduction.code)).toEqual([
      "governance.missing_owner",
      "governance.missing_environment",
      "governance.missing_application",
      "governance.missing_criticality"
    ]);
    expect(result.deductions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "backup.not_compliant", evidence: expect.objectContaining({ backupStatus: "failed" }) }),
        expect.objectContaining({ code: "backup.rpo_breach", evidence: expect.objectContaining({ rpoActualHours: 9 }) }),
        expect.objectContaining({ code: "security.critical_vulnerabilities" }),
        expect.objectContaining({ code: "snapshot.older_than_30_days" })
      ])
    );
    expect(result.deductions.every((deduction) => deduction.recommendedAction.length > 0)).toBe(true);
  });

  it("returns VMs with computed score and stored deduction evidence", () => {
    const vm = applyGovernanceAndHealth(
      {
        vmId: "vm-3",
        name: "legacy-01",
        environment: "production",
        application: "erp",
        owner: "apps",
        criticality: "high",
        guestAgentStatus: "available",
        lastGuestAgentUpdate: "2026-08-09T12:00:00.000Z",
        backupStatus: "protected",
        nics: [{ nicId: "nic-1", name: "nic1", ipv4Addresses: ["10.0.0.11"] }]
      },
      collectedAt
    );

    expect(vm.healthScore).toBe(90);
    expect(vm.healthDeductions).toEqual([expect.objectContaining({ code: "guest_agent.stale" })]);
  });
});
