import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { statusJsonCommand } from "./status-json.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
  })),
  runSecurityAudit: vi.fn(),
  scanStatusJsonFast: vi.fn(),
}));

vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: mocks.scanStatusJsonFast,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

function createRuntimeCapture() {
  const logs: string[] = [];
  const runtime: RuntimeEnv = {
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
    log: vi.fn((value: unknown) => {
      logs.push(String(value));
    }),
  };
  return { logs, runtime };
}

function createScanResult() {
  return {
    agentStatus: [],
    cfg: { update: { channel: "stable" } },
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    gatewayMode: "local",
    gatewayProbe: null,
    gatewayProbeAuthWarning: null,
    gatewayReachable: false,
    gatewaySelf: null,
    memory: null,
    memoryPlugin: null,
    osSummary: { platform: "linux" },
    remoteUrlMissing: false,
    secretDiagnostics: [],
    sourceConfig: {},
    summary: { configuredChannels: [], ok: true },
    update: { git: { branch: null, tag: null }, installKind: "npm" },
  };
}

describe("statusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanStatusJsonFast.mockResolvedValue(createScanResult());
    mocks.runSecurityAudit.mockResolvedValue({
      findings: [],
      summary: { critical: 1, info: 0, warn: 0 },
    });
    mocks.getDaemonStatusSummary.mockResolvedValue({ installed: false });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ installed: false });
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.callGateway.mockResolvedValue({});
  });

  it("keeps plain status --json off the security audit fast path", async () => {
    const { runtime, logs } = createRuntimeCapture();

    await statusJsonCommand({}, runtime);

    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).not.toHaveProperty("securityAudit");
  });

  it("includes security audit details only when --all is requested", async () => {
    const { runtime, logs } = createRuntimeCapture();

    await statusJsonCommand({ all: true }, runtime);

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: expect.any(Object),
      deep: false,
      includeChannelSecurity: true,
      includeFilesystem: true,
      sourceConfig: expect.any(Object),
    });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toHaveProperty("securityAudit.summary.critical", 1);
  });
});
