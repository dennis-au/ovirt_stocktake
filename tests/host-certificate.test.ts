import { describe, expect, it } from "vitest";
import { certificateExpiresAtFromHost, withoutHostCertificateContent } from "../server/host-certificate.js";

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUDeE+toDJFc0d1kEkBYdwp3v81uYwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUb3ZpcnQtaW52ZW50b3J5LXRlc3QwHhcNMjYwODE4MDMx
MTMzWhcNMzYwODE1MDMxMTMzWjAfMR0wGwYDVQQDDBRvdmlydC1pbnZlbnRvcnkt
dGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALVRE6bEYtttVp3K
Jgnv6Pry181Pes0uylGj7MyE9bzsisBtHP8GvvaT/OinT+CryQnOC3jzffB98Pyj
MhM0nRUjdK4ZXW+ySMtfrtAvU4vKG6L3F29fVGNAXv5xpNeQvgVq8favK9yFdAmB
Yj65fmnnicKu6/IpvXBVpwg0zLMbvfppo6wC4RN1gXLgciPUc8FOGIPM3IPEkKOE
BD8ECALhy2JF/kNgp0oVuXSQ2MslGvBYBS+EKEhOQShVylYW8k3GBahwU5PfJ1Wg
qnPGJlKG1u0AApVIYReZR6SxFNV+7gsQYWgNUrPJBn5xPH66VIssh3h8kJdxdd1Z
MLdTocECAwEAAaNTMFEwHQYDVR0OBBYEFCuj5KSY/4KrOpGXca4N4K0Pc91gMB8G
A1UdIwQYMBaAFCuj5KSY/4KrOpGXca4N4K0Pc91gMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBABsJGSFmhzZ+0RHMKHTitdaowWsuURBj+jqr4e8t
u8UiLRuRP8laM/BZfiEvY6DnhV4cZvIPweY5WFd8nfMhYESMSVOXVPk3CyQu20t9
eUnMUg+rIgVBfDnNZDSE5acevjAlQwTqRFL28OIWMZj3ItkP7s/tUM75Fvry0jBZ
oWzR6x5skR93UbtKUxoGK7DD4tvBfvz/zelc51iIGqeUkaJBEAdIO2M9izjv9Ltw
NImE6NjJ7Wh6SDbrZmn0T5cL6LZTtD2NfCHtqQ98xmSFTbOLDvE6N3bm4AOGPS1+
U3wlWF6Y1KPpKJFAmkLL3WUbej3tzDcmo3+bhkk8eFJp1AE=
-----END CERTIFICATE-----`;

describe("host certificate normalization", () => {
  it("derives the expiry timestamp and strips PEM material", () => {
    const host = { name: "host-01", certificate: { content: testCertificate } };

    expect(certificateExpiresAtFromHost(host)).toBe("2036-08-15T03:11:33.000Z");
    expect(withoutHostCertificateContent(host)).toEqual({ name: "host-01", certificateExpiresAt: "2036-08-15T03:11:33.000Z" });
  });

  it("treats missing or malformed certificates as unavailable", () => {
    expect(certificateExpiresAtFromHost({ certificate: { content: "not a certificate" } })).toBeUndefined();
    expect(withoutHostCertificateContent({ name: "host-01", certificate: { content: "not a certificate" } })).toEqual({ name: "host-01" });
  });
});
