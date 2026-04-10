import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";

vi.mock("../../daemon/launchd.js", () => ({
  resolveGatewayLogPaths: () => {
    throw new Error("skip log tail");
  },
}));

vi.mock("./gateway.js", () => ({
  readFileTailLines: vi.fn(async () => []),
  summarizeLogTail: vi.fn(() => []),
}));

import { appendStatusAllDiagnosis } from "./diagnosis.js";

type DiagnosisParams = Parameters<typeof appendStatusAllDiagnosis>[0];

function createProgressReporter(): ProgressReporter {
  return {
    done: () => {},
    setLabel: () => {},
    setPercent: () => {},
    tick: () => {},
  };
}

function createBaseParams(
  listeners: NonNullable<DiagnosisParams["portUsage"]>["listeners"],
): DiagnosisParams {
  return {
    channelIssues: [],
    channelsStatus: null,
    connectionDetailsForReport: "ws://127.0.0.1:18789",
    fail: (text: string) => text,
    gatewayReachable: false,
    health: null,
    lastErr: null,
    lines: [] as string[],
    muted: (text: string) => text,
    nodeOnlyGateway: null,
    ok: (text: string) => text,
    pluginCompatibility: [],
    port: 18_789,
    portUsage: { hints: [], listeners, port: 18_789, status: "busy" },
    progress: createProgressReporter(),
    remoteUrlMissing: false,
    secretDiagnostics: [],
    sentinel: null,
    skillStatus: null,
    snap: null,
    tailscale: {
      backendState: null,
      dnsName: null,
      error: null,
      ips: [],
    },
    tailscaleHttpsUrl: null,
    tailscaleMode: "off",
    warn: (text: string) => text,
  };
}

describe("status-all diagnosis port checks", () => {
  it("treats same-process dual-stack loopback listeners as healthy", async () => {
    const params = createBaseParams([
      { address: "127.0.0.1:18789", commandLine: "openclaw-gateway", pid: 5001 },
      { address: "[::1]:18789", commandLine: "openclaw-gateway", pid: 5001 },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain("Detected dual-stack loopback listeners");
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process listener conflicts", async () => {
    const params = createBaseParams([
      { address: "127.0.0.1:18789", commandLine: "openclaw-gateway", pid: 5001 },
      { address: "[::1]:18789", commandLine: "openclaw-gateway", pid: 5002 },
    ]);

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("avoids unreachable gateway diagnosis in node-only mode", async () => {
    const params = createBaseParams([]);
    params.connectionDetailsForReport = [
      "Node-only mode detected",
      "Local gateway: not expected on this machine",
      "Remote gateway target: gateway.example.com:19000",
    ].join("\n");
    params.tailscale.backendState = "Running";
    params.health = undefined;
    params.nodeOnlyGateway = {
      connectionDetails: [
        "Node-only mode detected",
        "Local gateway: not expected on this machine",
        "Remote gateway target: gateway.example.com:19000",
        "Inspect the remote gateway host for live channel and health details.",
      ].join("\n"),
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "node → gateway.example.com:19000 · no local gateway",
    };

    await appendStatusAllDiagnosis(params);

    const output = params.lines.join("\n");
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
  });
});
