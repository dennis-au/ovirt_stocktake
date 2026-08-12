import type { PostgresQueryable } from "./migrate.js";

export interface MetricSample {
  managerId: string;
  resourceType: "vm" | "host" | "cluster" | "storage_domain";
  resourceId: string;
  metricName: string;
  sampledAt: string;
  value: number;
  labels?: Record<string, unknown>;
}

export interface VmMetricSummary {
  metricsAvailable: boolean;
  cpuP95?: number;
  memoryP95?: number;
  diskReadIopsP95?: number;
  diskWriteIopsP95?: number;
  networkRxMbpsP95?: number;
  networkTxMbpsP95?: number;
  availabilityPercent?: number;
  rightsizing?: "undersized" | "oversized" | "steady" | "unavailable";
  windowHours: number;
}

export async function insertMetricSamples(db: PostgresQueryable, samples: MetricSample[]): Promise<void> {
  for (const sample of samples) {
    await db.query(
      `
        INSERT INTO metric_samples (
          manager_id, resource_type, resource_id, metric_name, sampled_at, value, labels
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (manager_id, resource_type, resource_id, metric_name, sampled_at)
        DO UPDATE SET value = excluded.value, labels = excluded.labels
      `,
      [
        sample.managerId,
        sample.resourceType,
        sample.resourceId,
        sample.metricName,
        sample.sampledAt,
        sample.value,
        JSON.stringify(sample.labels ?? {})
      ]
    );
  }
}

export async function queryVmMetricSummary(
  db: PostgresQueryable,
  managerId: string,
  vmId: string,
  windowHours = 24
): Promise<VmMetricSummary> {
  const rows = (
    await db.query<{ metric_name: string; value: number }>(
      `
        SELECT metric_name, value
        FROM metric_samples
        WHERE manager_id = $1
          AND resource_type = 'vm'
          AND resource_id = $2
          AND sampled_at >= $3
      `,
      [managerId, vmId, new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()]
    )
  ).rows;
  if (rows.length === 0) {
    return { metricsAvailable: false, rightsizing: "unavailable", windowHours };
  }

  const values = metricValues(rows);
  const cpuP95 = percentile(values.get("cpu.usage.percent") ?? [], 95);
  const memoryP95 = percentile(values.get("memory.usage.percent") ?? [], 95);
  const availability = average(values.get("availability.percent") ?? []);

  return {
    metricsAvailable: true,
    cpuP95,
    memoryP95,
    diskReadIopsP95: percentile(values.get("disk.read.iops") ?? [], 95),
    diskWriteIopsP95: percentile(values.get("disk.write.iops") ?? [], 95),
    networkRxMbpsP95: percentile(values.get("network.rx.mbps") ?? [], 95),
    networkTxMbpsP95: percentile(values.get("network.tx.mbps") ?? [], 95),
    availabilityPercent: availability,
    rightsizing: rightsizing(cpuP95, memoryP95),
    windowHours
  };
}

export function percentile(values: number[], percentileRank: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function metricValues(rows: Array<{ metric_name: string; value: number }>): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const row of rows) {
    result.set(row.metric_name, [...(result.get(row.metric_name) ?? []), Number(row.value)]);
  }
  return result;
}

function average(values: number[]): number | undefined {
  return values.length ? Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100 : undefined;
}

function rightsizing(cpuP95: number | undefined, memoryP95: number | undefined): VmMetricSummary["rightsizing"] {
  if (cpuP95 === undefined || memoryP95 === undefined) {
    return "unavailable";
  }
  if (cpuP95 < 10 && memoryP95 < 35) {
    return "oversized";
  }
  if (cpuP95 > 85 || memoryP95 > 90) {
    return "undersized";
  }
  return "steady";
}
