import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldUseSecureSessionCookie } from "@/lib/auth-cookie";

describe("shouldUseSecureSessionCookie", () => {
  it("uses secure cookies for public HTTPS behind Traefik", () => {
    assert.equal(
      shouldUseSecureSessionCookie({
        forwardedProto: "https",
        requestProtocol: "http:",
      }),
      true
    );
  });

  it("uses non-secure cookies for loopback HTTP validation", () => {
    assert.equal(
      shouldUseSecureSessionCookie({
        forwardedProto: null,
        requestProtocol: "http:",
      }),
      false
    );
  });

  it("uses the first forwarded protocol from a proxy chain", () => {
    assert.equal(
      shouldUseSecureSessionCookie({
        forwardedProto: "https, http",
        requestProtocol: "http:",
      }),
      true
    );
  });
});
