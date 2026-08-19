import { ClipboardCopy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import appPackage from "../../package.json";
import { getSnapshotAgeDiagnostics, type SnapshotAgeDiagnostics, type SnapshotDateFinding } from "./api";

const findingLabels: Record<SnapshotDateFinding, string> = {
  all_snapshot_dates_available: "All snapshot dates available",
  no_vm_snapshots: "No VM snapshots in latest inventory",
  snapshot_dates_missing: "Snapshot dates missing",
  snapshot_date_values_invalid: "Snapshot date values invalid",
  snapshot_detail_requests_failed: "Snapshot detail requests failed",
  snapshot_detail_responses_missing_date: "Snapshot detail responses missing date",
  snapshot_list_requests_failed: "Snapshot list requests failed"
};

export function SnapshotAgeDiagnosticsPage() {
  const [diagnostics, setDiagnostics] = useState<SnapshotAgeDiagnostics>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");

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

  const report = useMemo(
    () =>
      diagnostics
        ? JSON.stringify(
            {
              appVersion: appPackage.version,
              ...diagnostics
            },
            null,
            2
          )
        : "",
    [diagnostics]
  );

  async function copyReport() {
    if (!report) {
      return;
    }
    try {
      await navigator.clipboard.writeText(report);
      setCopyMessage("Redacted report copied");
    } catch {
      setCopyMessage("Clipboard unavailable. Select the report and copy it manually.");
    }
  }

  const totals = diagnostics?.managers.reduce(
    (current, manager) => {
      const run = manager.latestInventoryRun;
      if (!run) {
        return current;
      }
      return {
        regularSnapshots: current.regularSnapshots + run.regularSnapshotCount,
        validDates: current.validDates + run.validDateCount,
        missingDates: current.missingDates + run.missingDateCount,
        invalidDates: current.invalidDates + run.invalidDateCount
      };
    },
    { regularSnapshots: 0, validDates: 0, missingDates: 0, invalidDates: 0 }
  );

  return (
    <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
      <div className="section-heading with-actions">
        <div>
          <h2 id="diagnostics-title">Snapshot Age Diagnostics</h2>
          <p>Redacted collection evidence</p>
        </div>
        <div className="section-actions">
          <button className="icon-button" type="button" onClick={() => void loadDiagnostics()} title="Refresh diagnostics" aria-label="Refresh diagnostics" disabled={loading}>
            <RefreshCw aria-hidden="true" size={17} className={loading ? "is-spinning" : undefined} />
          </button>
          <button className="button" type="button" onClick={() => void copyReport()} disabled={!report}>
            <ClipboardCopy aria-hidden="true" size={16} />
            Copy report
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
      {copyMessage && <p className="form-success" role="status">{copyMessage}</p>}
      {loading && !diagnostics && <p className="muted">Preparing diagnostics</p>}

      {diagnostics && totals && (
        <>
          <section className="diagnostics-summary" aria-label="Snapshot date summary">
            <article className="metric compact">
              <span>Snapshot records</span>
              <strong>{totals.regularSnapshots.toLocaleString()}</strong>
            </article>
            <article className="metric compact">
              <span>Dates available</span>
              <strong>{totals.validDates.toLocaleString()}</strong>
            </article>
            <article className="metric compact">
              <span>Dates missing</span>
              <strong>{totals.missingDates.toLocaleString()}</strong>
            </article>
            <article className="metric compact">
              <span>Dates invalid</span>
              <strong>{totals.invalidDates.toLocaleString()}</strong>
            </article>
          </section>

          <div className="diagnostic-run-list">
            {diagnostics.managers.map((manager) => {
              const run = manager.latestInventoryRun;
              return (
                <article className="diagnostic-run" key={manager.label}>
                  <div className="diagnostic-run-heading">
                    <div>
                      <h3>{manager.label}</h3>
                      <p>{manager.enabled ? "Enabled" : "Disabled"}</p>
                    </div>
                    {run && <span className={`state-pill status-${run.status === "success" ? "success" : "warning"}`}>{run.status}</span>}
                  </div>
                  {!run ? (
                    <p className="muted">No successful or partial inventory collection is available.</p>
                  ) : (
                    <>
                      <dl className="diagnostic-values">
                        <div>
                          <dt>Collected</dt>
                          <dd>{new Date(run.collectedAt).toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>oVirt API</dt>
                          <dd>{run.apiVersion || "Unknown"}</dd>
                        </div>
                        <div>
                          <dt>Snapshot records</dt>
                          <dd>{run.regularSnapshotCount.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Date hydration failures</dt>
                          <dd>{run.snapshotDateIssueCounts.detailCollectionFailed.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Detail response lacks date</dt>
                          <dd>{run.snapshotDateIssueCounts.noCreationDate.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>Snapshot list failures</dt>
                          <dd>{run.snapshotDateIssueCounts.listCollectionFailed.toLocaleString()}</dd>
                        </div>
                      </dl>
                      <div className="diagnostic-findings" aria-label="Diagnostic findings">
                        {run.findings.map((finding) => (
                          <span className="state-pill status-muted" key={finding}>
                            {findingLabels[finding]}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          <label className="diagnostics-report-label" htmlFor="snapshot-age-report">
            Redacted report
          </label>
          <textarea id="snapshot-age-report" className="diagnostics-report" value={report} readOnly spellCheck={false} aria-label="Redacted snapshot age diagnostics report" />
        </>
      )}
    </section>
  );
}
