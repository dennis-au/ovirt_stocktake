export function isActiveVmSnapshot(snapshot: Record<string, unknown>): boolean {
  const snapshotType = stringValue(snapshot.snapshot_type ?? snapshot.snapshotType);
  if (snapshotType?.trim().toLowerCase() === "active") {
    return true;
  }

  const name = stringValue(snapshot.name) ?? stringValue(snapshot.description);
  return name?.trim().toLowerCase() === "active vm";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
