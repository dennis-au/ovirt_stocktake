import { describe, expect, it } from "vitest";
import { certificateExpiresAtFromHost, withoutHostCertificateContent } from "../server/host-certificate.js";
import { testHostCertificate } from "./fixtures/host-certificate.js";

describe("host certificate normalization", () => {
  it("derives the expiry timestamp and strips PEM material", () => {
    const host = { name: "host-01", certificate: { content: testHostCertificate } };

    expect(certificateExpiresAtFromHost(host)).toBe("2036-08-15T03:11:33.000Z");
    expect(withoutHostCertificateContent(host)).toEqual({ name: "host-01", certificateExpiresAt: "2036-08-15T03:11:33.000Z" });
  });

  it("treats missing or malformed certificates as unavailable", () => {
    expect(certificateExpiresAtFromHost({ certificate: { content: "not a certificate" } })).toBeUndefined();
    expect(withoutHostCertificateContent({ name: "host-01", certificate: { content: "not a certificate" } })).toEqual({ name: "host-01" });
  });
});
