import { ChartLine, Clock3, Cpu, Database, HardDrive, Maximize2, MemoryStick, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getCapacity } from "./api";
import {
  capacityCoverage,
  capacityPeak,
  capacityPercentile,
  capacityRatio,
  capacityTimeline,
  filterCapacitySamples,
  type CapacityDataset,
  type CapacityRange,
  type CapacityResource,
  type CapacityResourceTab,
  type CapacitySample,
  type CapacityScope
} from "./capacity-model";

type MetricKey = "cpuPercent" | "memoryPercent" | "storagePercent" | "networkReceiveMbps" | "networkTransmitMbps";
type CapacityViewMode = "combined" | "clusters";
type TrendPoint = { timestamp: string; primary?: number; secondary?: number };
type TrendChartProps = {
  title: string;
  description: string;
  points: TrendPoint[];
  unit: string;
  primaryLabel: string;
  secondaryLabel?: string;
  primaryColor: string;
  secondaryColor?: string;
  fixedMax?: number;
};

const ranges: Array<{ value: CapacityRange; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" }
];

const tabs: Array<{ value: CapacityResourceTab; label: string }> = [
  { value: "clusters", label: "Clusters" },
  { value: "hosts", label: "Hosts" },
  { value: "vms", label: "VMs" },
  { value: "storageDomains", label: "Storage Domains" }
];

