import { describe, expect, it } from "vitest";
import { redactedDiagnosticsReport, type DiagnosticsReportSource } from "../shared/diagnostics-report.js";

describe("diagnostics report", () => {
  it("anonymizes configured manager names for copied and downloaded reports", () => {
    const diagnostics: DiagnosticsReportSource = {
      reportVersion: 2,
      generatedAt: "2026-08-19T06:30:00.000Z",
      managerCount: 1,
      managers: [{ label: "Manager 1", name: "production-manager", enabled: true }]
    };

    const report = redactedDiagnosticsReport("0.1.30", diagnostics);

    expect(report).not.toContain("production-manager");
    expect(JSON.parse(report)).toMatchObject({
      managerCount: 1,
      managers: [{ label: "Manager 1", enabled: true }]
    });
  });
});
