import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { type ConnectAuthState, resolveConnectAuthDecision } from "./auth-context.js";

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];
type VerifyBootstrapTokenFn = Parameters<
  typeof resolveConnectAuthDecision
>[0]["verifyBootstrapToken"];

function createRateLimiter(params?: { allowed?: boolean; retryAfterMs?: number }): {
  limiter: AuthRateLimiter;
  reset: ReturnType<typeof vi.fn>;
} {
  const allowed = params?.allowed ?? true;
  const retryAfterMs = params?.retryAfterMs ?? 5000;
  const check = vi.fn(() => ({ allowed, retryAfterMs }));
  const reset = vi.fn();
  const recordFailure = vi.fn();
  return {
    limiter: {
      check,
      recordFailure,
      reset,
    } as unknown as AuthRateLimiter,
    reset,
  };
}

function createBaseState(overrides?: Partial<ConnectAuthState>): ConnectAuthState {
  return {
    authMethod: "token",
    authOk: false,
    authResult: { ok: false, reason: "token_mismatch" },
    deviceTokenCandidate: "device-token",
    deviceTokenCandidateSource: "shared-token-fallback",
    sharedAuthOk: false,
    sharedAuthProvided: true,
    ...overrides,
  };
}

async function resolveDeviceTokenDecision(params: {
  verifyDeviceToken: VerifyDeviceTokenFn;
  verifyBootstrapToken?: VerifyBootstrapTokenFn;
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}) {
  return await resolveConnectAuthDecision({
    deviceId: "dev-1",
    hasDeviceIdentity: true,
    publicKey: "pub-1",
    role: "operator",
    scopes: ["operator.read"],
    state: createBaseState(params.stateOverrides),
    verifyBootstrapToken:
      params.verifyBootstrapToken ??
      (async () => ({ ok: false, reason: "bootstrap_token_invalid" })),
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
}

describe("resolveConnectAuthDecision", () => {
  it("keeps shared-secret mismatch when fallback device-token check fails", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const decision = await resolveConnectAuthDecision({
      deviceId: "dev-1",
      hasDeviceIdentity: true,
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      state: createBaseState(),
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("token_mismatch");
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("reports explicit device-token mismatches as device_token_mismatch", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const decision = await resolveConnectAuthDecision({
      deviceId: "dev-1",
      hasDeviceIdentity: true,
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      state: createBaseState({
        deviceTokenCandidateSource: "explicit-device-token",
      }),
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("device_token_mismatch");
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createRateLimiter();
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      clientIp: "203.0.113.20",
      rateLimiter: rateLimiter.limiter,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledWith("203.0.113.20", "device-token");
  });

  it("accepts valid bootstrap tokens before device-token fallback", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: "device-token",
      },
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("reports invalid bootstrap tokens when no device token fallback is available", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: undefined,
        deviceTokenCandidateSource: undefined,
      },
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("bootstrap_token_invalid");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createRateLimiter({ allowed: false, retryAfterMs: 60_000 });
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      clientIp: "203.0.113.20",
      rateLimiter: rateLimiter.limiter,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(60_000);
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("still verifies the device token when only the shared-secret path is rate-limited", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      stateOverrides: {
        authResult: {
          ok: false,
          rateLimited: true,
          reason: "rate_limited",
          retryAfterMs: 60_000,
        },
      },
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("prefers a valid bootstrap token over an already successful shared auth path", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveConnectAuthDecision({
      deviceId: "dev-1",
      hasDeviceIdentity: true,
      publicKey: "pub-1",
      role: "node",
      scopes: [],
      state: createBaseState({
        authMethod: "tailscale",
        authOk: true,
        authResult: { method: "tailscale", ok: true },
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: undefined,
        deviceTokenCandidateSource: undefined,
      }),
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("keeps the original successful auth path when bootstrap validation fails", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveConnectAuthDecision({
      deviceId: "dev-1",
      hasDeviceIdentity: true,
      publicKey: "pub-1",
      role: "node",
      scopes: [],
      state: createBaseState({
        authMethod: "tailscale",
        authOk: true,
        authResult: { method: "tailscale", ok: true },
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: undefined,
        deviceTokenCandidateSource: undefined,
      }),
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("tailscale");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });
});
