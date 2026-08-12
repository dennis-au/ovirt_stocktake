import { applyGovernanceAndHealth } from "./governance.js";
import type {
  AffinityGroupRecord,
  ClusterRecord,
  DataCenterRecord,
  EventRecord,
  HostRecord,
  InventorySyncInput,
  LogicalNetworkRecord,
  StorageDomainRecord,
  VmDiskRecord,
  VmNicRecord,
  VmRecord,
  VmSnapshotRecord,
  VnicProfileRecord
} from "./postgres/inventory.js";
import type { InventoryResource, SnapshotPayload } from "../shared/snapshot.js";

export function snapshotToInventorySyncInput(snapshot: SnapshotPayload): InventorySyncInput {
  const vmSnapshotsByVmId = groupVmSnapshots(snapshot.resources.vmSnapshots);
  const completedAt = new Date(Date.parse(snapshot.collectedAt) + snapshot.durationMs).toISOString();

  return {
    managerId: snapshot.managerId,
    status: snapshot.status,
    apiVersion: snapshot.apiVersion,
    startedAt: snapshot.collectedAt,
    completedAt,
    warnings: snapshot.warnings,
    errors: snapshot.errors,
    resources: {
      dataCenters: snapshot.resources.dataCenters.map(toDataCenter),
      clusters: snapshot.resources.clusters.map(toCluster),
      hosts: snapshot.resources.hosts.map(toHost),
      storageDomains: snapshot.resources.storageDomains.map(toStorageDomain),
      logicalNetworks: snapshot.resources.networks.map(toLogicalNetwork),
      vnicProfiles: snapshot.resources.vnicProfiles.map(toVnicProfile),
      vms: snapshot.resources.vms.map((vm) => toVm(vm, vmSnapshotsByVmId.get(stringValue(vm.id) ?? "") ?? [], new Date(completedAt))),
      affinityGroups: snapshot.resources.affinityGroups.map(toAffinityGroup),
      events: snapshot.resources.events.map((event) => toEvent(event, snapshot.collectedAt))
    }
  };
}

function toDataCenter(raw: InventoryResource): DataCenterRecord {
  return {
    dataCenterId: requiredString(raw.id, "data center id"),
    name: requiredString(raw.name, "data center name"),
    status: stringValue(raw.status),
    raw
  };
}

function toCluster(raw: InventoryResource): ClusterRecord {
  return {
    clusterId: requiredString(raw.id, "cluster id"),
    dataCenterId: refId(raw.data_center),
    name: requiredString(raw.name, "cluster name"),
    cpuType: stringValue(recordValue(raw.cpu)?.type),
    version: versionString(raw.version),
    raw
  };
}

function toHost(raw: InventoryResource): HostRecord {
  const status = stringValue(raw.status);
  return {
    hostId: requiredString(raw.id, "host id"),
    clusterId: refId(raw.cluster),
    name: requiredString(raw.name, "host name"),
    status,
    maintenance: status === "maintenance",
    raw
  };
}

function toStorageDomain(raw: InventoryResource): StorageDomainRecord {
  return {
    storageDomainId: requiredString(raw.id, "storage domain id"),
    dataCenterId: refId(raw.data_center),
    name: requiredString(raw.name, "storage domain name"),
    status: stringValue(raw.status),
    storageType: stringValue(recordValue(raw.storage)?.type ?? raw.type),
    totalBytes: numberValue(raw.total),
    usedBytes: numberValue(raw.used),
    availableBytes: numberValue(raw.available),
    raw
  };
}

function toLogicalNetwork(raw: InventoryResource): LogicalNetworkRecord {
  return {
    networkId: requiredString(raw.id, "network id"),
    dataCenterId: refId(raw.data_center),
    name: requiredString(raw.name, "network name"),
    vlanId: numberValue(recordValue(raw.vlan)?.id),
    raw
  };
}

function toVnicProfile(raw: InventoryResource): VnicProfileRecord {
  return {
    vnicProfileId: requiredString(raw.id, "vNIC profile id"),
    networkId: refId(raw.network),
    name: requiredString(raw.name, "vNIC profile name"),
    qos: refName(raw.qos),
    portMirroring: booleanValue(raw.port_mirroring),
    raw
  };
}

