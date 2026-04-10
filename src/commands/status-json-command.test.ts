import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusJsonCommand } from "./status-json-command.ts";

const mocks = vi.hoisted(() => ({
  resolveStatusJsonOutput: vi.fn(async (input) => ({ built: true, input })),
  writeRuntimeJson: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  writeRuntimeJson: mocks.writeRuntimeJson,
}));

vi.mock("./status-json-runtime.ts", () => ({
  resolveStatusJsonOutput: mocks.resolveStatusJsonOutput,
}));

describe("runStatusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shares the fast-json scan and output flow", async () => {
    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    } as never;
    const scan = {
      agentStatus: [],
      cfg: { gateway: {} },
      gatewayConnection: {
        message: "Gateway target: ws://127.0.0.1:18789",
        url: "ws://127.0.0.1:18789",
        urlSource: "config",
      },
      gatewayMode: "local" as const,
      gatewayProbe: null,
      gatewayProbeAuth: { token: "tok" },
      gatewayProbeAuthWarning: null,
      gatewayReachable: true,
      gatewaySelf: null,
      memory: null,
      memoryPlugin: null,
      osSummary: { platform: "linux" },
      remoteUrlMissing: false,
      secretDiagnostics: [],
      sourceConfig: { gateway: {} },
      summary: { ok: true },
      tailscaleDns: null,
      tailscaleHttpsUrl: null,
      tailscaleMode: "off",
      update: { installKind: "package" as const, packageManager: "npm" as const, root: null },
    };
    const scanStatusJsonFast = vi.fn(async () => scan);

    await runStatusJsonCommand({
      includePluginCompatibility: true,
      includeSecurityAudit: true,
      opts: { all: true, deep: true, timeoutMs: 1234, usage: true },
      runtime,
      scanStatusJsonFast,
      suppressHealthErrors: true,
    });

    expect(scanStatusJsonFast).toHaveBeenCalledWith({ all: true, timeoutMs: 1234 }, runtime);
    expect(mocks.resolveStatusJsonOutput).toHaveBeenCalledWith({
      includePluginCompatibility: true,
      includeSecurityAudit: true,
      opts: { all: true, deep: true, timeoutMs: 1234, usage: true },
      scan,
      suppressHealthErrors: true,
    });
    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(runtime, {
      built: true,
      input: {
        includePluginCompatibility: true,
        includeSecurityAudit: true,
        opts: { all: true, deep: true, timeoutMs: 1234, usage: true },
        scan,
        suppressHealthErrors: true,
      },
    });
  });
});
