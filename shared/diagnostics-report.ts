export interface DiagnosticsReportSource {
  reportVersion: number;
  generatedAt: string;
  managerCount: number;
  managers: Array<{
    label: string;
    name: string;
    enabled: boolean;
    latestInventoryRun?: unknown;
  }>;
}

export function redactedDiagnosticsReport(appVersion: string, diagnostics: DiagnosticsReportSource): string {
  const { managers, ...reportDiagnostics } = diagnostics;
  return JSON.stringify(
    {
      appVersion,
      ...reportDiagnostics,
      managers: managers.map((manager) => ({
        label: manager.label,
        enabled: manager.enabled,
        ...(manager.latestInventoryRun === undefined ? {} : { latestInventoryRun: manager.latestInventoryRun })
      }))
    },
    null,
    2
  );
}
