import { describe, expect, it } from "vitest";
import { collectManagersSequentially } from "../frontend/src/manager-collection.js";

describe("collectManagersSequentially", () => {
  it("collects enabled managers one at a time and continues after a failed manager", async () => {
    const managers = [
      { id: "manager-1", name: "lab111", enabled: true },
      { id: "manager-2", name: "lab112", enabled: true },
      { id: "manager-3", name: "lab113", enabled: true },
      { id: "manager-4", name: "disabled", enabled: false }
    ];
    const collected: string[] = [];
    const started: string[] = [];
    let activeCollections = 0;
    let peakCollections = 0;

    const result = await collectManagersSequentially(managers, async (manager) => {
      started.push(manager.id);
      activeCollections += 1;
      peakCollections = Math.max(peakCollections, activeCollections);
      await Promise.resolve();
      activeCollections -= 1;

      if (manager.id === "manager-2") {
        throw new Error("Manager unavailable");
      }

      collected.push(manager.id);
      return manager.id;
    });

    expect(peakCollections).toBe(1);
    expect(started).toEqual(["manager-1", "manager-2", "manager-3"]);
    expect(collected).toEqual(["manager-1", "manager-3"]);
    expect(result.snapshots).toEqual(["manager-1", "manager-3"]);
    expect(result.failures).toEqual([{ managerId: "manager-2", managerName: "lab112" }]);
  });
});
