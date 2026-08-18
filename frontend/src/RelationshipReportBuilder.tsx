import { Download, GripVertical, Layers3, RefreshCw, RotateCcw, Server, Table2, Waypoints } from "lucide-react";
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

interface HostOption {
  id: string;
  name: string;
  managerId: string;
  clusterId: string;
  vmCount: number;
}

const relationshipExportColumns = [
  "hostName",
  "vmName",
  "powerState",
  "ipAddresses",
  "vcpuCount",
  "allocatedRamMiB",
  "virtualDisks",
  "storageDomainNames"
] as const;
const emptyRelationshipRows: RelationshipRow[] = [];

export function RelationshipReportBuilder({ error, loading, relationships, onRefresh }: RelationshipReportBuilderProps) {
  const rows = relationships?.rows ?? emptyRelationshipRows;
  const managers = useMemo(() => managerOptions(rows), [rows]);
  const [selectedManagerId, setSelectedManagerId] = useState("");
  const [selectedClusterId, setSelectedClusterId] = useState("");
  const [selectedHostId, setSelectedHostId] = useState("");
  const [draggingLabel, setDraggingLabel] = useState("");

  const selectedManager = managers.find((manager) => manager.id === selectedManagerId);
  const clusters = useMemo(() => clusterOptions(rows, selectedManagerId), [rows, selectedManagerId]);
  const selectedCluster = clusters.find((cluster) => cluster.id === selectedClusterId);
  const clusterVmRows = useMemo(
    () => rows.filter((row) => row.managerId === selectedManagerId && row.clusterId === selectedClusterId && row.vmId),
    [rows, selectedClusterId, selectedManagerId]
  );
  const hosts = useMemo(() => hostOptions(clusterVmRows), [clusterVmRows]);
  const selectedHost = hosts.find((host) => host.id === selectedHostId);
  const vmRows = useMemo(
    () => (selectedHostId ? clusterVmRows.filter((row) => row.hostId === selectedHostId) : clusterVmRows),
    [clusterVmRows, selectedHostId]
  );
  const clusterStorageDomains = useMemo(
    () => uniqueNames(clusterVmRows.flatMap((row) => relationshipStorageDomainNames(row))),
    [clusterVmRows]
  );

  function resetSelection() {
    setSelectedManagerId("");
    setSelectedClusterId("");
    setSelectedHostId("");
  }

  function handleManagerDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const managerId = event.dataTransfer.getData("application/x-relationship-manager");
    if (!managerId) {
      return;
    }
    setSelectedManagerId(managerId);
    setSelectedClusterId("");
    setSelectedHostId("");
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
    setSelectedHostId("");
    setDraggingLabel("");
  }

  function handleHostDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const hostId = event.dataTransfer.getData("application/x-relationship-host");
    const clusterId = event.dataTransfer.getData("application/x-relationship-cluster");
    const managerId = event.dataTransfer.getData("application/x-relationship-manager");
    if (!hostId || clusterId !== selectedClusterId || managerId !== selectedManagerId) {
      return;
    }
    setSelectedHostId(hostId);
    setDraggingLabel("");
  }

  return (
    <section className="relationships-panel simple-relationships-page" aria-labelledby="relationships-title">
      <div className="section-heading with-actions">
        <div>
          <Waypoints aria-hidden="true" size={20} />
          <div>
            <h2 id="relationships-title">Topology</h2>
            <p>{relationships ? `${relationships.total} manager, cluster, host, VM topology records` : "Build a topology table by dragging items."}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button secondary" type="button" disabled={loading} aria-busy={loading} onClick={onRefresh}>
            <RefreshCw aria-hidden="true" size={16} />
            {loading ? "Refreshing" : "Refresh"}
          </button>
          <a
            className="button secondary"
            href={relationshipsExportUrl([...relationshipExportColumns], {
              managerId: selectedManager?.id,
              clusterId: selectedCluster?.id,
              hostId: selectedHost?.id
            })}
          >
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
      {loading && <p className="muted">Loading topology</p>}

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
                  setSelectedHostId("");
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
            {!managers.length && <p className="empty-state">No managers available from topology data</p>}
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
              <h3>Topology Table</h3>
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
                    onClick={() => {
                      setSelectedClusterId(cluster.id);
                      setSelectedHostId("");
                    }}
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
                    ? `${clusterVmRows.length} VMs, ${clusterStorageDomains.length} storage domains from ${selectedCluster.name}`
                    : "Drag a cluster here to show related VMs."}
                </p>
              </div>
            </div>
          )}

          {selectedCluster && (
            <section className="relationship-step-panel" aria-labelledby="relationship-hosts-title">
              <div className="relationship-panel-heading">
                <Server aria-hidden="true" size={17} />
                <h3 id="relationship-hosts-title">Hosts Under {selectedCluster.name}</h3>
              </div>
              <div className="relationship-draggable-list cluster-list">
                {hosts.map((host) => (
                  <button
                    aria-pressed={host.id === selectedHostId}
                    className="relationship-draggable"
                    draggable
                    key={host.id}
                    type="button"
                    onClick={() => setSelectedHostId(host.id)}
                    onDragEnd={() => setDraggingLabel("")}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/x-relationship-manager", host.managerId);
                      event.dataTransfer.setData("application/x-relationship-cluster", host.clusterId);
                      event.dataTransfer.setData("application/x-relationship-host", host.id);
                      setDraggingLabel(host.name);
                    }}
                  >
                    <GripVertical aria-hidden="true" size={15} />
                    <span>
                      <strong>{host.name}</strong>
                      <small>{host.vmCount} VMs</small>
                    </span>
                  </button>
                ))}
                {!hosts.length && <p className="empty-state">No hosts found for this cluster</p>}
              </div>
            </section>
          )}

          {selectedCluster && (
            <div
              className={`relationship-drop-zone host-target ${selectedHost ? "has-selection" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleHostDrop}
            >
              <Server aria-hidden="true" size={18} />
              <div>
                <h3>{selectedHost ? selectedHost.name : "All Hosts"}</h3>
                <p>
                  {selectedHost
                    ? `${vmRows.length} VMs from ${selectedHost.name}`
                    : `${clusterVmRows.length} VMs across all hosts. Host selection is optional.`}
                </p>
              </div>
              {selectedHost && (
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setSelectedHostId("")}
                  title="Show all hosts"
                  aria-label="Show all hosts"
                >
                  <RotateCcw aria-hidden="true" size={16} />
                </button>
              )}
            </div>
          )}

          {selectedCluster && (
            <section className="table-card relationship-table-card" aria-labelledby="relationship-vm-table-title">
              <div className="table-title">
                <h3 id="relationship-vm-table-title">Related VMs</h3>
                <div className="table-hint relationship-table-context">
                  <span>Manager: {selectedManager?.name}</span>
                  <span>Cluster: {selectedCluster.name}</span>
                  {selectedHost && <span>Host: {selectedHost.name}</span>}
                  {vmRows[0]?.collectedAt && <span>Collected At: {new Date(vmRows[0].collectedAt).toLocaleString()}</span>}
                </div>
              </div>
              <div className="table-scroll relationship-table-scroll">
                <table className="data-table relationship-data-table">
                  <thead>
                    <tr>
                      <th scope="col">Host</th>
                      <th scope="col">VM</th>
                      <th scope="col">Power State</th>
                      <th scope="col">IP Address</th>
                      <th scope="col">vCPU Count</th>
                      <th scope="col">Allocated RAM</th>
                      <th scope="col">Virtual Disks</th>
                      <th scope="col">Storage Domains</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vmRows.map((row) => (
                      <tr key={`${row.managerId}:${row.clusterId}:${row.hostId}:${row.vmId}:${row.snapshotId}`}>
                        <td>{row.hostName ?? row.hostId ?? "-"}</td>
                        <td>{row.vmName ?? row.vmId}</td>
                        <td>{row.powerState ?? "-"}</td>
                        <td>{formatIpAddresses(row)}</td>
                        <td>{row.vcpuCount ?? "-"}</td>
                        <td>{formatMemory(row.allocatedRamMiB)}</td>
                        <td className="cluster-vm-disks-cell">
                          {row.virtualDisks?.length ? (
                            <ul className="cluster-vm-disk-list" aria-label={`Virtual disks for ${row.vmName ?? row.vmId}`}>
                              {row.virtualDisks.map((disk, index) => (
                                <li key={`${disk.name}-${index}`}>
                                  <span className="cluster-vm-disk-name">{disk.name}</span>
                                  <span className="cluster-vm-disk-size">{formatGib(disk.sizeGiB)}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>{formatStorageDomains(relationshipStorageDomainNames(row))}</td>
                      </tr>
                    ))}
                    {!vmRows.length && (
                      <tr>
                        <td className="empty-table-cell" colSpan={8}>
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

function hostOptions(rows: RelationshipRow[]): HostOption[] {
  const hosts = new Map<string, HostOption>();
  for (const row of rows) {
    if (!row.hostId || !row.clusterId) {
      continue;
    }
    const host = hosts.get(row.hostId) ?? {
      id: row.hostId,
      name: row.hostName ?? row.hostId,
      managerId: row.managerId,
      clusterId: row.clusterId,
      vmCount: 0
    };
    host.vmCount += row.vmId ? 1 : 0;
    hosts.set(row.hostId, host);
  }
  return [...hosts.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function formatStorageDomains(names: string[]): string {
  return names.length ? names.join(", ") : "-";
}

function formatIpAddresses(row: RelationshipRow): string {
  return row.ipAddresses?.length ? row.ipAddresses.join(", ") : "-";
}

function formatMemory(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  const gib = value / 1024;
  const formattedGib = Number.isInteger(gib) ? gib.toLocaleString() : gib.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${value.toLocaleString()} MiB (~${formattedGib} GiB)`;
}

function formatGib(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toLocaleString()} GiB`;
}

function relationshipStorageDomainNames(row: RelationshipRow): string[] {
  return Array.isArray(row.storageDomainNames) ? row.storageDomainNames : [];
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
