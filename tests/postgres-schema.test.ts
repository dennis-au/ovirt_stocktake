import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { migratePostgres, type PostgresQueryable } from "../server/postgres/migrate.js";
import { replaceCurrentInventory } from "../server/postgres/inventory.js";
import { postgresMigrations } from "../server/postgres/migrations.js";

async function memoryPostgres() {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool() as PostgresQueryable & { end(): Promise<void> };
  await migratePostgres(pool);
  return pool;
}

describe("PostgreSQL inventory schema", () => {
  it("initializes normalized inventory, history, audit, saved view, and export tables", async () => {
    const pool = await memoryPostgres();

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "affinity_group_vms",
        "affinity_groups",
        "audit_logs",
        "clusters",
        "collection_runs",
        "data_centers",
        "exports",
        "hosts",
        "inventory_history",
        "logical_networks",
        "managers",
        "resource_change_events",
        "saved_views",
        "storage_domains",
        "tags",
        "vms",
        "vm_disks",
        "vm_nics",
        "vm_ownership",
        "vm_snapshots",
        "vm_tags",
        "vnic_profiles"
      ])
    );

    await pool.end();
  });

  it("declares indexes for the required operational filters", () => {
    const migrationSql = postgresMigrations.map((migration) => migration.sql).join("\n");

    expect(migrationSql).toContain("idx_vms_manager_status");
    expect(migrationSql).toContain("idx_vms_manager_cluster");
    expect(migrationSql).toContain("idx_vms_manager_host");
    expect(migrationSql).toContain("idx_vms_last_seen");
    expect(migrationSql).toContain("idx_vms_health_score");
    expect(migrationSql).toContain("idx_vm_ownership_environment");
    expect(migrationSql).toContain("idx_vm_ownership_owner");
    expect(migrationSql).toContain("idx_vm_ownership_application");
    expect(migrationSql).toContain("idx_vm_ownership_criticality");
    expect(migrationSql).toContain("idx_vm_ownership_cost_center");
    expect(migrationSql).toContain("idx_vm_tags_tag");
    expect(migrationSql).toContain("idx_vm_disks_storage_domain");
    expect(migrationSql).toContain("idx_vm_nics_network");
    expect(migrationSql).toContain("idx_collection_runs_manager_started");
    expect(migrationSql).toContain("idx_inventory_history_resource");
    expect(migrationSql).toContain("idx_events_manager_time");
  });

  it("replaces current VM inventory idempotently while preserving history", async () => {
    const pool = await memoryPostgres();

    await pool.query(
      `
        INSERT INTO managers (id, name, url, credential_status)
        VALUES ($1, $2, $3, $4)
      `,
      ["manager-1", "Lab Manager", "https://lab.example/ovirt-engine", "saved"]
    );

    const firstRun = await replaceCurrentInventory(pool, {
      managerId: "manager-1",
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:00:02.000Z",
      status: "success",
      apiVersion: "4.8",
      resources: {
        vms: [
          {
            vmId: "vm-1",
            name: "api-01",
            status: "up",
            clusterId: "cluster-1",
            clusterName: "Default",
            hostId: "host-1",
            hostName: "host-01",
            environment: "prod",
            application: "orders",
            owner: "platform",
            criticality: "critical",
            vcpus: 4,
            memoryMb: 8192,
            guestAgentStatus: "up",
            healthScore: 100,
            tags: ["prod", "orders"]
          }
        ]
      }
    });

    const secondRun = await replaceCurrentInventory(pool, {
      managerId: "manager-1",
      startedAt: "2026-08-11T11:00:00.000Z",
      completedAt: "2026-08-11T11:00:03.000Z",
      status: "success",
      apiVersion: "4.8",
      resources: {
        vms: [
          {
            vmId: "vm-1",
            name: "api-01-renamed",
            status: "down",
            clusterId: "cluster-1",
            clusterName: "Default",
            environment: "prod",
            application: "orders",
            owner: "platform",
            criticality: "critical",
            vcpus: 4,
            memoryMb: 8192,
            guestAgentStatus: "stale",
            healthScore: 70,
            tags: ["prod"]
          }
        ]
      }
    });

    expect(firstRun.collectionRunId).not.toEqual(secondRun.collectionRunId);

    const current = await pool.query<{ name: string; status: string; health_score: number }>(
      "SELECT name, status, health_score FROM vms WHERE manager_id = $1 AND vm_id = $2",
      ["manager-1", "vm-1"]
    );
    expect(current.rows).toEqual([{ name: "api-01-renamed", status: "down", health_score: 70 }]);

    const history = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM inventory_history WHERE manager_id = $1 AND resource_type = $2 AND resource_id = $3",
      ["manager-1", "vm", "vm-1"]
    );
    expect(Number(history.rows[0].count)).toBe(2);

    const tags = await pool.query<{ tag_name: string }>(
      "SELECT tag_name FROM vm_tags WHERE manager_id = $1 AND vm_id = $2 ORDER BY tag_name",
      ["manager-1", "vm-1"]
    );
    expect(tags.rows).toEqual([{ tag_name: "prod" }]);

    await pool.end();
  });
});