function toVm(raw: InventoryResource, snapshots: VmSnapshotRecord[], collectedAt: Date): VmRecord {
  const guestInfo = recordValue(raw.guest_info);
  const cpuTopology = recordValue(recordValue(raw.cpu)?.topology);
  const highAvailability = recordValue(raw.high_availability);
  const tags = childItems(raw.tags, "tag").map((tag) => stringValue(tag.name)).filter(isString);
  const metadata = customProperties(raw);

  return applyGovernanceAndHealth({
    vmId: requiredString(raw.id, "VM id"),
    name: requiredString(raw.name, "VM name"),
    description: stringValue(raw.description),
    comment: stringValue(raw.comment),
    createdAt: timestampValue(raw.creation_time),
    status: stringValue(raw.status),
    clusterId: refId(raw.cluster),
    clusterName: refName(raw.cluster),
    hostId: refId(raw.host),
    hostName: refName(raw.host),
    haEnabled: booleanValue(highAvailability?.enabled),
    haPriority: numberValue(highAvailability?.priority),
    vcpus: cpuTotal(cpuTopology),
    sockets: numberValue(cpuTopology?.sockets),
    coresPerSocket: numberValue(cpuTopology?.cores),
    threadsPerCore: numberValue(cpuTopology?.threads),
    memoryMb: bytesToMiB(raw.memory),
    maxMemoryMb: bytesToMiB(raw.memory_policy && recordValue(raw.memory_policy)?.max),
    osType: stringValue(recordValue(raw.os)?.type),
    guestOsName: stringValue(recordValue(guestInfo?.os)?.name),
    guestOsVersion: stringValue(recordValue(guestInfo?.os)?.version),
    fqdn: stringValue(guestInfo?.fqdn),
    hostname: stringValue(guestInfo?.host_name),
    guestAgentStatus: guestInfo ? "available" : "missing",
    lastGuestAgentUpdate: timestampValue(guestInfo?.last_update),
    environment: metadata.environment ?? tagEnvironment(tags),
    application: metadata.application,
    serviceRole: metadata.serviceRole,
    owner: metadata.owner,
    onCallGroup: metadata.onCallGroup,
    costCenter: metadata.costCenter,
    criticality: metadata.criticality,
    cmdbCiId: metadata.cmdbCiId,
    ticketReference: metadata.ticketReference,
    backupPolicy: metadata.backupPolicy,
    backupStatus: metadata.backupStatus,
    lastBackupSuccessAt: timestampValue(metadata.lastBackupSuccessAt),
    lastBackupAttemptAt: timestampValue(metadata.lastBackupAttemptAt),
    rpoTargetHours: numberValue(metadata.rpoTargetHours),
    rpoActualHours: numberValue(metadata.rpoActualHours),
    rtoTargetHours: numberValue(metadata.rtoTargetHours),
    lastRestoreTestAt: timestampValue(metadata.lastRestoreTestAt),
    osEolDate: dateValue(metadata.osEolDate),
    lastPatchAt: timestampValue(metadata.lastPatchAt),
    edrStatus: metadata.edrStatus,
    vulnerabilityCriticalCount: numberValue(metadata.vulnerabilityCriticalCount),
    publicIp: metadata.publicIp,
    lifecycleStatus: metadata.lifecycleStatus,
    retireDate: dateValue(metadata.retireDate),
    monthlyEstimatedCost: numberValue(metadata.monthlyEstimatedCost),
    tags,
    nics: childItems(raw.nics, "nic").map(toVmNic),
    disks: childItems(raw.disk_attachments, "disk_attachment").map(toVmDisk),
    snapshots,
    raw
  }, collectedAt);
}

function toVmNic(raw: InventoryResource): VmNicRecord {
  const reportedDevices = childItems(raw.reported_devices, "reported_device");
  return {
    nicId: requiredString(raw.id, "NIC id"),
    name: requiredString(raw.name, "NIC name"),
    macAddress: stringValue(recordValue(raw.mac)?.address),
    vnicProfileId: refId(raw.vnic_profile),
    vnicProfile: refName(raw.vnic_profile),
    interfaceType: stringValue(raw.interface),
    linked: booleanValue(raw.linked),
    ipv4Addresses: reportedDevices.flatMap((device) => ipAddresses(device.ips, "v4")),
    ipv6Addresses: reportedDevices.flatMap((device) => ipAddresses(device.ips, "v6")),
    raw
  };
}

function toVmDisk(raw: InventoryResource): VmDiskRecord {
  const disk = recordValue(raw.disk) ?? raw;
  return {
    diskId: requiredString(disk.id ?? raw.id, "disk id"),
    alias: requiredString(disk.alias ?? disk.name ?? raw.id, "disk alias"),
    storageDomainId: refId(firstChild(disk.storage_domains, "storage_domain")),
    diskFormat: stringValue(disk.format),
    provisionedSizeGib: bytesToGiB(disk.provisioned_size),
    actualSizeGib: bytesToGiB(disk.actual_size),
    interface: stringValue(raw.interface),
    bootable: booleanValue(raw.bootable),
    shareable: booleanValue(disk.shareable),
    raw
  };
}

