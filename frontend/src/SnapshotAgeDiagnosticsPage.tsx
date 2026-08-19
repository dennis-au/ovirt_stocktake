import { Activity, ClipboardCopy, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import appPackage from "../../package.json";
import { redactedDiagnosticsReport } from "../../shared/diagnostics-report";
import {
  getSnapshotAgeDiagnostics,
  type DiagnosticFailureCategory,
  type DiagnosticIssueFingerprint,
  type DiagnosticIssueOperation,
  type DiagnosticResourceState,
  type ResourceCollectionState,
  type SnapshotAgeDiagnostics,
  type SnapshotAgeDiagnosticRun,
  type SnapshotDateFinding
} from "./api";

const findingLabels: Record<SnapshotDateFinding, string> = {
  all_snapshot_dates_available: "All snapshot dates available",
  no_inventory_snapshot: "No inventory run available",
  no_vm_snapshots: "No VM snapshots in latest inventory",
  snapshot_dates_missing: "Snapshot dates missing",
  snapshot_date_values_invalid: "Snapshot date values invalid",
  snapshot_detail_requests_failed: "Snapshot detail requests failed",
  snapshot_detail_responses_missing_date: "Snapshot detail responses missing date",
  snapshot_list_requests_failed: "Snapshot list requests failed"
};

type DiagnosticResourceKey = DiagnosticResourceState["resource"];

const resourceLabels: Record<DiagnosticResourceKey, string> = {
  dataCenters: "Data centers",
  clusters: "Clusters",
  hosts: "Hosts",
  vms: "VMs",
  storageDomains: "Storage domains",
  disks: "Disks",
  networks: "Networks",
  vnicProfiles: "vNIC profiles",
  tags: "Tags",
  vmSnapshots: "VM snapshots",
  affinityGroups: "Affinity groups",
  events: "Events"
};

const operationLabels: Record<DiagnosticIssueOperation, string> = {
  resource_list: "resource list",
  child_collection: "child collection",
  snapshot_list: "snapshot list",
  snapshot_detail: "snapshot detail",
  snapshot_date: "snapshot date",
  guest_agent: "guest agent",
  collection: "collection"
};

const failureLabels: Record<DiagnosticFailureCategory, string> = {
  authentication: "authentication",
  network_tls: "network/TLS",
  timeout: "timeout",
  http_4xx: "HTTP 4xx",
  http_5xx: "HTTP 5xx",
  invalid_response: "invalid response",
  missing_data: "missing data",
  other: "other"
};

function stateClass(state: ResourceCollectionState | SnapshotAgeDiagnosticRun["status"]): string {
  if (state === "success" || state === "collected") {
    return "success";
  }
  if (state === "partial") {
    return "warning";
  }
  if (state === "failed") {
    return "danger";
  }
  return "muted";
}

function resourceStateLabel(state: ResourceCollectionState): string {
  return state === "collected" ? "Collected" : state === "empty" ? "Empty" : state === "partial" ? "Partial" : "Failed";
}

function formatDuration(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
}

function formatFingerprint(fingerprint: DiagnosticIssueFingerprint): string {
  const resource = fingerprint.resource === "general" ? "General" : resourceLabels[fingerprint.resource];
  const statusClass = fingerprint.httpStatusClass ? `, ${fingerprint.httpStatusClass}` : "";
  return `${resource}: ${operationLabels[fingerprint.operation]}, ${failureLabels[fingerprint.failureCategory]}${statusClass}`;
}

function reportFileName(generatedAt: string): string {
  const stamp = generatedAt.replace(/[^0-9]/g, "").slice(0, 14) || "latest";
  return `ovirt-inventory-diagnostics-${stamp}.json`;
}

function resourceStateDescription(state: DiagnosticResourceState): string {
  if (state.state === "failed") {
    return "No records returned";
  }
  if (state.state === "empty") {
    return "No records in this run";
  }
  return `${state.recordCount.toLocaleString()} record${state.recordCount === 1 ? "" : "s"}`;
}

export function SnapshotAgeDiagnosticsPage() {
  const [diagnostics, setDiagnostics] = useState<SnapshotAgeDiagnostics>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const reportRef = useRef<HTMLTextAreaElement>(null);

  const loadDiagnostics = useCallback(async () => {
    setLoading(true);
    setError("");
    setCopyMessage("");
    try {
      setDiagnostics(await getSnapshotAgeDiagnostics());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Diagnostics failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const report = useMemo(() => {
    if (!diagnostics) {
      return "";
    }
    return redactedDiagnosticsReport(appPackage.version, diagnostics);
  }, [diagnostics]);

  async function copyReport() {
    if (!report) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        setCopyMessage("Redacted report copied");
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch {
      const textarea = reportRef.current;
      textarea?.focus();
      textarea?.select();
      try {
        if (document.execCommand("copy")) {
          setCopyMessage("Redacted report copied");
          return;
        }
      } catch {
        // Keep the report selected for manual copy.
      }
      setCopyMessage("Clipboard unavailable. The report is selected; press copy manually.");
    }
  }

  function downloadReport() {
    if (!report || !diagnostics) {
      return;
    }
    const blob = new Blob([report], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFileName(diagnostics.generatedAt);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setCopyMessage("Redacted report download started");
  }

  const totals = diagnostics?.managers.reduce(
    (current, manager) => {
      const run = manager.latestInventoryRun;
      if (!run) {
        return current;
      }
      return {
        runs: current.runs + 1,
        warnings: current.warnings + run.warningCount,
        errors: current.errors + run.errorCount,
        populatedResources: current.populatedResources + run.populatedResourceCount,
        totalResources: current.totalResources + run.totalResourceCount,
        regularSnapshots: current.regularSnapshots + run.regularSnapshotCount,
        activeSnapshots: current.activeSnapshots + run.activeSnapshotCount,
        validDates: current.validDates + run.validDateCount,
        missingDates: current.missingDates + run.missingDateCount,
        invalidDates: current.invalidDates + run.invalidDateCount
      };
    },
    {
      runs: 0,
      warnings: 0,
      errors: 0,
      populatedResources: 0,
      totalResources: 0,
      regularSnapshots: 0,
      activeSnapshots: 0,
      validDates: 0,
      missingDates: 0,
      invalidDates: 0
    }
  );

  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
      <div className="section-heading with-actions">
        <div>
          <div className="diagnostic-heading-icon" aria-hidden="true">
            <Activity size={18} />
          </div>
          <div>
            <h2 id="diagnostics-title">Collection Diagnostics</h2>
            <p>Redacted evidence for troubleshooting inventory collection</p>
          </div>
        </div>
        <div className="section-actions diagnostics-actions">
          <button className="icon-button" type="button" onClick={() => void loadDiagnostics()} title="Refresh diagnostics" aria-label="Refresh diagnostics" disabled={loading}>
            <RefreshCw aria-hidden="true" size={17} className={loading ? "is-spinning" : undefined} />
          </button>
          <button className="button secondary" type="button" onClick={() => void copyReport()} disabled={!report}>
            <ClipboardCopy aria-hidden="true" size={16} />
            Copy report
          </button>
          <button className="button secondary" type="button" onClick={downloadReport} disabled={!report}>
            <Download aria-hidden="true" size={16} />
            Download JSON
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {copyMessage && <p className="form-success" role="status">{copyMessage}</p>}
      {loading && !diagnostics && <p className="muted">Preparing diagnostics</p>}

      {diagnostics && totals && (
        <>
          <section className="diagnostics-summary" aria-label="Collection summary">
            <article className="metric compact">
              <span>Inventory runs</span>
              <strong>{totals.runs.toLocaleString()} / {diagnostics.managerCount.toLocaleString()}</strong>
              <small>latest run available</small>
            </article>
            <article className="metric compact">
              <span>Warnings</span>
              <strong>{totals.warnings.toLocaleString()}</strong>
              <small>reported by latest runs</small>
            </article>
            <article className="metric compact">
              <span>Errors</span>
              <strong>{totals.errors.toLocaleString()}</strong>
              <small>reported by latest runs</small>
            </article>
            <article className="metric compact">
              <span>Resource categories</span>
              <strong>{totals.populatedResources.toLocaleString()} / {totals.totalResources.toLocaleString()}</strong>
              <small>with records returned</small>
            </article>
          </section>

          <section className="diagnostics-date-summary" aria-labelledby="snapshot-date-summary-title">
            <div className="diagnostic-subheading">
              <div>
                <h3 id="snapshot-date-summary-title">Snapshot date health</h3>
                <p>Only VM snapshot date fields; separate from unrelated collection errors.</p>
              </div>
              <span className="state-pill status-muted">Report v{diagnostics.reportVersion}</span>
            </div>
            <div className="diagnostics-date-grid">
              <div><span>Regular snapshots</span><strong>{totals.regularSnapshots.toLocaleString()}</strong></div>
              <div><span>Active snapshots</span><strong>{totals.activeSnapshots.toLocaleString()}</strong></div>
              <div><span>Dates available</span><strong>{totals.validDates.toLocaleString()}</strong></div>
              <div><span>Dates missing</span><strong>{totals.missingDates.toLocaleString()}</strong></div>
              <div><span>Dates invalid</span><strong>{totals.invalidDates.toLocaleString()}</strong></div>
            </div>
          </section>

          <div className="diagnostic-run-list">
            {diagnostics.managers.map((manager, managerIndex) => {
              const run = manager.latestInventoryRun;
              const managerResourceHeadingId = `manager-${managerIndex + 1}-resources`;
              const managerIssueHeadingId = `manager-${managerIndex + 1}-issues`;
              return (
                <article className="diagnostic-run" key={manager.label}>
                  <div className="diagnostic-run-heading">
                    <div>
                      <h3>{manager.name}</h3>
                      <p>{manager.enabled ? "Enabled manager" : "Disabled manager"}</p>
                    </div>
                    {run ? <span className={`state-pill status-${stateClass(run.status)}`}>{run.status}</span> : <span className="state-pill status-muted">No run</span>}
                  </div>
                  {!run ? (
                    <p className="muted">No inventory run is available for this manager.</p>
                  ) : (
                    <>
                      <dl className="diagnostic-values">
                        <div><dt>Collected</dt><dd>{new Date(run.collectedAt).toLocaleString()}</dd></div>
                        <div><dt>oVirt API</dt><dd>{run.apiVersion || "Unknown"}</dd></div>
                        <div><dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd></div>
                        <div><dt>Resources</dt><dd>{run.populatedResourceCount} / {run.totalResourceCount} with records</dd></div>
                        <div><dt>Warnings</dt><dd>{run.warningCount.toLocaleString()}</dd></div>
                        <div><dt>Errors</dt><dd>{run.errorCount.toLocaleString()}</dd></div>
                      </dl>

                      <section className="diagnostic-evidence-section" aria-labelledby={managerResourceHeadingId}>
                        <div className="diagnostic-subheading compact">
                          <div>
                            <h4 id={managerResourceHeadingId}>Resource evidence</h4>
                            <p>Counts and safe issue totals from the latest run.</p>
                          </div>
                        </div>
                        <div className="table-scroll diagnostic-table-scroll">
                          <table className="data-table diagnostic-resource-table">
                            <thead>
                              <tr><th scope="col">Resource</th><th scope="col">State</th><th scope="col">Records</th><th scope="col">Warnings</th><th scope="col">Errors</th></tr>
                            </thead>
                            <tbody>
                              {run.resourceStates.map((resource) => (
                                <tr key={resource.resource}>
                                  <th scope="row">{resourceLabels[resource.resource]}</th>
                                  <td><span className={`state-pill status-${stateClass(resource.state)}`}>{resourceStateLabel(resource.state)}</span></td>
                                  <td>{resourceStateDescription(resource)}</td>
                                  <td>{resource.warningCount.toLocaleString()}</td>
                                  <td>{resource.errorCount.toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>

                      <section className="diagnostic-evidence-section" aria-labelledby={managerIssueHeadingId}>
                        <div className="diagnostic-subheading compact">
                          <div>
                            <h4 id={managerIssueHeadingId}>Issue summary</h4>
                            <p>Stable categories only; no upstream error text is shown.</p>
                          </div>
                        </div>
                        {run.issueFingerprints.length ? (
                          <ul className="diagnostic-fingerprint-list">
                            {run.issueFingerprints.map((fingerprint) => (
                              <li key={fingerprint.fingerprint}>
                                <span className={`state-pill status-${fingerprint.severity === "error" ? "danger" : "warning"}`}>{fingerprint.severity}</span>
                                <span>{formatFingerprint(fingerprint)}</span>
                                <strong>{fingerprint.count.toLocaleString()}</strong>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">No warnings or errors were recorded.</p>
                        )}
                      </section>

                      <div className="diagnostic-findings" aria-label={`${manager.name} snapshot date findings`}>
                        {run.findings.map((finding) => <span className="state-pill status-muted" key={finding}>{findingLabels[finding]}</span>)}
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          <label className="diagnostics-report-label" htmlFor="snapshot-age-report">Redacted report</label>
          <textarea ref={reportRef} id="snapshot-age-report" className="diagnostics-report" value={report} readOnly spellCheck={false} aria-label="Redacted collection diagnostics report" />
        </>
      )}
    </section>
  );
}
