import { describe, expect, it } from "vitest";
import {
  PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
  PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS,
  PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS,
  resolveCdpReachabilityTimeouts,
} from "./cdp-timeouts.js";

describe("resolveCdpReachabilityTimeouts", () => {
  it("uses loopback defaults when timeout is omitted", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: true,
        remoteHandshakeTimeoutMs: 3000,
        remoteHttpTimeoutMs: 1500,
        timeoutMs: undefined,
      }),
    ).toEqual({
      httpTimeoutMs: PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      wsTimeoutMs: PROFILE_HTTP_REACHABILITY_TIMEOUT_MS * 2,
    });
  });

  it("clamps loopback websocket timeout range", () => {
    const low = resolveCdpReachabilityTimeouts({
      profileIsLoopback: true,
      remoteHandshakeTimeoutMs: 3000,
      remoteHttpTimeoutMs: 1500,
      timeoutMs: 1,
    });
    const high = resolveCdpReachabilityTimeouts({
      profileIsLoopback: true,
      remoteHandshakeTimeoutMs: 3000,
      remoteHttpTimeoutMs: 1500,
      timeoutMs: 5000,
    });

    expect(low.wsTimeoutMs).toBe(PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS);
    expect(high.wsTimeoutMs).toBe(PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS);
  });

  it("enforces remote minimums even when caller passes lower timeout", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        remoteHandshakeTimeoutMs: 3000,
        remoteHttpTimeoutMs: 1500,
        timeoutMs: 200,
      }),
    ).toEqual({
      httpTimeoutMs: 1500,
      wsTimeoutMs: 3000,
    });
  });

  it("uses remote defaults when timeout is omitted", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        remoteHandshakeTimeoutMs: 3250,
        remoteHttpTimeoutMs: 1750,
        timeoutMs: undefined,
      }),
    ).toEqual({
      httpTimeoutMs: 1750,
      wsTimeoutMs: 3250,
    });
  });
});
