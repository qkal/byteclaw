import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildChannelsTable: vi.fn(),
  callGateway: vi.fn(),
  collectChannelStatusIssues: vi.fn(),
  createStatusScanCoreBootstrap: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(),
  hasPotentialConfiguredChannels: vi.fn(),
  readBestEffortConfig: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
  resolveOsSummary: vi.fn(),
}));

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getStatusCommandSecretTargetIds: mocks.getStatusCommandSecretTargetIds,
}));

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: mocks.resolveOsSummary,
}));

vi.mock("./status.scan.bootstrap-shared.js", () => ({
  createStatusScanCoreBootstrap: mocks.createStatusScanCoreBootstrap,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.scan.runtime.js", () => ({
  statusScanRuntime: {
    buildChannelsTable: mocks.buildChannelsTable,
    collectChannelStatusIssues: mocks.collectChannelStatusIssues,
  },
}));

describe("collectStatusScanOverview", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
    mocks.readBestEffortConfig.mockResolvedValue({ session: {} });
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      diagnostics: ["secret warning"],
      resolvedConfig: { session: {} },
    });
    mocks.resolveOsSummary.mockReturnValue({ label: "test-os" });
    mocks.createStatusScanCoreBootstrap.mockResolvedValue({
      agentStatusPromise: Promise.resolve({
        agents: [],
        bootstrapPendingCount: 0,
        defaultId: "main",
        totalSessions: 0,
      }),
      gatewayProbePromise: Promise.resolve({
        gatewayCallOverrides: {
          token: "tok",
          url: "ws://127.0.0.1:18789",
        },
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "missing gateway.remote.url (fallback local)",
        },
        gatewayMode: "remote",
        gatewayProbe: { error: null, ok: true },
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: "warn",
        gatewayReachable: true,
        gatewaySelf: { host: "box" },
        remoteUrlMissing: true,
      }),
      resolveTailscaleHttpsUrl: vi.fn(async () => "https://box.tail.ts.net"),
      skipColdStartNetworkChecks: false,
      tailscaleDnsPromise: Promise.resolve("box.tail.ts.net"),
      tailscaleMode: "serve",
      updatePromise: Promise.resolve({ installKind: "git" }),
    });
    mocks.callGateway.mockResolvedValue({ channelAccounts: {} });
    mocks.collectChannelStatusIssues.mockReturnValue([{ channel: "signal", message: "boom" }]);
    mocks.buildChannelsTable.mockResolvedValue({ details: [], rows: [] });
  });

  it("uses gateway fallback overrides for channels.status when requested", async () => {
    const { collectStatusScanOverview } = await import("./status.scan-overview.ts");

    const result = await collectStatusScanOverview({
      commandName: "status --all",
      opts: { timeoutMs: 1234 },
      showSecrets: false,
      useGatewayCallOverridesForChannelsStatus: true,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "channels.status",
        token: "tok",
        url: "ws://127.0.0.1:18789",
      }),
    );
    expect(mocks.buildChannelsTable).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        showSecrets: false,
        sourceConfig: { session: {} },
      }),
    );
    expect(result.channelIssues).toEqual([{ channel: "signal", message: "boom" }]);
  });

  it("skips channels.status when the gateway is unreachable", async () => {
    mocks.createStatusScanCoreBootstrap.mockResolvedValueOnce({
      agentStatusPromise: Promise.resolve({
        agents: [],
        bootstrapPendingCount: 0,
        defaultId: "main",
        totalSessions: 0,
      }),
      gatewayProbePromise: Promise.resolve({
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "default",
        },
        gatewayMode: "local",
        gatewayProbe: null,
        gatewayProbeAuth: {},
        gatewayProbeAuthWarning: undefined,
        gatewayReachable: false,
        gatewaySelf: null,
        remoteUrlMissing: false,
      }),
      resolveTailscaleHttpsUrl: vi.fn(async () => null),
      skipColdStartNetworkChecks: false,
      tailscaleDnsPromise: Promise.resolve(null),
      tailscaleMode: "off",
      updatePromise: Promise.resolve({ installKind: "git" }),
    });
    const { collectStatusScanOverview } = await import("./status.scan-overview.ts");

    const result = await collectStatusScanOverview({
      commandName: "status",
      opts: {},
      showSecrets: true,
    });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(result.channelsStatus).toBeNull();
    expect(result.channelIssues).toEqual([]);
  });
});
