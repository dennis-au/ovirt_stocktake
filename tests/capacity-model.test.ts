import { describe, expect, it } from "vitest";
import {
  capacityCoverage,
  capacityPeak,
  capacityPercentile,
  capacityRatio,
  capacityTimeline,
  filterCapacitySamples,
  type CapacitySample
} from "../frontend/src/capacity-model.js";

const asOf = "2026-08-13T12:00:00.000Z";
const samples: CapacitySample[] = [
  {
    timestamp: "2026-08-13T11:00:00.000Z",
    resourceType: "host",
    resourceId: "host-a",
    managerId: "manager-a",
    clusterId: "cluster-a",
    hostId: "host-a",
    cpuPercent: 72
  },
  {
    timestamp: "2026-08-12T10:00:00.000Z",
    resourceType: "host",
    resourceId: "host-a",
    managerId: "manager-a",
    clusterId: "cluster-a",
    hostId: "host-a",
    cpuPercent: 44
  },
  {
    timestamp: "2026-08-13T10:00:00.000Z",
    resourceType: "vm",
    resourceId: "vm-b",
    managerId: "manager-b",
    clusterId: "cluster-b",
    hostId: "host-b",
    vmId: "vm-b",
    cpuPercent: 38
  }
];

describe("capacity model", () => {
  it("filters samples by time range and resource scope", () => {
    expect(filterCapacitySamples(samples, "24h", { managerId: "manager-a" }, asOf)).toEqual([samples[0]]);
    expect(filterCapacitySamples(samples, "7d", { clusterId: "cluster-a", hostId: "host-a" }, asOf)).toEqual([
      samples[0],
      samples[1]
    ]);
    expect(filterCapacitySamples(samples, "30d", { vmId: "vm-b" }, asOf)).toEqual([samples[2]]);
    expect(filterCapacitySamples([{ ...samples[0], timestamp: "2026-08-13T13:00:00.000Z" }], "24h", {}, asOf)).toEqual([]);
  });

  it("builds expected sample slots so missing values remain visible as gaps", () => {
    expect(capacityTimeline("24h", asOf, 360)).toEqual([
      "2026-08-12T12:00:00.000Z",
      "2026-08-12T18:00:00.000Z",
      "2026-08-13T00:00:00.000Z",
      "2026-08-13T06:00:00.000Z",
      "2026-08-13T12:00:00.000Z"
    ]);
  });

  it("calculates P95, peak, sample coverage, and ratios without inventing missing values", () => {
    expect(capacityPercentile([10, 20, undefined, 30, 40, 50], 95)).toBe(50);
    expect(capacityPeak([10, undefined, 45, 20])).toBe(45);
    expect(capacityCoverage([10, undefined, 30, undefined])).toBe(50);
    expect(capacityRatio(24, 16)).toBe(1.5);
    expect(capacityRatio(24, 0)).toBeUndefined();
  });
});
