import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStatusJsonPayload, resolveStatusUpdateChannelInfo } from "./status-json-payload.ts";

const mocks = vi.hoisted(() => ({
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    label: "stable",
    source: "config",
  })),
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

describe("status-json-payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves update channel info through the shared channel display path", () => {
    expect(
      resolveStatusUpdateChannelInfo({
        update: {
          git: {
            branch: "main",
            tag: "v1.2.3",
          },
          installKind: "package",
        },
        updateConfigChannel: "beta",
      }),
    ).toEqual({
      channel: "stable",
      label: "stable",
      source: "config",
    });
    expect(mocks.normalizeUpdateChannel).toHaveBeenCalledWith("beta");
    expect(mocks.resolveUpdateChannelDisplay).toHaveBeenCalledWith({
      configChannel: "beta",
      gitBranch: "main",
      gitTag: "v1.2.3",
      installKind: "package",
    });
  });

  it("builds the shared status json payload with optional sections", () => {
    expect(
      buildStatusJsonPayload({
        agents: [{ id: "main" }],
        health: { ok: true },
        lastHeartbeat: { status: "ok" },
        memory: null,
        memoryPlugin: { enabled: true },
        osSummary: { platform: "linux" },
        pluginCompatibility: [
          {
            code: "legacy-before-agent-start",
            message: "warn",
            pluginId: "legacy",
            severity: "warn",
          },
        ],
        secretDiagnostics: ["diag"],
        securityAudit: { summary: { critical: 1 } },
        summary: { ok: true },
        surface: {
          cfg: { gateway: {}, update: { channel: "stable" } },
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayMode: "remote",
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayProbeAuth: { token: "tok" },
          gatewayProbeAuthWarning: "warn",
          gatewayReachable: true,
          gatewaySelf: { host: "gateway" },
          gatewayService: { installed: true, label: "LaunchAgent", loadedText: "loaded" },
          nodeService: { installed: true, label: "node", loadedText: "loaded" },
          remoteUrlMissing: false,
          tailscaleMode: "serve",
          update: {
            installKind: "package",
            packageManager: "npm",
            registry: { latestVersion: "1.2.3" },
            root: "/tmp/openclaw",
          } as never,
        },
        usage: { providers: [] },
      }),
    ).toEqual({
      agents: [{ id: "main" }],
      gateway: {
        authWarning: "warn",
        connectLatencyMs: 42,
        error: null,
        misconfigured: false,
        mode: "remote",
        reachable: true,
        self: { host: "gateway" },
        url: "wss://gateway.example.com",
        urlSource: "config",
      },
      gatewayService: { installed: true, label: "LaunchAgent", loadedText: "loaded" },
      health: { ok: true },
      lastHeartbeat: { status: "ok" },
      memory: null,
      memoryPlugin: { enabled: true },
      nodeService: { installed: true, label: "node", loadedText: "loaded" },
      ok: true,
      os: { platform: "linux" },
      pluginCompatibility: {
        count: 1,
        warnings: [
          {
            code: "legacy-before-agent-start",
            message: "warn",
            pluginId: "legacy",
            severity: "warn",
          },
        ],
      },
      secretDiagnostics: ["diag"],
      securityAudit: { summary: { critical: 1 } },
      update: {
        installKind: "package",
        packageManager: "npm",
        registry: { latestVersion: "1.2.3" },
        root: "/tmp/openclaw",
      },
      updateChannel: "stable",
      updateChannelSource: "config",
      usage: { providers: [] },
    });
  });

  it("omits optional sections when they are absent", () => {
    expect(
      buildStatusJsonPayload({
        agents: [],
        memory: null,
        memoryPlugin: null,
        osSummary: { platform: "linux" },
        secretDiagnostics: [],
        summary: { ok: true },
        surface: {
          cfg: { gateway: {} },
          gatewayConnection: { url: "ws://127.0.0.1:18789" },
          gatewayMode: "local",
          gatewayProbe: null,
          gatewayProbeAuth: null,
          gatewayProbeAuthWarning: null,
          gatewayReachable: false,
          gatewaySelf: null,
          gatewayService: { installed: false, label: "LaunchAgent", loadedText: "not installed" },
          nodeService: { installed: false, label: "node", loadedText: "not installed" },
          remoteUrlMissing: false,
          tailscaleMode: "off",
          update: {
            installKind: "package",
            packageManager: "npm",
            root: "/tmp/openclaw",
          } as never,
        },
      }),
    ).not.toHaveProperty("securityAudit");
  });
});
