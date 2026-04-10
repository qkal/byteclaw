import { describe, expect, it } from "vitest";
import {
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./credential-state.js";

describe("resolveTokenExpiryState", () => {
  const now = 1_700_000_000_000;

  it("treats undefined as missing", () => {
    expect(resolveTokenExpiryState(undefined, now)).toBe("missing");
  });

  it("treats non-finite and non-positive values as invalid_expires", () => {
    expect(resolveTokenExpiryState(0, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(-1, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(Number.NaN, now)).toBe("invalid_expires");
    expect(resolveTokenExpiryState(Number.POSITIVE_INFINITY, now)).toBe("invalid_expires");
  });

  it("returns expired when expires is in the past", () => {
    expect(resolveTokenExpiryState(now - 1, now)).toBe("expired");
  });

  it("returns valid when expires is in the future", () => {
    expect(resolveTokenExpiryState(now + 1, now)).toBe("valid");
  });
});

describe("evaluateStoredCredentialEligibility", () => {
  const now = 1_700_000_000_000;

  it("marks api_key with keyRef as eligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        keyRef: {
          id: "ANTHROPIC_API_KEY",
          provider: "default",
          source: "env",
        },
        provider: "anthropic",
        type: "api_key",
      },
      now,
    });
    expect(result).toEqual({ eligible: true, reasonCode: "ok" });
  });

  it("marks tokenRef with missing expires as eligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        provider: "github-copilot",
        tokenRef: {
          id: "GITHUB_TOKEN",
          provider: "default",
          source: "env",
        },
        type: "token",
      },
      now,
    });
    expect(result).toEqual({ eligible: true, reasonCode: "ok" });
  });

  it("marks token with invalid expires as ineligible", () => {
    const result = evaluateStoredCredentialEligibility({
      credential: {
        expires: 0,
        provider: "github-copilot",
        token: "tok",
        type: "token",
      },
      now,
    });
    expect(result).toEqual({ eligible: false, reasonCode: "invalid_expires" });
  });
});
