import { describe, expect, it, vi } from "vitest";
import { snapshotToInventorySyncInput } from "../server/ovirt-normalize.js";
import { emptyInventoryResources, type SnapshotPayload } from "../shared/snapshot.js";

describe("oVirt inventory normalization", () => {
  it("maps collected oVirt resources into normalized inventory records", () => {
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    const snapshot: SnapshotPayload = {
      managerId: "manager-1",
      managerName: "Lab",
      managerUrl: "https://lab.example/ovirt-engine",
      collectedAt: "2026-08-11T10:00:00.000Z",
      apiVersion: "4.5",
      durationMs: 2000,
      status: "success",
      resources: {
        ...emptyInventoryResources(),
        dataCenters: [{ id: "dc-1", name: "Default", status: "up" }],
        clusters: [{ id: "cluster-1", name: "Default", data_center: { id: "dc-1" }, version: { major: 4, minor: 5 } }],
        hosts: [{ id: "host-1", name: "host-01", cluster: { id: "cluster-1" }, status: "up" }],
        storageDomains: [{ id: "sd-1", name: "data", data_center: { id: "dc-1" }, available: 10, used: 5, total: 15 }],
        networks: [{ id: "net-1", name: "ovirtmgmt", data_center: { id: "dc-1" }, vlan: { id: 100 } }],
        vnicProfiles: [{ id: "profile-1", name: "ovirtmgmt", network: { id: "net-1" }, port_mirroring: false }],
        vms: [
          {
            id: "vm-1",
            name: "api-01",
            status: "up",
            cluster: { id: "cluster-1", name: "Default" },
            host: { id: "host-1", name: "host-01" },
            memory: 8589934592,
            cpu: { topology: { sockets: 2, cores: 2, threads: 1 } },
            high_availability: { enabled: true, priority: 50 },
            guest_info: { fqdn: "api-01.example", os: { name: "Linux", version: "9" } },
            custom_properties: {
              custom_property: [
                { name: "environment", value: "prod" },
                { name: "application", value: "orders" },
                { name: "owner", value: "platform" },
                { name: "criticality", value: "critical" },
                { name: "backup_status", value: "protected" }
              ]
            },
            nics: {
              nic: [
                {
                  id: "nic-1",
                  name: "nic1",
                  mac: { address: "00:1a:4a:16:01:51" },
                  vnic_profile: { id: "profile-1", name: "ovirtmgmt" },
                  reported_devices: {
                    reported_device: [{ ips: { ip: [{ version: "v4", address: "192.0.2.10" }] } }]
                  }
                }
              ]
            },
            disk_attachments: {
              disk_attachment: [
                {
                  id: "attach-1",
                  interface: "virtio_scsi",
                  bootable: true,
                  disk: {
                    id: "disk-1",
                    alias: "root",
                    format: "cow",
                    provisioned_size: 10737418240,
                    actual_size: 5368709120,
                    storage_domains: { storage_domain: [{ id: "sd-1", name: "data" }] }
                  }
                }
              ]
            },
            tags: { tag: [{ id: "tag-1", name: "prod" }] }
          }
        ],
        vmSnapshots: [
          {
            id: "snapshot-1",
            description: "before-change",
            date: "2026-08-10T12:00:00.000Z",
            snapshot_status: "ok",
            vm: { id: "vm-1", name: "api-01" }
          }
        ],
        affinityGroups: [{ id: "affinity-1", name: "anti-affinity", enforcing: true, positive: false, vms: { vm: [{ id: "vm-1" }] } }],
        events: [{ id: "event-1", time: "2026-08-11T09:59:00.000Z", severity: "normal", description: "VM started", vm: { id: "vm-1" } }]
      },
      warnings: [],
      errors: []
    };

    const input = snapshotToInventorySyncInput(snapshot);

    expect(input).toMatchObject({
      managerId: "manager-1",
      status: "success",
      apiVersion: "4.5",
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:00:02.000Z"
    });
    expect(input.resources.dataCenters?.[0]).toMatchObject({ dataCenterId: "dc-1", name: "Default" });
    expect(input.resources.clusters?.[0]).toMatchObject({ clusterId: "cluster-1", dataCenterId: "dc-1", version: "4.5" });
    expect(input.resources.hosts?.[0]).toMatchObject({ hostId: "host-1", clusterId: "cluster-1", status: "up" });
    expect(input.resources.logicalNetworks?.[0]).toMatchObject({ networkId: "net-1", vlanId: 100 });
    expect(input.resources.vnicProfiles?.[0]).toMatchObject({ vnicProfileId: "profile-1", networkId: "net-1" });
    expect(input.resources.vms?.[0]).toMatchObject({
      vmId: "vm-1",
      name: "api-01",
      hostId: "host-1",
      haEnabled: true,
      vcpus: 4,
      memoryMb: 8192,
      guestAgentStatus: "available",
      environment: "prod",
      application: "orders",
      owner: "platform",
      criticality: "critical",
      backupStatus: "protected",
      healthScore: 100,
      tags: ["prod"]
    });
    expect(input.resources.vms?.[0]?.nics?.[0]).toMatchObject({ nicId: "nic-1", ipv4Addresses: ["192.0.2.10"] });
    expect(input.resources.vms?.[0]?.disks?.[0]).toMatchObject({ diskId: "disk-1", provisionedSizeGib: 10, actualSizeGib: 5 });
    expect(input.resources.vms?.[0]?.snapshots?.[0]).toMatchObject({ snapshotId: "snapshot-1", ageDays: 1 });
    expect(input.resources.affinityGroups?.[0]).toMatchObject({ affinityGroupId: "affinity-1", vmIds: ["vm-1"] });
    expect(input.resources.events?.[0]).toMatchObject({ eventId: "event-1", resourceId: "vm-1" });
    vi.useRealTimers();
  });
});
