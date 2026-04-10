import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
  pickGatewaySelfPresence: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  resolveGatewayProbeTarget: vi.fn(),
}));

vi.mock("../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetailsWithResolvers,
}));

vi.mock("../gateway/probe-target.js", () => ({
  resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("./gateway-presence.js", () => ({
  pickGatewaySelfPresence: mocks.pickGatewaySelfPresence,
}));

describe("resolveGatewayProbeSnapshot", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.buildGatewayConnectionDetailsWithResolvers.mockReturnValue({
      message: "Gateway target: ws://127.0.0.1:18789",
      url: "ws://127.0.0.1:18789",
      urlSource: "local loopback",
    });
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      gatewayMode: "remote",
      mode: "remote",
      remoteUrlMissing: true,
    });
    mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
      auth: { password: "pw", token: "tok" },
      warning: "warn",
    });
    mocks.pickGatewaySelfPresence.mockReturnValue({ host: "box" });
  });

  it("skips auth resolution and probe for missing remote urls by default", async () => {
    const { resolveGatewayProbeSnapshot } = await import("./status.scan.shared.js");

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(mocks.resolveGatewayProbeAuthResolution).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
    expect(result).toEqual({
      gatewayCallOverrides: {
        password: undefined,
        token: undefined,
        url: "ws://127.0.0.1:18789",
      },
      gatewayConnection: expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
      gatewayMode: "remote",
      gatewayProbe: null,
      gatewayProbeAuth: {},
      gatewayProbeAuthWarning: undefined,
      gatewayReachable: false,
      gatewaySelf: null,
      remoteUrlMissing: true,
    });
  });

  it("can probe the local fallback when remote url is missing", async () => {
    mocks.probeGateway.mockResolvedValue({
      close: null,
      configSnapshot: null,
      connectLatencyMs: 12,
      error: null,
      health: {},
      ok: true,
      presence: [{ host: "box" }],
      status: {},
      url: "ws://127.0.0.1:18789",
    });
    const { resolveGatewayProbeSnapshot } = await import("./status.scan.shared.js");

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {
        detailLevel: "full",
        mergeAuthWarningIntoProbeError: false,
        probeWhenRemoteUrlMissing: true,
        resolveAuthWhenRemoteUrlMissing: true,
      },
    });

    expect(mocks.resolveGatewayProbeAuthResolution).toHaveBeenCalled();
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { password: "pw", token: "tok" },
        detailLevel: "full",
        url: "ws://127.0.0.1:18789",
      }),
    );
    expect(result.gatewayReachable).toBe(true);
    expect(result.gatewaySelf).toEqual({ host: "box" });
    expect(result.gatewayCallOverrides).toEqual({
      password: "pw",
      token: "tok",
      url: "ws://127.0.0.1:18789",
    });
    expect(result.gatewayProbeAuthWarning).toBe("warn");
  });

  it("merges auth warnings into failed probe errors by default", async () => {
    mocks.resolveGatewayProbeTarget.mockReturnValue({
      gatewayMode: "local",
      mode: "local",
      remoteUrlMissing: false,
    });
    mocks.probeGateway.mockResolvedValue({
      close: null,
      configSnapshot: null,
      connectLatencyMs: null,
      error: "timeout",
      health: null,
      ok: false,
      presence: null,
      status: null,
      url: "ws://127.0.0.1:18789",
    });
    const { resolveGatewayProbeSnapshot } = await import("./status.scan.shared.js");

    const result = await resolveGatewayProbeSnapshot({
      cfg: {},
      opts: {},
    });

    expect(result.gatewayProbe?.error).toBe("timeout; warn");
    expect(result.gatewayProbeAuthWarning).toBeUndefined();
  });
});
