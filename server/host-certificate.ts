export function withoutHostCertificate(host: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(host).filter(([key]) => key !== "certificate" && key !== "certificateExpiresAt" && key !== "certificate_expires_at")
  );
}
