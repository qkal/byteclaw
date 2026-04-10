import { describe, expect, it } from "vitest";
import { testOnlyResolveAuthTokenForSignature } from "./test-helpers.server.js";

describe("testOnlyResolveAuthTokenForSignature", () => {
  it("matches connect auth precedence for bootstrap tokens", () => {
    expect(
      testOnlyResolveAuthTokenForSignature({
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
        token: undefined,
      }),
    ).toBe("bootstrap-token");
  });

  it("still prefers the shared token when present", () => {
    expect(
      testOnlyResolveAuthTokenForSignature({
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
        token: "shared-token",
      }),
    ).toBe("shared-token");
  });
});
