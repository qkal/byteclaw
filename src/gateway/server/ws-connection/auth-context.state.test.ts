import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";

function createLimiter() {
  return {
    check: vi.fn(() => ({ allowed: true, retryAfterMs: 5000 })),
    recordFailure: vi.fn(),
    reset: vi.fn(),
  } as unknown as AuthRateLimiter;
}

describe("resolveConnectAuthState", () => {
  it("records shared-secret failures even when an explicit device token is also present", async () => {
    const rateLimiter = createLimiter();
    const state = await resolveConnectAuthState({
      allowRealIpFallback: false,
      clientIp: "203.0.113.20",
      connectAuth: {
        deviceToken: "fake-device-token",
        token: "wrong-secret",
      },
      hasDeviceIdentity: true,
      rateLimiter,
      req: {
        headers: {},
        socket: { remoteAddress: "203.0.113.20" },
      } as never,
      resolvedAuth: {
        allowTailscale: false,
        mode: "token",
        token: "correct-secret",
      } satisfies ResolvedGatewayAuth,
      trustedProxies: [],
    });

    expect(state.authOk).toBe(false);
    expect(state.authResult.reason).toBe("token_mismatch");
    expect(
      (rateLimiter as never as { recordFailure: ReturnType<typeof vi.fn> }).recordFailure,
    ).toHaveBeenCalled();
  });

  it("does not apply shared-secret lockouts to explicit device-token-only handshakes", async () => {
    const rateLimiter = {
      check: vi.fn(() => ({ allowed: false, retryAfterMs: 5000 })),
      recordFailure: vi.fn(),
      reset: vi.fn(),
    } as unknown as AuthRateLimiter;

    const state = await resolveConnectAuthState({
      allowRealIpFallback: false,
      clientIp: "203.0.113.20",
      connectAuth: {
        deviceToken: "device-token-only",
      },
      hasDeviceIdentity: true,
      rateLimiter,
      req: {
        headers: {},
        socket: { remoteAddress: "203.0.113.20" },
      } as never,
      resolvedAuth: {
        allowTailscale: false,
        mode: "token",
        token: "correct-secret",
      } satisfies ResolvedGatewayAuth,
      trustedProxies: [],
    });

    expect(state.authOk).toBe(false);
    expect(state.authResult.rateLimited).not.toBe(true);
    expect(
      (rateLimiter as never as { check: ReturnType<typeof vi.fn> }).check,
    ).not.toHaveBeenCalled();
  });
});

describe("resolveConnectAuthDecision", () => {
  it("resets the shared-secret limiter after device-token auth succeeds", async () => {
    const rateLimiter = createLimiter();
    await resolveConnectAuthDecision({
      clientIp: "203.0.113.20",
      deviceId: "dev-1",
      hasDeviceIdentity: true,
      publicKey: "pub-1",
      rateLimiter,
      role: "operator",
      scopes: ["operator.read"],
      state: {
        authMethod: "token",
        authOk: false,
        authResult: { ok: false, reason: "token_mismatch" },
        deviceTokenCandidate: "device-token",
        deviceTokenCandidateSource: "explicit-device-token",
        sharedAuthOk: false,
        sharedAuthProvided: true,
      },
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken: async () => ({ ok: true }),
    });

    expect(
      (rateLimiter as never as { reset: ReturnType<typeof vi.fn> }).reset,
    ).toHaveBeenCalledWith("203.0.113.20", "shared-secret");
  });
});
