import { redactInventoryFields, type AppRole } from "../rbac.js";
import type { PostgresQueryable } from "./migrate.js";

export interface VmDetail {
  managerId: string;
  vmId: string;
  manager: {
    name: string;
    url: string;
  };
  tabs: {
    overview: Record<string, unknown>;
    performance: Record<string, unknown>;
    storageSnapshots: {
      disks: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
    };
    network: {
      nics: Array<Record<string, unknown>>;
    };
    backupDr: Record<string, unknown>;
    eventsAudit: {
      events: Array<Record<string, unknown>>;
      history: Array<Record<string, unknown>>;
    };
  };
  health: {
    score?: number;
    deductions: unknown[];
  };
  freshness: Record<string, string | undefined>;
}

interface VmDetailRow {
  manager_id: string;
  vm_id: string;
  manager_name: string;
  manager_url: string;
  name: string;
  status: string | null;
  cluster_id: string | null;
  cluster_name: string | null;
  host_id: string | null;
  host_name: string | null;
  data_center_id: string | null;
  data_center_name: string | null;
  os_type: string | null;
  guest_os_name: string | null;
  guest_os_version: string | null;
  fqdn: string | null;
  hostname: string | null;
  vcpus: number | null;
  memory_mb: number | null;
  guest_agent_status: string | null;
  last_guest_agent_update: Date | string | null;
  last_seen_at: Date | string;
  health_score: number | null;
  health_deductions: unknown;
  environment: string | null;
  application: string | null;
  service_role: string | null;
  owner: string | null;
  on_call_group: string | null;
  cost_center: string | null;
  criticality: string | null;
  cmdb_ci_id: string | null;
  ticket_reference: string | null;
  backup_policy: string | null;
  backup_status: string | null;
  last_backup_success_at: Date | string | null;
  last_backup_attempt_at: Date | string | null;
  rpo_target_hours: number | null;
  rpo_actual_hours: number | null;
  rto_target_hours: number | null;
  last_restore_test_at: Date | string | null;
  public_ip: string | null;
  lifecycle_status: string | null;
  retire_date: Date | string | null;
  monthly_estimated_cost: string | number | null;
  vulnerability_critical_count: number | null;
}

