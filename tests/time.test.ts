import { describe, expect, it } from "vitest";
import { formatHongKongDateTime, sqliteUtcTimestampToIso } from "../shared/time.js";

describe("operational timestamps", () => {
  it("marks SQLite CURRENT_TIMESTAMP values as UTC before presentation", () => {
    expect(sqliteUtcTimestampToIso("2026-08-19 06:48:18")).toBe("2026-08-19T06:48:18.000Z");
  });

  it("formats settings timestamps in Hong Kong time", () => {
    expect(formatHongKongDateTime("2026-08-19T06:48:18.000Z")).toBe("19/08/2026, 14:48:18 HKT");
  });
});
