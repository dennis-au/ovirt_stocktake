import { describe, expect, it } from "vitest";
import { withoutHostCertificate } from "../server/host-certificate.js";

describe("host certificate sanitization", () => {
  it("removes certificate metadata and legacy expiry fields", () => {
    const host = {
      name: "host-01",
      certificate: { content: "raw-certificate-material" },
      certificateExpiresAt: "2036-08-15T03:11:33.000Z",
      certificate_expires_at: "2036-08-15T03:11:33.000Z"
    };

    expect(withoutHostCertificate(host)).toEqual({ name: "host-01" });
  });

  it("preserves hosts without certificate fields", () => {
    expect(withoutHostCertificate({ id: "host-01", name: "host-01", status: "up" })).toEqual({ id: "host-01", name: "host-01", status: "up" });
  });
});
