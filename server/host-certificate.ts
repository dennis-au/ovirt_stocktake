import { X509Certificate } from "node:crypto";

export function certificateExpiresAtFromHost(host: Record<string, unknown>): string | undefined {
  return normalizedTimestamp(host.certificateExpiresAt ?? host.certificate_expires_at) ?? certificateExpiresAtFromPem(certificateContent(host.certificate));
}

export function certificateExpiresAtFromPem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    return normalizedTimestamp(new X509Certificate(value).validTo);
  } catch {
    return undefined;
  }
}

export function withoutHostCertificateContent(host: Record<string, unknown>): Record<string, unknown> {
  const withoutCertificate = Object.fromEntries(Object.entries(host).filter(([key]) => key !== "certificate"));
  const certificateExpiresAt = certificateExpiresAtFromHost(host);
  return certificateExpiresAt ? { ...withoutCertificate, certificateExpiresAt } : withoutCertificate;
}

function certificateContent(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).content : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}