export async function getVmDetail(db: PostgresQueryable, managerId: string, vmId: string, role: AppRole): Promise<VmDetail | undefined> {
  const row = (
    await db.query<VmDetailRow>(
      `
        SELECT
          v.manager_id,
          v.vm_id,
          m.name AS manager_name,
          m.url AS manager_url,
          v.name,
          v.status,
          v.cluster_id,
          v.cluster_name,
          v.host_id,
          v.host_name,
          v.data_center_id,
          v.data_center_name,
          v.os_type,
          v.guest_os_name,
          v.guest_os_version,
          v.fqdn,
          v.hostname,
          v.vcpus,
          v.memory_mb,
          v.guest_agent_status,
          v.last_guest_agent_update,
          v.last_seen_at,
          v.health_score,
          v.health_deductions,
          o.environment,
          o.application,
          o.service_role,
          o.owner,
          o.on_call_group,
          o.cost_center,
          o.criticality,
          o.cmdb_ci_id,
          o.ticket_reference,
          o.backup_policy,
          o.backup_status,
          o.last_backup_success_at,
          o.last_backup_attempt_at,
          o.rpo_target_hours,
          o.rpo_actual_hours,
          o.rto_target_hours,
          o.last_restore_test_at,
          o.public_ip,
          o.lifecycle_status,
          o.retire_date,
          o.monthly_estimated_cost,
          o.vulnerability_critical_count
        FROM vms v
        JOIN managers m ON m.id = v.manager_id
        LEFT JOIN vm_ownership o ON o.manager_id = v.manager_id AND o.vm_id = v.vm_id
        WHERE v.manager_id = $1 AND v.vm_id = $2
        LIMIT 1
      `,
      [managerId, vmId]
    )
  ).rows[0];
  if (!row) {
    return undefined;
  }

  const [nics, disks, snapshots, events, history] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT nic_id, nic_name AS name, mac_address, vnic_profile_id, vnic_profile, logical_network, vlan_id,
              interface_type, linked, ipv4_addresses, ipv6_addresses, network_filter, qos, port_mirroring, last_seen_at
       FROM vm_nics WHERE manager_id = $1 AND vm_id = $2 ORDER BY nic_name`,
      [managerId, vmId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT disk_id, alias, storage_domain_id, storage_domain, disk_format, provisioned_size_gib,
              actual_size_gib, interface, bootable, shareable, backup_included, disk_profile, direct_lun, encrypted, last_seen_at
       FROM vm_disks WHERE manager_id = $1 AND vm_id = $2 ORDER BY alias`,
      [managerId, vmId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT snapshot_id, description, created_at, status, snapshot_type, age_days, size_gib, creator, ticket_reference, last_seen_at
       FROM vm_snapshots WHERE manager_id = $1 AND vm_id = $2 ORDER BY age_days DESC NULLS LAST, created_at DESC NULLS LAST`,
      [managerId, vmId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT event_id, event_time, severity, resource_type, resource_id, message
       FROM events WHERE manager_id = $1 AND resource_id = $2 ORDER BY event_time DESC LIMIT 100`,
      [managerId, vmId]
    ),
    db.query<Record<string, unknown>>(
      `SELECT id, collection_run_id, resource_type, resource_id, collected_at
       FROM inventory_history WHERE manager_id = $1 AND resource_type = 'vm' AND resource_id = $2 ORDER BY collected_at DESC LIMIT 25`,
      [managerId, vmId]
    )
  ]);

  const overview = redactInventoryFields(role, {
    vmId: row.vm_id,
    name: row.name,
    status: row.status ?? undefined,
    environment: row.environment ?? undefined,
    application: row.application ?? undefined,
    owner: row.owner ?? undefined,
    criticality: row.criticality ?? undefined,
    clusterId: row.cluster_id ?? undefined,
    clusterName: row.cluster_name ?? undefined,
    hostId: row.host_id ?? undefined,
    hostName: row.host_name ?? undefined,
    dataCenterId: row.data_center_id ?? undefined,
    dataCenterName: row.data_center_name ?? undefined,
    osType: row.os_type ?? undefined,
    guestOsName: row.guest_os_name ?? undefined,
    guestOsVersion: row.guest_os_version ?? undefined,
    fqdn: row.fqdn ?? undefined,
    hostname: row.hostname ?? undefined,
    publicIp: row.public_ip ?? undefined,
    vcpus: row.vcpus ?? undefined,
    memoryMb: row.memory_mb ?? undefined,
    guestAgentStatus: row.guest_agent_status ?? undefined,
    healthScore: row.health_score ?? undefined
  });

  const backupDr = redactInventoryFields(role, {
    backupPolicy: row.backup_policy ?? undefined,
    backupStatus: row.backup_status ?? undefined,
    lastBackupSuccessAt: iso(row.last_backup_success_at),
    lastBackupAttemptAt: iso(row.last_backup_attempt_at),
    rpoTargetHours: row.rpo_target_hours ?? undefined,
    rpoActualHours: row.rpo_actual_hours ?? undefined,
    rtoTargetHours: row.rto_target_hours ?? undefined,
    lastRestoreTestAt: iso(row.last_restore_test_at),
    serviceRole: row.service_role ?? undefined,
    onCallGroup: row.on_call_group ?? undefined,
    costCenter: row.cost_center ?? undefined,
    cmdbCiId: row.cmdb_ci_id ?? undefined,
    ticketReference: row.ticket_reference ?? undefined,
    lifecycleStatus: row.lifecycle_status ?? undefined,
    retireDate: iso(row.retire_date),
    monthlyEstimatedCost: row.monthly_estimated_cost === null ? undefined : Number(row.monthly_estimated_cost),
    vulnerabilityCriticalCount: row.vulnerability_critical_count ?? undefined
  });

  return {
    managerId: row.manager_id,
    vmId: row.vm_id,
    manager: {
      name: row.manager_name,
      url: row.manager_url
    },
    tabs: {
      overview,
      performance: {
        metricsAvailable: false,
        cpuP95: undefined,
        memoryP95: undefined,
        diskMetrics: [],
        networkMetrics: []
      },
      storageSnapshots: {
        disks: disks.rows,
        snapshots: snapshots.rows
      },
      network: {
        nics: nics.rows
      },
      backupDr,
      eventsAudit: {
        events: events.rows,
        history: history.rows
      }
    },
    health: {
      score: row.health_score ?? undefined,
      deductions: Array.isArray(row.health_deductions) ? row.health_deductions : []
    },
    freshness: {
      overview: iso(row.last_seen_at),
      performance: undefined,
      storageSnapshots: newestTimestamp([...disks.rows, ...snapshots.rows], "last_seen_at") ?? iso(row.last_seen_at),
      network: newestTimestamp(nics.rows, "last_seen_at") ?? iso(row.last_seen_at),
      backupDr: iso(row.last_seen_at),
      eventsAudit: newestTimestamp(events.rows, "event_time") ?? iso(row.last_seen_at)
    }
  };
}

function newestTimestamp(rows: Array<Record<string, unknown>>, key: string): string | undefined {
  return rows
    .map((row) => iso(row[key]))
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}
