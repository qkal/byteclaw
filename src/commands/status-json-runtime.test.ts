import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

const mocks = vi.hoisted(() => ({
  buildStatusJsonPayload: vi.fn((input) => ({ built: true, input })),
  resolveStatusRuntimeSnapshot: vi.fn(),
}));

vi.mock("./status-json-payload.ts", () => ({
  buildStatusJsonPayload: mocks.buildStatusJsonPayload,
}));

vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: mocks.resolveStatusRuntimeSnapshot,
}));

function createScan() {
  return {
    agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
    cfg: { gateway: {}, update: { channel: "stable" } },
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    gatewayMode: "local" as const,
    gatewayProbe: { connectLatencyMs: 42, error: null },
    gatewayProbeAuth: { token: "tok" },
    gatewayProbeAuthWarning: null,
    gatewayReachable: true,
    gatewaySelf: { host: "gateway" },
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
    remoteUrlMissing: false,
    secretDiagnostics: [],
    sourceConfig: { gateway: {} },
    summary: { ok: true },
    update: {
      installKind: "package",
      packageManager: "npm",
      root: "/tmp/openclaw",
    },
  } satisfies Parameters<typeof resolveStatusJsonOutput>[0]["scan"];
}

describe("status-json-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValue({
      gatewayService: { label: "LaunchAgent" },
      health: { ok: true },
      lastHeartbeat: { status: "ok" },
      nodeService: { label: "node" },
      securityAudit: { summary: { critical: 1 } },
      usage: { providers: [] },
    });
  });

  it("builds the full json output for status --json", async () => {
    const result = await resolveStatusJsonOutput({
      includePluginCompatibility: true,
      includeSecurityAudit: true,
      opts: { deep: true, timeoutMs: 1234, usage: true },
      scan: createScan(),
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { gateway: {}, update: { channel: "stable" } },
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: true,
      sourceConfig: { gateway: {} },
      suppressHealthErrors: undefined,
      timeoutMs: 1234,
      usage: true,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        health: { ok: true },
        lastHeartbeat: { status: "ok" },
        pluginCompatibility: [
          {
            code: "legacy-before-agent-start",
            message: "warn",
            pluginId: "legacy",
            severity: "warn",
          },
        ],
        securityAudit: { summary: { critical: 1 } },
        surface: expect.objectContaining({
          gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
          gatewayProbeAuth: { token: "tok" },
          gatewayService: { label: "LaunchAgent" },
          nodeService: { label: "node" },
        }),
        usage: { providers: [] },
      }),
    );
    expect(result).toEqual({ built: true, input: expect.any(Object) });
  });

  it("skips optional sections when flags are off", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      gatewayService: { label: "LaunchAgent" },
      health: undefined,
      lastHeartbeat: null,
      nodeService: { label: "node" },
      securityAudit: undefined,
      usage: undefined,
    });

    await resolveStatusJsonOutput({
      includePluginCompatibility: false,
      includeSecurityAudit: false,
      opts: { deep: false, timeoutMs: 500, usage: false },
      scan: createScan(),
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { gateway: {}, update: { channel: "stable" } },
      deep: false,
      gatewayReachable: true,
      includeSecurityAudit: false,
      sourceConfig: { gateway: {} },
      suppressHealthErrors: undefined,
      timeoutMs: 500,
      usage: false,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        health: undefined,
        lastHeartbeat: null,
        pluginCompatibility: undefined,
        securityAudit: undefined,
        surface: expect.objectContaining({
          gatewayProbeAuth: { token: "tok" },
        }),
        usage: undefined,
      }),
    );
  });

  it("suppresses health errors when requested", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      gatewayService: { label: "LaunchAgent" },
      health: undefined,
      lastHeartbeat: { status: "ok" },
      nodeService: { label: "node" },
      securityAudit: undefined,
      usage: undefined,
    });

    await resolveStatusJsonOutput({
      includeSecurityAudit: false,
      opts: { deep: true, timeoutMs: 500 },
      scan: createScan(),
      suppressHealthErrors: true,
    });

    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        health: undefined,
        surface: expect.objectContaining({
          gatewayProbeAuth: { token: "tok" },
        }),
      }),
    );
    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { gateway: {}, update: { channel: "stable" } },
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: false,
      sourceConfig: { gateway: {} },
      suppressHealthErrors: true,
      timeoutMs: 500,
      usage: undefined,
    });
  });
});
