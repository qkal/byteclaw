import { describe, expect, it } from "vitest";
import { buildStatusScanResult } from "./status.scan-result.ts";
import { buildColdStartStatusSummary } from "./status.scan.bootstrap-shared.ts";

describe("buildStatusScanResult", () => {
  it("builds the full shared scan result shape", () => {
    const osSummary = {
      arch: "x64",
      label: "linux 6.8.0 (x64)",
      platform: "linux" as const,
      release: "6.8.0",
    };
    const update = {
      installKind: "package" as const,
      packageManager: "npm" as const,
      root: "/tmp/openclaw",
    };
    const gatewaySnapshot = {
      gatewayConnection: {
        message: "Gateway target: ws://127.0.0.1:18789",
        url: "ws://127.0.0.1:18789",
        urlSource: "config" as const,
      },
      gatewayMode: "local" as const,
      gatewayProbe: {
        close: null,
        configSnapshot: null,
        connectLatencyMs: 42,
        error: null,
        health: null,
        ok: true,
        presence: null,
        status: null,
        url: "ws://127.0.0.1:18789",
      },
      gatewayProbeAuth: { token: "tok" },
      gatewayProbeAuthWarning: "warn",
      gatewayReachable: true,
      gatewaySelf: { host: "gateway" },
      remoteUrlMissing: false,
    };
    const channelIssues = [
      {
        accountId: "default",
        channel: "discord",
        kind: "runtime" as const,
        message: "warn",
      },
    ];
    const agentStatus = {
      agents: [
        {
          bootstrapPending: false,
          id: "main",
          lastActiveAgeMs: null,
          lastUpdatedAt: null,
          sessionsCount: 0,
          sessionsPath: "/tmp/main.json",
          workspaceDir: null,
        },
      ],
      bootstrapPendingCount: 0,
      defaultId: "main",
      totalSessions: 0,
    };
    const channels = { details: [], rows: [] };
    const summary = buildColdStartStatusSummary();
    const memory = { agentId: "main", backend: "builtin" as const, provider: "sqlite" };
    const memoryPlugin = { enabled: true, slot: "memory-core" };
    const pluginCompatibility = [
      {
        code: "legacy-before-agent-start" as const,
        message: "warn",
        pluginId: "legacy",
        severity: "warn" as const,
      },
    ];

    expect(
      buildStatusScanResult({
        agentStatus,
        cfg: { gateway: {} },
        channelIssues,
        channels,
        gatewaySnapshot,
        memory,
        memoryPlugin,
        osSummary,
        pluginCompatibility,
        secretDiagnostics: ["diag"],
        sourceConfig: { gateway: {} },
        summary,
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        tailscaleMode: "serve",
        update,
      }),
    ).toEqual({
      agentStatus,
      cfg: { gateway: {} },
      channelIssues,
      channels,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      gatewayMode: gatewaySnapshot.gatewayMode,
      gatewayProbe: gatewaySnapshot.gatewayProbe,
      gatewayProbeAuth: gatewaySnapshot.gatewayProbeAuth,
      gatewayProbeAuthWarning: gatewaySnapshot.gatewayProbeAuthWarning,
      gatewayReachable: gatewaySnapshot.gatewayReachable,
      gatewaySelf: gatewaySnapshot.gatewaySelf,
      memory,
      memoryPlugin,
      osSummary,
      pluginCompatibility,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: ["diag"],
      sourceConfig: { gateway: {} },
      summary,
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      tailscaleMode: "serve",
      update,
    });
  });
});