function toVmSnapshot(raw: InventoryResource): VmSnapshotRecord {
  const createdAt = timestampValue(raw.date);
  return {
    snapshotId: requiredString(raw.id, "snapshot id"),
    description: stringValue(raw.description),
    createdAt,
    status: stringValue(raw.snapshot_status ?? raw.status),
    snapshotType: stringValue(raw.snapshot_type),
    ageDays: createdAt ? Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000)) : undefined,
    raw
  };
}

function toAffinityGroup(raw: InventoryResource): AffinityGroupRecord {
  return {
    affinityGroupId: requiredString(raw.id, "affinity group id"),
    name: requiredString(raw.name, "affinity group name"),
    enforcing: booleanValue(raw.enforcing),
    positive: booleanValue(raw.positive),
    vmIds: childItems(raw.vms, "vm").map((vm) => stringValue(vm.id)).filter(isString),
    raw
  };
}

function toEvent(raw: InventoryResource, fallbackTime: string): EventRecord {
  return {
    eventId: requiredString(raw.id ?? raw.code, "event id"),
    eventTime: timestampValue(raw.time) ?? fallbackTime,
    severity: stringValue(raw.severity),
    resourceType: stringValue(raw.origin),
    resourceId: refId(raw.vm) ?? refId(raw.host) ?? refId(raw.storage_domain),
    message: requiredString(raw.description ?? raw.message, "event message"),
    raw
  };
}

function groupVmSnapshots(rows: InventoryResource[]): Map<string, VmSnapshotRecord[]> {
  const result = new Map<string, VmSnapshotRecord[]>();
  for (const row of rows) {
    const vmId = refId(row.vm);
    if (!vmId) {
      continue;
    }
    result.set(vmId, [...(result.get(vmId) ?? []), toVmSnapshot(row)]);
  }
  return result;
}

function childItems(value: unknown, itemKey: string): InventoryResource[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  const child = (value as Record<string, unknown>)[itemKey];
  if (Array.isArray(child)) {
    return child.filter(isRecord);
  }
  return isRecord(child) ? [child] : [];
}

function customProperties(raw: InventoryResource): Record<string, string> {
  const result: Record<string, string> = {};
  const properties = [...childItems(raw.custom_properties, "custom_property"), ...childItems(raw.properties, "property")];
  for (const property of properties) {
    const name = stringValue(property.name);
    const value = stringValue(property.value);
    if (!name || value === undefined) {
      continue;
    }
    result[toCamelCase(name)] = value;
  }
  return result;
}

function firstChild(value: unknown, itemKey: string): InventoryResource | undefined {
  return childItems(value, itemKey)[0];
}

function ipAddresses(value: unknown, version: "v4" | "v6"): string[] {
  return childItems(value, "ip")
    .filter((ip) => stringValue(ip.version) === version)
    .map((ip) => stringValue(ip.address))
    .filter(isString);
}

function refId(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.id);
}

function refName(value: unknown): string | undefined {
  return stringValue(recordValue(value)?.name);
}

function recordValue(value: unknown): InventoryResource | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
  const parsed = stringValue(value);
  if (!parsed) {
    throw new Error(`oVirt ${label} is missing`);
  }
  return parsed;
}

function timestampValue(value: unknown): string | undefined {
  const parsed = stringValue(value);
  return parsed && !Number.isNaN(Date.parse(parsed)) ? parsed : undefined;
}

function dateValue(value: unknown): string | undefined {
  const parsed = timestampValue(value);
  return parsed ? parsed.slice(0, 10) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function bytesToMiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round(bytes / 1024 / 1024);
}

function bytesToGiB(value: unknown): number | undefined {
  const bytes = numberValue(value);
  return bytes === undefined ? undefined : Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100;
}

function cpuTotal(topology: InventoryResource | undefined): number | undefined {
  const sockets = numberValue(topology?.sockets);
  const cores = numberValue(topology?.cores);
  const threads = numberValue(topology?.threads);
  return sockets && cores && threads ? sockets * cores * threads : undefined;
}

function versionString(value: unknown): string | undefined {
  const version = recordValue(value);
  if (!version) {
    return undefined;
  }
  const major = stringValue(version.major) ?? numberValue(version.major)?.toString();
  const minor = stringValue(version.minor) ?? numberValue(version.minor)?.toString();
  return major && minor ? `${major}.${minor}` : undefined;
}

function tagEnvironment(tags: string[]): string | undefined {
  return tags.find((tag) => ["prod", "production", "dev", "test", "stage"].includes(tag.toLowerCase()));
}

function toCamelCase(value: string): string {
  return value
    .trim()
    .replace(/[-_\s]+(.)?/g, (_match, letter: string | undefined) => (letter ? letter.toUpperCase() : ""))
    .replace(/^./, (letter) => letter.toLowerCase());
}

function isRecord(value: unknown): value is InventoryResource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
