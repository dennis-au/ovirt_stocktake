export function snapshotCreatedAt(value: unknown): string | undefined {
  return typeof value === "string" && value && !Number.isNaN(Date.parse(value)) ? value : undefined;
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
