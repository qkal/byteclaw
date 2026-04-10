import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveStatusGatewayHealth,
  resolveStatusGatewayHealthSafe,
  resolveStatusLastHeartbeat,
  resolveStatusRuntimeDetails,
  resolveStatusRuntimeSnapshot,
  resolveStatusSecurityAudit,
  resolveStatusServiceSummaries,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

describe("status-runtime-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.runSecurityAudit.mockResolvedValue({ findings: [], summary: { critical: 0 } });
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "node" });
  });

  it("resolves the shared security audit payload", async () => {
    await resolveStatusSecurityAudit({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
    });

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      deep: false,
      includeChannelSecurity: true,
      includeFilesystem: true,
      sourceConfig: { gateway: {} },
    });
  });

  it("resolves usage summaries with the provided timeout", async () => {
    await resolveStatusUsageSummary(1234);

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({ timeoutMs: 1234 });
  });

  it("resolves gateway health with the shared probe call shape", async () => {
    await resolveStatusGatewayHealth({
      config: { gateway: {} },
      timeoutMs: 5000,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: { gateway: {} },
      method: "health",
      params: { probe: true },
      timeoutMs: 5000,
    });
  });

  it("returns a fallback health error when the gateway is unreachable", async () => {
    await expect(
      resolveStatusGatewayHealthSafe({
        config: { gateway: {} },
        gatewayProbeError: "timeout",
        gatewayReachable: false,
      }),
    ).resolves.toEqual({ error: "timeout" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("passes gateway call overrides through the safe health path", async () => {
    await resolveStatusGatewayHealthSafe({
      callOverrides: {
        token: "tok",
        url: "ws://127.0.0.1:18789",
      },
      config: { gateway: {} },
      gatewayReachable: true,
      timeoutMs: 4321,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: { gateway: {} },
      method: "health",
      params: { probe: true },
      timeoutMs: 4321,
      token: "tok",
      url: "ws://127.0.0.1:18789",
    });
  });

  it("returns null for heartbeat when the gateway is unreachable", async () => {
    expect(
      await resolveStatusLastHeartbeat({
        config: { gateway: {} },
        gatewayReachable: false,
        timeoutMs: 1000,
      }),
    ).toBeNull();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("catches heartbeat gateway errors and returns null", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("boom"));

    expect(
      await resolveStatusLastHeartbeat({
        config: { gateway: {} },
        gatewayReachable: true,
        timeoutMs: 1000,
      }),
    ).toBeNull();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: { gateway: {} },
      method: "last-heartbeat",
      params: {},
      timeoutMs: 1000,
    });
  });

  it("resolves daemon summaries together", async () => {
    await expect(resolveStatusServiceSummaries()).resolves.toEqual([
      { label: "LaunchAgent" },
      { label: "node" },
    ]);
  });

  it("resolves shared runtime details with optional usage and deep fields", async () => {
    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        deep: true,
        gatewayReachable: true,
        timeoutMs: 1234,
        usage: true,
      }),
    ).resolves.toEqual({
      gatewayService: { label: "LaunchAgent" },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      nodeService: { label: "node" },
      usage: { providers: [] },
    });
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({ timeoutMs: 1234 });
    expect(mocks.callGateway).toHaveBeenNthCalledWith(1, {
      config: { gateway: {} },
      method: "health",
      params: { probe: true },
      timeoutMs: 1234,
    });
    expect(mocks.callGateway).toHaveBeenNthCalledWith(2, {
      config: { gateway: {} },
      method: "last-heartbeat",
      params: {},
      timeoutMs: 1234,
    });
  });

  it("skips optional runtime details when flags are off", async () => {
    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        deep: false,
        gatewayReachable: true,
        timeoutMs: 1234,
        usage: false,
      }),
    ).resolves.toEqual({
      gatewayService: { label: "LaunchAgent" },
      health: undefined,
      lastHeartbeat: null,
      nodeService: { label: "node" },
      usage: undefined,
    });
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("suppresses health failures inside shared runtime details", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("boom"));

    await expect(
      resolveStatusRuntimeDetails({
        config: { gateway: {} },
        deep: true,
        gatewayReachable: false,
        suppressHealthErrors: true,
        timeoutMs: 1234,
      }),
    ).resolves.toEqual({
      gatewayService: { label: "LaunchAgent" },
      health: undefined,
      lastHeartbeat: null,
      nodeService: { label: "node" },
      usage: undefined,
    });
  });

  it("resolves the shared runtime snapshot with security audit and runtime details", async () => {
    await expect(
      resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        deep: true,
        gatewayReachable: true,
        includeSecurityAudit: true,
        sourceConfig: { gateway: { mode: "local" } },
        timeoutMs: 1234,
        usage: true,
      }),
    ).resolves.toEqual({
      gatewayService: { label: "LaunchAgent" },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      nodeService: { label: "node" },
      securityAudit: { findings: [], summary: { critical: 0 } },
      usage: { providers: [] },
    });
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      deep: false,
      includeChannelSecurity: true,
      includeFilesystem: true,
      sourceConfig: { gateway: { mode: "local" } },
    });
  });
});
