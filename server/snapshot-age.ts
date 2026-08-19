export function snapshotCreatedAt(value: unknown): string | undefined {
  const timestamp = typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

export function snapshotAgeDaysAt(createdAt: string | undefined, referenceAt: string): number | undefined {
  if (!createdAt) {
    return undefined;
  }

  const createdTimestamp = Date.parse(createdAt);
  const referenceTimestamp = Date.parse(referenceAt);
  if (Number.isNaN(createdTimestamp) || Number.isNaN(referenceTimestamp)) {
    return undefined;
  }

  return Math.max(0, Math.floor((referenceTimestamp - createdTimestamp) / 86_400_000));
}
