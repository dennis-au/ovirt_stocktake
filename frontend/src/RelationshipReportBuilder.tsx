import { Download, GripVertical, Layers3, RefreshCw, RotateCcw, Server, Table2 } from "lucide-react";
import { type DragEvent, useMemo, useState } from "react";
import { relationshipsExportUrl, type RelationshipResponse, type RelationshipRow } from "./api";

interface RelationshipReportBuilderProps {
  error: string;
  loading: boolean;
  relationships: RelationshipResponse | undefined;
  onRefresh: () => void;
}

interface ManagerOption {
  id: string;
  name: string;
  url: string;
  vmCount: number;
  clusterCount: number;
}

interface ClusterOption {
  id: string;
  name: string;
  managerId: string;
  managerName: string;
  vmCount: number;
  storageDomainCount: number;
}

const relationshipExportColumns = ["managerName", "clusterName", "hostName", "vmName", "storageDomainNames", "collectedAt"] as const;
const emptyRelationshipRows: RelationshipRow[] = [];

export function RelationshipReportBuilder({ error, loading, relationships, onRefresh }: RelationshipReportBuilderProps) {
  const rows = relationships?.rows ?? emptyRelationshipRows;
  const managers = useMemo(() => managerOptions(rows), [rows]);
  const [selectedManagerId, setSelectedManagerId] = useState("");
  const [selectedClusterId, setSelectedClusterId] = useState("");
  const [draggingLabel, setDraggingLabel] = useState("");

  const selectedManager = managers.find((manager) => manager.id === selectedManagerId);
  const clusters = useMemo(() => clusterOptions(rows, selectedManagerId), [rows, selectedManagerId]);
  const selectedCluster = clusters.find((cluster) => cluster.id === selectedClusterId);
  const vmRows = useMemo(
    () => rows.filter((row) => row.managerId === selectedManagerId && row.clusterId === selectedClusterId && row.vmId),
    [rows, selectedClusterId, selectedManagerId]
  );
  const selectedStorageDomains = useMemo(
    () => uniqueNames(vmRows.flatMap((row) => relationshipStorageDomainNames(row))),
    [vmRows]
  );

  function resetSelection() {
    setSelectedManagerId("");
    setSelectedClusterId("");
  }

  function handleManagerDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const managerId = event.dataTransfer.getData("application/x-relationship-manager");
    if (!managerId) {
      return;
    }
    setSelectedManagerId(managerId);
    setSelectedClusterId("");
    setDraggingLabel("");
  }

  function handleClusterDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const clusterId = event.dataTransfer.getData("application/x-relationship-cluster");
    const managerId = event.dataTransfer.getData("application/x-relationship-manager");
    if (!clusterId || managerId !== selectedManagerId) {
      return;
    }
    setSelectedClusterId(clusterId);
    setDraggingLabel("");
  }

  return (
    <section className="relationships-panel simple-relationships-page" aria-labelledby="relationships-title">
      <div className="section-heading with-actions">
        <div>
          <Layers3 aria-hidden="true" size={20} />
          <div>
            <h2 id="relationships-title">Relationships</h2>
            <p>{relationships ? `${relationships.total} manager, cluster, host, VM relationships` : "Build a relationship table by dragging items."}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button secondary" type="button" disabled={loading} onClick={onRefresh}>
            <RefreshCw aria-hidden="true" size={16} />
            Refresh
          </button>
          <a className="button secondary" href={relationshipsExportUrl([...relationshipExportColumns])}>
            <Download aria-hidden="true" size={16} />
            Export CSV
          </a>
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="muted">Loading relationships</p>}

      <div className="relationship-builder-shell">
        <aside className="relationship-source-panel" aria-label="Managers">
          <div className="relationship-panel-heading">
            <Server aria-hidden="true" size={17} />
            <h3>Managers</h3>
          </div>
          <div className="relationship-draggable-list">
            {managers.map((manager) => (
              <button
                className="relationship-draggable"
                draggable
                key={manager.id}
                type="button"
                onClick={() => {
                  setSelectedManagerId(manager.id);
                  setSelectedClusterId("");
                }}
                onDragEnd={() => setDraggingLabel("")}
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/x-relationship-manager", manager.id);
                  setDraggingLabel(manager.name);
                }}
              >
                <GripVertical aria-hidden="true" size={15} />
                <span>
                  <strong>{manager.name}</strong>
                  <small>
                    {manager.clusterCount} clusters, {manager.vmCount} VMs
                  </small>
                </span>
              </button>
            ))}
            {!managers.length && <p className="empty-state">No managers available from relationship data</p>}
          </div>
        </aside>

        <main className="relationship-table-builder" aria-label="Relationship table builder">
          <div
            className={`relationship-drop-zone ${selectedManager ? "has-selection" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleManagerDrop}
          >
            <Table2 aria-hidden="true" size={18} />
            <div>
              <h3>Relationship Table</h3>
              <p>{selectedManager ? selectedManager.name : draggingLabel ? `Drop ${draggingLabel} here` : "Drag a manager here to start from a blank table."}</p>
            </div>
            {selectedManager && (
              <button className="icon-button" type="button" onClick={resetSelection} title="Clear table" aria-label="Clear table">
                <RotateCcw aria-hidden="true" size={16} />
              </button>
            )}
          </div>

          {selectedManager && (
            <section className="relationship-step-panel" aria-labelledby="relationship-clusters-title">
              <div className="relationship-panel-heading">
                <Layers3 aria-hidden="true" size={17} />
                <h3 id="relationship-clusters-title">Clusters Under {selectedManager.name}</h3>
              </div>
              <div className="relationship-draggable-list cluster-list">
                {clusters.map((cluster) => (
                  <button
                    className="relationship-draggable"
                    draggable
                    key={cluster.id}
                    type="button"
                    onClick={() => setSelectedClusterId(cluster.id)}
                    onDragEnd={() => setDraggingLabel("")}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-relationship-manager", cluster.managerId);
                      event.dataTransfer.setData("application/x-relationship-cluster", cluster.id);
                      setDraggingLabel(cluster.name);
                    }}
                  >
                    <GripVertical aria-hidden="true" size={15} />
                    <span>
                      <strong>{cluster.name}</strong>
                      <small>
                        {cluster.vmCount} VMs, {cluster.storageDomainCount} storage domains
                      </small>
                    </span>
                  </button>
                ))}
                {!clusters.length && <p className="empty-state">No clusters found for this manager</p>}
              </div>
            </section>
          )}

          {selectedManager && (
            <div
              className={`relationship-drop-zone cluster-target ${selectedCluster ? "has-selection" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleClusterDrop}
            >
              <Table2 aria-hidden="true" size={18} />
              <div>
                <h3>{selectedCluster ? selectedCluster.name : "Drop Cluster"}</h3>
                <p>
                  {selectedCluster
                    ? `${vmRows.length} VMs, ${selectedStorageDomains.length} storage domains from ${selectedCluster.name}`
                    : "Drag a cluster here to show related VMs."}
                </p>
              </div>
            </div>
          )}

          {selectedCluster && (
            <section className="table-card" aria-labelledby="relationship-vm-table-title">
              <div className="table-title">
                <h3 id="relationship-vm-table-title">Related VMs</h3>
                <span className="table-hint">
                  {selectedManager?.name} / {selectedCluster.name}
                </span>
              </div>
              <div className="table-scroll">
                <table className="data-table relationship-data-table">
                  <thead>
                    <tr>
                      <th scope="col">VM</th>
                      <th scope="col">Host</th>
                      <th scope="col">Storage Domains</th>
                      <th scope="col">Cluster</th>
                      <th scope="col">Manager</th>
                      <th scope="col">Collected At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vmRows.map((row) => (
                      <tr key={`${row.managerId}:${row.clusterId}:${row.hostId}:${row.vmId}:${row.snapshotId}`}>
                        <td>{row.vmName ?? row.vmId}</td>
                        <td>{row.hostName ?? row.hostId ?? "-"}</td>
                        <td>{formatStorageDomains(relationshipStorageDomainNames(row))}</td>
                        <td>{row.clusterName ?? row.clusterId ?? "-"}</td>
                        <td>{row.managerName}</td>
                        <td>{new Date(row.collectedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                    {!vmRows.length && (
                      <tr>
                        <td className="empty-table-cell" colSpan={6}>
                          No VMs found for this cluster
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
    </section>
  );
}

function managerOptions(rows: RelationshipRow[]): ManagerOption[] {
  const managers = new Map<string, ManagerOption>();
  for (const row of rows) {
    const manager = managers.get(row.managerId) ?? {
      id: row.managerId,
      name: row.managerName,
      url: row.managerUrl,
      clusterCount: 0,
      vmCount: 0
    };
    manager.vmCount += row.vmId ? 1 : 0;
    managers.set(row.managerId, manager);
  }

  return [...managers.values()]
    .map((manager) => ({
      ...manager,
      clusterCount: new Set(rows.filter((row) => row.managerId === manager.id).map((row) => row.clusterId).filter(Boolean)).size
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function clusterOptions(rows: RelationshipRow[], managerId: string): ClusterOption[] {
  const clusters = new Map<string, ClusterOption>();
  for (const row of rows) {
    if (row.managerId !== managerId || !row.clusterId) {
      continue;
    }
    const cluster = clusters.get(row.clusterId) ?? {
      id: row.clusterId,
      name: row.clusterName ?? row.clusterId,
      managerId: row.managerId,
      managerName: row.managerName,
      vmCount: 0,
      storageDomainCount: 0
    };
    cluster.vmCount += row.vmId ? 1 : 0;
    cluster.storageDomainCount = uniqueNames([
      ...rows
        .filter((item) => item.managerId === row.managerId && item.clusterId === row.clusterId)
        .flatMap((item) => relationshipStorageDomainNames(item))
    ]).length;
    clusters.set(row.clusterId, cluster);
  }
  return [...clusters.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function formatStorageDomains(names: string[]): string {
  return names.length ? names.join(", ") : "-";
}

function relationshipStorageDomainNames(row: RelationshipRow): string[] {
  return Array.isArray(row.storageDomainNames) ? row.storageDomainNames : [];
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
