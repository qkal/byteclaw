import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { MemoryStatusSnapshot } from "./status.scan.shared.js";

const { resolveStatusSummaryFromOverview, resolveMemoryPluginStatus } = vi.hoisted(() => ({
  resolveMemoryPluginStatus: vi.fn(() => ({
    enabled: false,
    reason: "memorySearch not configured",
    slot: null,
  })),
  resolveStatusSummaryFromOverview: vi.fn(async () => ({ sessions: { count: 1 } })),
}));

describe("executeStatusScanFromOverview", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("./status.scan-overview.ts", () => ({
      resolveStatusSummaryFromOverview,
    }));
    vi.doMock("./status.scan.shared.js", () => ({
      resolveMemoryPluginStatus,
    }));
  });

  it("resolves memory and summary, then builds the final scan result", async () => {
    const { executeStatusScanFromOverview } = await import("./status.scan-execute.ts");

    const overview = {
      agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
      cfg: { channels: {} },
      gatewaySnapshot: {
        gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "local" },
        gatewayMode: "local",
        gatewayProbe: null,
        gatewayProbeAuth: {},
        gatewayProbeAuthWarning: undefined,
        gatewayReachable: true,
        gatewaySelf: null,
        remoteUrlMissing: false,
      },
      osSummary: { label: "linux" },
      secretDiagnostics: ["diag"],
      skipColdStartNetworkChecks: false,
      sourceConfig: { channels: {} },
      tailscaleDns: "box.tail.ts.net",
      tailscaleHttpsUrl: "https://box.tail.ts.net",
      tailscaleMode: "tailnet",
      update: { available: false, installKind: "package" },
    } as unknown as StatusScanOverviewResult;
    const resolveMemory = vi.fn<
      (args: {
        cfg: unknown;
        agentStatus: unknown;
        memoryPlugin: unknown;
        runtime?: unknown;
      }) => Promise<MemoryStatusSnapshot>
    >(async () => ({
      agentId: "main",
      backend: "builtin",
      provider: "memory-core",
    }));

    const result = await executeStatusScanFromOverview({
      channelIssues: [],
      channels: { details: [], rows: [] },
      overview,
      pluginCompatibility: [],
      resolveMemory,
      runtime: {} as never,
    });

    expect(resolveMemoryPluginStatus).toHaveBeenCalledWith(overview.cfg);
    expect(resolveStatusSummaryFromOverview).toHaveBeenCalledWith({ overview });
    expect(resolveMemory).toHaveBeenCalledWith({
      agentStatus: overview.agentStatus,
      cfg: overview.cfg,
      memoryPlugin: { enabled: false, reason: "memorySearch not configured", slot: null },
      runtime: {},
    });
    expect(result).toEqual(
      expect.objectContaining({
        cfg: overview.cfg,
        channels: { details: [], rows: [] },
        gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "local" },
        gatewayMode: "local",
        gatewayReachable: true,
        memory: { agentId: "main", backend: "builtin", provider: "memory-core" },
        pluginCompatibility: [],
        secretDiagnostics: ["diag"],
        sourceConfig: overview.sourceConfig,
        summary: { sessions: { count: 1 } },
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
      }),
    );
  });
});