export function CapacityPage() {
  const [dataset, setDataset] = useState<CapacityDataset>();
  const [range, setRange] = useState<CapacityRange>("30d");
  const [scope, setScope] = useState<CapacityScope>({});
  const [viewMode, setViewMode] = useState<CapacityViewMode>("combined");
  const [activeTab, setActiveTab] = useState<CapacityResourceTab>("clusters");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setDataset(await getCapacity());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Capacity data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCapacity();
  }, [loadCapacity]);

  const resources = dataset?.resources ?? [];
  const managers = uniqueOptions(resources.filter((resource) => resource.managerId), "managerId", "managerName");
  const clusters = uniqueOptions(
    resources.filter((resource) => (!scope.managerId || resource.managerId === scope.managerId) && resource.clusterId),
    "clusterId",
    "clusterName"
  );
  const hosts = uniqueOptions(
    resources.filter(
      (resource) =>
        resource.hostId &&
        (!scope.managerId || resource.managerId === scope.managerId) &&
        (!scope.clusterId || resource.clusterId === scope.clusterId)
    ),
    "hostId",
    "hostName"
  );
  const vms = resources
    .filter(
      (resource) =>
        resource.type === "vm" &&
        (!scope.managerId || resource.managerId === scope.managerId) &&
        (!scope.clusterId || resource.clusterId === scope.clusterId) &&
        (!scope.hostId || resource.hostId === scope.hostId)
    )
    .map((resource) => ({ value: resource.id, label: resource.name }));

  const scopedSamples = useMemo(
    () => (dataset ? filterCapacitySamples(dataset.samples, range, scope, dataset.generatedAt) : []),
    [dataset, range, scope]
  );
  const expectedTimestamps = dataset
    ? capacityTimeline(range, dataset.generatedAt, dataset.expectedIntervalMinutes)
    : [];
  const cpuSamples = metricSamples(scopedSamples, scope.vmId ? "vm" : "host");
  const memorySamples = metricSamples(scopedSamples, scope.vmId ? "vm" : "host");
  const storageSamples = dataset
    ? metricSamples(
        filterCapacitySamples(
          dataset.samples,
          range,
          { managerId: scope.managerId, clusterId: scope.clusterId, storageDomainId: scope.storageDomainId },
          dataset.generatedAt
        ),
        "storageDomain"
      )
    : [];
  const networkSamples = metricSamples(scopedSamples, "vm");
  const cpuTrend = aggregateTrend(cpuSamples, "cpuPercent", undefined, resources, expectedTimestamps);
  const memoryTrend = aggregateTrend(memorySamples, "memoryPercent", undefined, resources, expectedTimestamps);
  const storageTrend = aggregateTrend(storageSamples, "storagePercent", undefined, resources, expectedTimestamps);
  const networkTrend = aggregateTrend(networkSamples, "networkReceiveMbps", "networkTransmitMbps", resources, expectedTimestamps, true);
  const allocation = capacityAllocation(resources, scope);
  const freshnessSamples = scope.storageDomainId
    ? storageSamples
    : scope.vmId
      ? networkSamples
      : scope.hostId
        ? cpuSamples
        : scopedSamples;
  const latestTimestamp = latestSampleTimestamp(freshnessSamples);
  const overallCoverage = averageCoverage([
    trendCoverage(cpuTrend),
    trendCoverage(memoryTrend),
    trendCoverage(storageTrend),
    trendCoverage(networkTrend)
  ]);
  const visibleRows = resourcesForTab(resources, activeTab, scope);
  const splitClusters = resources
    .filter((resource) => resource.type === "cluster" && (!scope.managerId || resource.managerId === scope.managerId))
    .sort((left, right) => left.managerName.localeCompare(right.managerName) || left.name.localeCompare(right.name));
  const stale = latestTimestamp ? Date.parse(dataset?.generatedAt ?? latestTimestamp) - Date.parse(latestTimestamp) > 24 * 60 * 60 * 1000 : false;

  function handleScopeChange(nextScope: CapacityScope) {
    setScope(nextScope);
    if (nextScope.clusterId || nextScope.hostId || nextScope.vmId || nextScope.storageDomainId) {
      setViewMode("combined");
    }
  }

  function handleViewModeChange(nextMode: CapacityViewMode) {
    setViewMode(nextMode);
    if (nextMode === "clusters") {
      setScope({ managerId: scope.managerId });
    }
  }

  function handleRefresh() {
    if (loading) {
      return;
    }
    void loadCapacity();
  }

  if (!dataset) {
    return loadError ? <CapacityUnavailable detail={loadError} /> : <p className="muted">Loading capacity data</p>;
  }

  if (!dataset.metricsAvailable) {
    return <CapacityUnavailable detail="Run capacity metrics collection after configuring a supported PostgreSQL metrics backend." />;
  }

  return (
    <section className="capacity-panel" aria-labelledby="capacity-title">
      <div className="section-heading with-actions">
        <div>
          <ChartLine aria-hidden="true" size={20} />
          <div>
            <h2 id="capacity-title">Capacity</h2>
            <p>Resource allocation and measured utilization across the selected scope.</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button secondary" type="button" disabled={loading} aria-busy={loading} onClick={handleRefresh}>
            <RefreshCw aria-hidden="true" size={16} />
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      <form className="capacity-toolbar" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="capacity-view-control">
          <legend>View</legend>
          <div className="capacity-view-toggle">
            <button
              type="button"
              aria-pressed={viewMode === "combined"}
              className={viewMode === "combined" ? "active" : ""}
              onClick={() => handleViewModeChange("combined")}
            >
              Combined
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "clusters"}
              className={viewMode === "clusters" ? "active" : ""}
              onClick={() => handleViewModeChange("clusters")}
            >
              By cluster
            </button>
          </div>
        </fieldset>
        <label>
          <span>Range</span>
          <select value={range} onChange={(event) => setRange(event.currentTarget.value as CapacityRange)}>
            {ranges.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Manager</span>
          <select value={scope.managerId ?? ""} onChange={(event) => handleScopeChange(event.currentTarget.value ? { managerId: event.currentTarget.value } : {})}>
            <option value="">All managers</option>
            {managers.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>Cluster</span>
          <select
            disabled={viewMode === "clusters"}
            value={scope.clusterId ?? ""}
            onChange={(event) => handleScopeChange({ managerId: scope.managerId, ...(event.currentTarget.value ? { clusterId: event.currentTarget.value } : {}) })}
          >
            <option value="">All clusters</option>
            {clusters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>Host</span>
          <select
            disabled={viewMode === "clusters"}
            value={scope.hostId ?? ""}
            onChange={(event) => handleScopeChange({ managerId: scope.managerId, clusterId: scope.clusterId, ...(event.currentTarget.value ? { hostId: event.currentTarget.value } : {}) })}
          >
            <option value="">All hosts</option>
            {hosts.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>VM</span>
          <select
            disabled={viewMode === "clusters"}
            value={scope.vmId ?? ""}
            onChange={(event) => handleScopeChange({ managerId: scope.managerId, clusterId: scope.clusterId, hostId: scope.hostId, ...(event.currentTarget.value ? { vmId: event.currentTarget.value } : {}) })}
          >
            <option value="">All VMs</option>
            {vms.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </form>

      <CapacityBreadcrumb resources={resources} scope={scope} onChange={handleScopeChange} />

      <div className="capacity-status-row" aria-label="Capacity data status">
        <span className={`state-pill ${overallCoverage < 80 ? "status-partial" : "status-success"}`}>{formatPercent(overallCoverage)} data available</span>
        <span className={`state-pill ${stale ? "status-failed" : "status-muted"}`}>{latestTimestamp ? `${stale ? "Stale" : "Latest"}: ${formatTimestamp(latestTimestamp)}` : "No matching samples"}</span>
        <span className="state-pill status-muted">{formatRangeLabel(range)} range</span>
      </div>

      {viewMode === "combined" ? (
        <>
          <section className="capacity-chart-grid" aria-label="Capacity trends">
            <TrendChart title="CPU Utilization" description="Capacity-weighted usage" points={cpuTrend} unit="%" primaryLabel="CPU" primaryColor="#00704a" fixedMax={100} />
            <TrendChart title="Memory Utilization" description="Capacity-weighted usage" points={memoryTrend} unit="%" primaryLabel="Memory" primaryColor="#2563eb" fixedMax={100} />
            <TrendChart title="Storage Used" description="Capacity-weighted consumption" points={storageTrend} unit="%" primaryLabel="Used" primaryColor="#b45309" fixedMax={100} />
            <TrendChart
              title="VM Network Throughput"
              description="Aggregated guest traffic"
              points={networkTrend}
              unit=" Mbps"
              primaryLabel="Receive"
              secondaryLabel="Transmit"
              primaryColor="#0f766e"
              secondaryColor="#9333ea"
            />
          </section>

          <CapacityAllocation allocation={allocation} latestTimestamp={latestTimestamp} coverage={overallCoverage} />
        </>
      ) : (
        <CapacityClusterSplit
          clusters={splitClusters}
          dataset={dataset}
          range={range}
          resources={resources}
          timestamps={expectedTimestamps}
          onSelect={handleScopeChange}
        />
      )}

      <section className="capacity-resource-section" aria-labelledby="capacity-resource-title">
        <div className="capacity-tabs" role="tablist" aria-label="Capacity resources">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.value}
              className={activeTab === tab.value ? "active" : ""}
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <CapacityResourceTable
          dataset={dataset}
          range={range}
          rows={visibleRows}
          tab={activeTab}
          onSelect={(resource) => handleScopeChange(scopeForResource(resource))}
        />
      </section>
    </section>
  );
}

function CapacityUnavailable({ detail }: { detail?: string }) {
  return (
    <section className="capacity-panel" aria-labelledby="capacity-title">
      <div className="section-heading">
        <ChartLine aria-hidden="true" size={20} />
        <div>
          <h2 id="capacity-title">Capacity</h2>
          <p>Resource utilization and allocation.</p>
        </div>
      </div>
      <div className="empty-state capacity-unavailable">
        <Database aria-hidden="true" size={28} />
        <strong>Capacity metrics are unavailable</strong>
        <span>{detail ?? "Connect a supported metrics backend to populate this page."}</span>
      </div>
    </section>
  );
}

function CapacityBreadcrumb({ resources, scope, onChange }: { resources: CapacityResource[]; scope: CapacityScope; onChange: (scope: CapacityScope) => void }) {
  const manager = scope.managerId
    ? resources.find((resource) => resource.managerId === scope.managerId)?.managerName
    : undefined;
  const cluster = scope.clusterId
    ? resources.find((resource) => resource.clusterId === scope.clusterId)?.clusterName
    : undefined;
  const host = scope.hostId
    ? resources.find((resource) => resource.hostId === scope.hostId)?.hostName
    : undefined;
  const vm = scope.vmId
    ? resources.find((resource) => resource.vmId === scope.vmId)?.name
    : undefined;
  const storage = scope.storageDomainId
    ? resources.find((resource) => resource.storageDomainId === scope.storageDomainId)?.name
    : undefined;
  return (
    <nav className="capacity-breadcrumb" aria-label="Capacity scope">
      <button type="button" onClick={() => onChange({})}>Estate</button>
      {manager && <><span>/</span><button type="button" onClick={() => onChange({ managerId: scope.managerId })}>{manager}</button></>}
      {cluster && <><span>/</span><button type="button" onClick={() => onChange({ managerId: scope.managerId, clusterId: scope.clusterId })}>{cluster}</button></>}
      {host && <><span>/</span><button type="button" onClick={() => onChange({ managerId: scope.managerId, clusterId: scope.clusterId, hostId: scope.hostId })}>{host}</button></>}
      {vm && <><span>/</span><span aria-current="page">{vm}</span></>}
      {storage && <><span>/</span><span aria-current="page">{storage}</span></>}
    </nav>
  );
}

function TrendChart(props: TrendChartProps) {
  const primaryValues = props.points.map((point) => point.primary);
  const secondaryValues = props.points.map((point) => point.secondary);
  const allValues = [...primaryValues, ...secondaryValues].filter((value): value is number => value !== undefined);
  const maxValue = props.fixedMax ?? Math.max(1, ...(allValues.length ? allValues : [1]));
  const sampledPoints = downsample(props.points, 64);
  const current = latestPresent(primaryValues);
  const p95 = capacityPercentile(primaryValues, 95);
  const peak = capacityPeak(primaryValues);
  const coverage = capacityCoverage(primaryValues);
  const primaryPaths = linePaths(sampledPoints, "primary", maxValue);
  const secondaryPaths = props.secondaryLabel ? linePaths(sampledPoints, "secondary", maxValue) : [];
  const summary = `${props.title}: current ${formatMetric(current, props.unit)}, P95 ${formatMetric(p95, props.unit)}, peak ${formatMetric(peak, props.unit)}, data available ${formatPercent(coverage)}`;

  return (
    <article className="capacity-chart-card">
      <div className="capacity-chart-header">
        <div>
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        <span className={`state-pill ${coverage < 80 ? "status-partial" : "status-muted"}`}>{formatPercent(coverage)}</span>
      </div>
      <div className="capacity-chart-stats" aria-label={summary}>
        <span><small>Current</small><strong>{formatMetric(current, props.unit)}</strong></span>
        <span><small>P95</small><strong>{formatMetric(p95, props.unit)}</strong></span>
        <span><small>Peak</small><strong>{formatMetric(peak, props.unit)}</strong></span>
      </div>
      <svg className="capacity-chart" viewBox="0 0 640 220" role="img" aria-label={summary} preserveAspectRatio="none">
        {[0, 25, 50, 75, 100].map((percent) => {
          const y = 190 - (percent / 100) * 150;
          return <line key={percent} x1="44" x2="624" y1={y} y2={y} className="capacity-grid-line" />;
        })}
        <text x="6" y="44" className="capacity-axis-label">{formatAxis(maxValue, props.unit)}</text>
        <text x="18" y="194" className="capacity-axis-label">0</text>
        {primaryPaths.map((path, index) => <path key={`primary-${index}`} d={path} fill="none" stroke={props.primaryColor} strokeWidth="3" vectorEffect="non-scaling-stroke" />)}
        {secondaryPaths.map((path, index) => <path key={`secondary-${index}`} d={path} fill="none" stroke={props.secondaryColor} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
        {allValues.length === 0 && <text x="334" y="120" textAnchor="middle" className="capacity-empty-label">No samples for this scope</text>}
        {sampledPoints.map((point, index) => point.primary === undefined ? null : (
          <circle
            key={`${point.timestamp}-primary`}
            cx={chartX(index, sampledPoints.length)}
            cy={chartY(point.primary, maxValue)}
            r="4"
            fill={props.primaryColor}
            tabIndex={0}
            aria-label={`${props.primaryLabel} ${formatMetric(point.primary, props.unit)} at ${formatTimestamp(point.timestamp)}`}
          />
        ))}
      </svg>
      <div className="capacity-chart-legend">
        <span><i style={{ background: props.primaryColor }} />{props.primaryLabel}</span>
        {props.secondaryLabel && <span><i style={{ background: props.secondaryColor }} />{props.secondaryLabel}</span>}
        <span className="capacity-chart-range">{sampledPoints[0] ? formatShortDate(sampledPoints[0].timestamp) : "-"} to {sampledPoints.at(-1) ? formatShortDate(sampledPoints.at(-1)!.timestamp) : "-"}</span>
      </div>
    </article>
  );
}

function CapacityAllocation({ allocation, latestTimestamp, coverage }: { allocation: ReturnType<typeof capacityAllocation>; latestTimestamp?: string; coverage: number }) {
  const items = [
    { label: "CPU Allocation", value: `${formatNumber(allocation.allocatedVcpu)} / ${formatNumber(allocation.cpuCapacity)} vCPU`, detail: `${formatRatio(capacityRatio(allocation.allocatedVcpu, allocation.cpuCapacity))} overcommit`, icon: Cpu },
    { label: "Memory Allocation", value: `${formatNumber(allocation.allocatedMemoryGib)} / ${formatNumber(allocation.memoryCapacityGib)} GiB`, detail: `${formatRatio(capacityRatio(allocation.allocatedMemoryGib, allocation.memoryCapacityGib))} allocated`, icon: MemoryStick },
    { label: "Storage Consumption", value: `${formatNumber(allocation.storageUsedTib)} / ${formatNumber(allocation.storageTotalTib)} TiB`, detail: `${formatNumber(allocation.storageFreeTib)} TiB free`, icon: HardDrive },
    { label: "Storage Provisioning", value: `${formatNumber(allocation.storageProvisionedTib)} TiB`, detail: `${formatRatio(capacityRatio(allocation.storageProvisionedTib, allocation.storageTotalTib))} provisioned`, icon: Database },
    { label: "Sample Freshness", value: latestTimestamp ? formatTimestamp(latestTimestamp) : "No samples", detail: `${formatPercent(coverage)} data available`, icon: Clock3 }
  ];
  return (
    <section className="capacity-allocation-grid" aria-label="Capacity allocation facts">
      {items.map(({ label, value, detail, icon: Icon }) => (
        <article className="capacity-fact" key={label}>
          <span className="metric-icon"><Icon aria-hidden="true" size={18} /></span>
          <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
        </article>
      ))}
    </section>
  );
}

function CapacityClusterSplit({
  clusters,
  dataset,
  range,
  resources,
  timestamps,
  onSelect
}: {
  clusters: CapacityResource[];
  dataset: CapacityDataset;
  range: CapacityRange;
  resources: CapacityResource[];
  timestamps: string[];
  onSelect: (scope: CapacityScope) => void;
}) {
  const summaries = clusters.map((cluster) => buildClusterCapacitySummary(dataset, range, cluster, resources, timestamps));
  return (
    <section className="capacity-cluster-split" aria-labelledby="capacity-cluster-split-title">
      <div className="table-title capacity-cluster-split-title">
        <h3 id="capacity-cluster-split-title">Cluster split</h3>
        <span className="table-hint">{summaries.length} clusters</span>
      </div>
      {summaries.length === 0 ? (
        <div className="empty-state">No clusters match this manager</div>
      ) : (
        <div className="capacity-cluster-grid">
          {summaries.map((summary) => (
            <article className="capacity-cluster-card" key={summary.cluster.id}>
              <header className="capacity-cluster-header">
                <div>
                  <h3>{summary.cluster.name}</h3>
                  <p>{summary.cluster.managerName}</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  title={`Open ${summary.cluster.name}`}
                  aria-label={`Open ${summary.cluster.name}`}
                  onClick={() => onSelect({ managerId: summary.cluster.managerId, clusterId: summary.cluster.clusterId })}
                >
                  <Maximize2 aria-hidden="true" size={16} />
                </button>
              </header>

              <div className="capacity-cluster-status">
                <ResourceStatus status={summary.cluster.status} />
                <span className="state-pill status-muted">{formatCount(summary.hostCount, "host")}</span>
                <span className="state-pill status-muted">{formatCount(summary.vmCount, "VM", "VMs")}</span>
                <span className={`state-pill ${summary.coverage < 80 ? "status-partial" : "status-success"}`}>{formatPercent(summary.coverage)} data available</span>
                {summary.staleHostCount > 0 && <span className="state-pill status-failed">{summary.staleHostCount} stale host{summary.staleHostCount === 1 ? "" : "s"}</span>}
              </div>

              <div className="capacity-cluster-metrics">
                <ClusterMetric label="CPU" value={formatMetric(summary.cpuCurrent, "%")} detail={`P95 ${formatMetric(summary.cpuP95, "%")}`} percentage={summary.cpuCurrent} />
                <ClusterMetric label="Memory" value={formatMetric(summary.memoryCurrent, "%")} detail={`P95 ${formatMetric(summary.memoryP95, "%")}`} percentage={summary.memoryCurrent} />
                <ClusterMetric label="Storage" value={formatMetric(summary.storageCurrent, "%")} detail={`${formatNumber(summary.allocation.storageFreeTib)} TiB free`} percentage={summary.storageCurrent} />
                <ClusterMetric label="Network" value={formatMetric(summary.networkCurrent, " Mbps")} detail={`Peak ${formatMetric(summary.networkPeak, " Mbps")}`} />
              </div>

              <dl className="capacity-cluster-allocation">
                <div><dt>vCPU</dt><dd>{formatNumber(summary.allocation.allocatedVcpu)} / {formatNumber(summary.allocation.cpuCapacity)} <span>{formatRatio(capacityRatio(summary.allocation.allocatedVcpu, summary.allocation.cpuCapacity))}</span></dd></div>
                <div><dt>RAM</dt><dd>{formatNumber(summary.allocation.allocatedMemoryGib)} / {formatNumber(summary.allocation.memoryCapacityGib)} GiB <span>{formatRatio(capacityRatio(summary.allocation.allocatedMemoryGib, summary.allocation.memoryCapacityGib))}</span></dd></div>
                <div><dt>Provisioned</dt><dd>{formatNumber(summary.allocation.storageProvisionedTib)} / {formatNumber(summary.allocation.storageTotalTib)} TiB <span>{formatRatio(capacityRatio(summary.allocation.storageProvisionedTib, summary.allocation.storageTotalTib))}</span></dd></div>
              </dl>

              <footer className={summary.stale ? "status-failed" : ""}>
                <Clock3 aria-hidden="true" size={14} />
                {summary.latestTimestamp ? `${summary.stale ? "Stale" : "Latest"}: ${formatTimestamp(summary.latestTimestamp)}` : "No samples"}
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ClusterMetric({ label, value, detail, percentage }: { label: string; value: string; detail: string; percentage?: number }) {
  return (
    <div className="capacity-cluster-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      {percentage !== undefined && (
        <span className="capacity-cluster-meter" role="img" aria-label={`${label} ${formatPercent(percentage)}`}>
          <i style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} />
        </span>
      )}
    </div>
  );
}

function buildClusterCapacitySummary(
  dataset: CapacityDataset,
  range: CapacityRange,
  cluster: CapacityResource,
  resources: CapacityResource[],
  timestamps: string[]
) {
  const scope = { managerId: cluster.managerId, clusterId: cluster.clusterId };
  const samples = filterCapacitySamples(dataset.samples, range, scope, dataset.generatedAt);
  const hostSamples = metricSamples(samples, "host");
  const vmSamples = metricSamples(samples, "vm");
  const storageSamples = metricSamples(samples, "storageDomain");
  const cpuTrend = aggregateTrend(hostSamples, "cpuPercent", undefined, resources, timestamps);
  const memoryTrend = aggregateTrend(hostSamples, "memoryPercent", undefined, resources, timestamps);
  const storageTrend = aggregateTrend(storageSamples, "storagePercent", undefined, resources, timestamps);
  const networkTrend = aggregateTrend(vmSamples, "networkReceiveMbps", "networkTransmitMbps", resources, timestamps, true);
  const networkValues = networkTrend.map((point) => point.primary === undefined && point.secondary === undefined ? undefined : round((point.primary ?? 0) + (point.secondary ?? 0)));
  const clusterHosts = resources.filter((resource) => resource.type === "host" && resource.clusterId === cluster.clusterId);
  const clusterVms = resources.filter((resource) => resource.type === "vm" && resource.clusterId === cluster.clusterId);
  const latestTimestamp = latestSampleTimestamp(samples);
  return {
    cluster,
    hostCount: clusterHosts.length,
    vmCount: clusterVms.length,
    staleHostCount: clusterHosts.filter((resource) => resource.status === "stale").length,
    cpuCurrent: latestPresent(cpuTrend.map((point) => point.primary)),
    cpuP95: capacityPercentile(cpuTrend.map((point) => point.primary), 95),
    memoryCurrent: latestPresent(memoryTrend.map((point) => point.primary)),
    memoryP95: capacityPercentile(memoryTrend.map((point) => point.primary), 95),
    storageCurrent: latestPresent(storageTrend.map((point) => point.primary)),
    networkCurrent: latestPresent(networkValues),
    networkPeak: capacityPeak(networkValues),
    coverage: averageCoverage([
      trendCoverage(cpuTrend),
      trendCoverage(memoryTrend),
      trendCoverage(storageTrend),
      trendCoverage(networkTrend)
    ]),
    latestTimestamp,
    stale: latestTimestamp ? Date.parse(dataset.generatedAt) - Date.parse(latestTimestamp) > 24 * 60 * 60 * 1000 : false,
    allocation: capacityAllocation(resources, scope)
  };
}

function CapacityResourceTable({ dataset, range, rows, tab, onSelect }: { dataset: CapacityDataset; range: CapacityRange; rows: CapacityResource[]; tab: CapacityResourceTab; onSelect: (resource: CapacityResource) => void }) {
  return (
    <div className="table-card capacity-table-card">
      <div className="table-title"><h3 id="capacity-resource-title">{tabs.find((item) => item.value === tab)?.label}</h3><span className="table-hint">{rows.length} resources</span></div>
      <div className="table-scroll">
        <table className="data-table capacity-data-table">
          <thead><ResourceTableHeader tab={tab} /></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={10} className="empty-table-cell">No resources match this scope</td></tr> : rows.map((resource) => (
              <ResourceTableRow key={resource.id} dataset={dataset} range={range} resource={resource} tab={tab} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourceTableHeader({ tab }: { tab: CapacityResourceTab }) {
  if (tab === "storageDomains") {
    return <tr><th>Name</th><th>Manager</th><th>Cluster</th><th>Status</th><th>Total</th><th>Used</th><th>Free</th><th>Provisioned</th><th>P95 Used</th><th>Data available</th></tr>;
  }
  return <tr><th>Name</th><th>Manager</th><th>Cluster</th>{tab !== "clusters" && <th>Host</th>}<th>Status</th><th>VMs</th><th>CPU P95</th><th>Memory P95</th><th>Network Peak</th><th>Data available</th></tr>;
}

function ResourceTableRow({ dataset, range, resource, tab, onSelect }: { dataset: CapacityDataset; range: CapacityRange; resource: CapacityResource; tab: CapacityResourceTab; onSelect: (resource: CapacityResource) => void }) {
  const resourceScope = scopeForResource(resource);
  const samples = filterCapacitySamples(dataset.samples, range, resourceScope, dataset.generatedAt);
  const cpuType = resource.type === "vm" ? "vm" : "host";
  const cpu = metricSamples(samples, cpuType).map((sample) => sample.cpuPercent);
  const memory = metricSamples(samples, cpuType).map((sample) => sample.memoryPercent);
  const network = metricSamples(samples, "vm").flatMap((sample) => [sample.networkReceiveMbps, sample.networkTransmitMbps]);
  const storageValues = metricSamples(samples, "storageDomain").map((sample) => sample.storagePercent);
  const coverage = averageCoverage([
    capacityCoverage(tab === "storageDomains" ? storageValues : cpu),
    capacityCoverage(tab === "storageDomains" ? storageValues : memory)
  ]);
  if (tab === "storageDomains") {
    return (
      <tr>
        <td><button className="capacity-resource-link" type="button" onClick={() => onSelect(resource)}>{resource.name}</button></td>
        <td>{resource.managerName}</td><td>{resource.clusterName ?? "-"}</td><td><ResourceStatus status={resource.status} /></td>
        <td>{formatTib(resource.storageTotalTib)}</td><td>{formatTib(resource.storageUsedTib)}</td><td>{formatTib((resource.storageTotalTib ?? 0) - (resource.storageUsedTib ?? 0))}</td>
        <td>{formatTib(resource.storageProvisionedTib)}</td><td>{formatMetric(capacityPercentile(storageValues, 95), "%")}</td><td>{formatPercent(coverage)}</td>
      </tr>
    );
  }
  return (
    <tr>
      <td><button className="capacity-resource-link" type="button" onClick={() => onSelect(resource)}>{resource.name}</button></td>
      <td>{resource.managerName}</td><td>{resource.clusterName ?? "-"}</td>{tab !== "clusters" && <td>{resource.hostName ?? "-"}</td>}
      <td><ResourceStatus status={resource.status} /></td><td>{resource.vmCount ?? (resource.type === "vm" ? "-" : 0)}</td>
      <td>{formatMetric(capacityPercentile(cpu, 95), "%")}</td><td>{formatMetric(capacityPercentile(memory, 95), "%")}</td>
      <td>{formatMetric(capacityPeak(network), " Mbps")}</td><td>{formatPercent(coverage)}</td>
    </tr>
  );
}

function ResourceStatus({ status }: { status?: string }) {
  const className = status === "stale" || status === "down" ? "status-failed" : status === "maintenance" ? "status-partial" : "status-success";
  return <span className={`state-pill ${className}`}>{status ?? "unknown"}</span>;
}

function aggregateTrend(
  samples: CapacitySample[],
  primary: MetricKey,
  secondary: MetricKey | undefined,
  resources: CapacityResource[],
  timestamps: string[],
  sum = false
): TrendPoint[] {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const grouped = new Map<string, CapacitySample[]>();
  for (const sample of samples) {
    grouped.set(sample.timestamp, [...(grouped.get(sample.timestamp) ?? []), sample]);
  }
  return timestamps.map((timestamp) => {
    const rows = grouped.get(timestamp) ?? [];
    return {
      timestamp,
      primary: aggregateMetric(rows, primary, resourceById, sum),
      secondary: secondary ? aggregateMetric(rows, secondary, resourceById, sum) : undefined
    };
  });
}

function aggregateMetric(rows: CapacitySample[], key: MetricKey, resources: Map<string, CapacityResource>, sum: boolean): number | undefined {
  const present = rows.filter((row) => row[key] !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (sum) {
    return round(present.reduce((total, row) => total + Number(row[key]), 0));
  }
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const row of present) {
    const resource = resources.get(row.resourceId);
    const weight = key === "cpuPercent" ? resource?.cpuCapacity ?? resource?.allocatedVcpu ?? 1 : key === "memoryPercent" ? resource?.memoryCapacityGib ?? resource?.allocatedMemoryGib ?? 1 : resource?.storageTotalTib ?? 1;
    weightedTotal += Number(row[key]) * weight;
    totalWeight += weight;
  }
  return totalWeight ? round(weightedTotal / totalWeight) : undefined;
}

function capacityAllocation(resources: CapacityResource[], scope: CapacityScope) {
  const scopedVms = scope.storageDomainId ? [] : resources.filter((resource) => resource.type === "vm" && resourceMatchesTableScope(resource, scope, "vms"));
  const scopedHosts = scope.storageDomainId ? [] : resources.filter((resource) => resource.type === "host" && resourceMatchesTableScope(resource, scope, "hosts"));
  const scopedStorage = resources.filter((resource) => resource.type === "storageDomain" && resourceMatchesTableScope(resource, scope, "storageDomains"));
  const cpuCapacity = sumResource(scopedHosts, "cpuCapacity");
  const allocatedVcpu = sumResource(scopedVms, "allocatedVcpu");
  const memoryCapacityGib = sumResource(scopedHosts, "memoryCapacityGib");
  const allocatedMemoryGib = sumResource(scopedVms, "allocatedMemoryGib");
  const storageTotalTib = sumResource(scopedStorage, "storageTotalTib");
  const storageUsedTib = sumResource(scopedStorage, "storageUsedTib");
  const storageProvisionedTib = sumResource(scopedStorage, "storageProvisionedTib");
  const storageFreeTib = storageTotalTib === undefined || storageUsedTib === undefined ? undefined : round(storageTotalTib - storageUsedTib);
  return { cpuCapacity, allocatedVcpu, memoryCapacityGib, allocatedMemoryGib, storageTotalTib, storageUsedTib, storageFreeTib, storageProvisionedTib };
}

function resourcesForTab(resources: CapacityResource[], tab: CapacityResourceTab, scope: CapacityScope): CapacityResource[] {
  const type = tab === "clusters" ? "cluster" : tab === "hosts" ? "host" : tab === "vms" ? "vm" : "storageDomain";
  return resources.filter((resource) => resource.type === type && resourceMatchesTableScope(resource, scope, tab));
}

function resourceMatchesTableScope(resource: CapacityResource, scope: CapacityScope, tab: CapacityResourceTab): boolean {
  if (scope.managerId && resource.managerId !== scope.managerId) return false;
  if (scope.clusterId && resource.clusterId !== scope.clusterId) return false;
  if ((tab === "hosts" || tab === "vms") && scope.hostId && resource.hostId !== scope.hostId) return false;
  if (tab === "vms" && scope.vmId && resource.vmId !== scope.vmId) return false;
  if (tab === "storageDomains" && scope.storageDomainId && resource.storageDomainId !== scope.storageDomainId) return false;
  return true;
}

function scopeForResource(resource: CapacityResource): CapacityScope {
  return {
    managerId: resource.managerId,
    clusterId: resource.clusterId,
    ...(resource.type === "host" ? { hostId: resource.hostId } : {}),
    ...(resource.type === "vm" ? { hostId: resource.hostId, vmId: resource.vmId } : {}),
    ...(resource.type === "storageDomain" ? { storageDomainId: resource.storageDomainId } : {})
  };
}

function metricSamples(samples: CapacitySample[], resourceType: CapacitySample["resourceType"]): CapacitySample[] {
  return samples.filter((sample) => sample.resourceType === resourceType);
}

function uniqueOptions(resources: CapacityResource[], valueKey: "managerId" | "clusterId" | "hostId", labelKey: "managerName" | "clusterName" | "hostName") {
  const values = new Map<string, string>();
  for (const resource of resources) {
    const value = resource[valueKey];
    const label = resource[labelKey];
    if (value && label) values.set(value, label);
  }
  return [...values.entries()].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label));
}

function linePaths(points: TrendPoint[], key: "primary" | "secondary", maxValue: number): string[] {
  const paths: string[] = [];
  let current = "";
  points.forEach((point, index) => {
    const value = point[key];
    if (value === undefined) {
      if (current) paths.push(current);
      current = "";
      return;
    }
    const command = current ? "L" : "M";
    current += `${command}${chartX(index, points.length).toFixed(1)},${chartY(value, maxValue).toFixed(1)} `;
  });
  if (current) paths.push(current);
  return paths;
}

function downsample<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values;
  const result: T[] = [];
  for (let index = 0; index < maximum; index += 1) {
    result.push(values[Math.round((index / (maximum - 1)) * (values.length - 1))]);
  }
  return result;
}

function chartX(index: number, length: number): number {
  return length <= 1 ? 44 : 44 + (index / (length - 1)) * 580;
}

function chartY(value: number, maxValue: number): number {
  return 190 - (Math.min(maxValue, Math.max(0, value)) / maxValue) * 150;
}

function sumResource(resources: CapacityResource[], key: keyof CapacityResource): number | undefined {
  if (resources.length === 0) {
    return undefined;
  }
  return round(resources.reduce((total, resource) => total + Number(resource[key] ?? 0), 0));
}

function latestSampleTimestamp(samples: CapacitySample[]): string | undefined {
  return samples.reduce<string | undefined>((latest, sample) => !latest || sample.timestamp > latest ? sample.timestamp : latest, undefined);
}

function latestPresent(values: Array<number | undefined>): number | undefined {
  return [...values].reverse().find((value) => value !== undefined);
}

function trendCoverage(points: TrendPoint[]): number | undefined {
  return points.length ? capacityCoverage(points.map((point) => point.primary)) : undefined;
}

function averageCoverage(values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return present.length ? round(present.reduce((total, value) => total + value, 0) / present.length) : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatMetric(value: number | undefined, unit: string): string {
  return value === undefined ? "-" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;
}

function formatAxis(value: number, unit: string): string {
  return `${Math.ceil(value).toLocaleString()}${unit}`;
}

function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}:1`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatTib(value: number | undefined): string {
  return value === undefined ? "-" : `${formatNumber(value)} TiB`;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatShortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatRangeLabel(range: CapacityRange): string {
  return ranges.find((item) => item.value === range)?.label ?? range;
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}
