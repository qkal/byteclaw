import { describe, expect, it, vi } from "vitest";
import type { ProgressReporter } from "../../cli/progress.js";
import { buildStatusAllReportLines } from "./report-lines.js";

const diagnosisSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./diagnosis.js", () => ({
  appendStatusAllDiagnosis: diagnosisSpy,
}));

describe("buildStatusAllReportLines", () => {
  it("renders bootstrap column using file-presence semantics", async () => {
    const progress: ProgressReporter = {
      done: () => {},
      setLabel: () => {},
      setPercent: () => {},
      tick: () => {},
    };
    const lines = await buildStatusAllReportLines({
      agentStatus: {
        agents: [
          {
            bootstrapPending: true,
            id: "main",
            lastActiveAgeMs: 12_000,
            sessionsCount: 1,
            sessionsPath: "/tmp/main-sessions.json",
          },
          {
            bootstrapPending: false,
            id: "ops",
            lastActiveAgeMs: null,
            sessionsCount: 0,
            sessionsPath: "/tmp/ops-sessions.json",
          },
        ],
      },
      channelIssues: [],
      channels: {
        details: [],
        rows: [],
      },
      connectionDetailsForReport: "",
      diagnosis: {
        channelIssues: [],
        channelsStatus: null,
        gatewayReachable: false,
        health: null,
        lastErr: null,
        nodeOnlyGateway: null,
        pluginCompatibility: [],
        port: 18_789,
        portUsage: null,
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
      },
      overviewRows: [{ Item: "Gateway", Value: "ok" }],
      progress,
    });

    const output = lines.join("\n");
    expect(output).toContain("Bootstrap file");
    expect(output).toContain("PRESENT");
    expect(output).toContain("ABSENT");
    expect(diagnosisSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        secretDiagnostics: [],
      }),
    );
  });
});
