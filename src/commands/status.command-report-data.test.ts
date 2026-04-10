import { describe, expect, it } from "vitest";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";

describe("buildStatusCommandReportData", () => {
  it("builds report inputs from shared status surfaces", async () => {
    const result = await buildStatusCommandReportData({
      accentDim: (value: string) => `accent(${value})`,
      agentStatus: {
        agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
        bootstrapPendingCount: 1,
        defaultId: "main",
        totalSessions: 2,
      },
      channelIssues: [{ channel: "discord", message: "warn msg" }],
      channels: {
        rows: [{ detail: "ready", enabled: true, id: "discord", label: "Discord", state: "ok" }],
      },
      formatCliCommand: (value: string) => `cmd:${value}`,
      formatHealthChannelLines: () => ["Discord: OK · ready"],
      formatKTokens: (value: number) => `${Math.round(value / 1000)}k`,
      formatPluginCompatibilityNotice: (notice: { message?: unknown }) => String(notice.message),
      formatPromptCacheCompact: () => "cache ok",
      formatTimeAgo: (value: number) => `${value}ms`,
      formatTokensCompact: () => "12k",
      formatUpdateAvailableHint: () => "update available",
      health: { durationMs: 42 },
      lastHeartbeat: {
        accountId: "acct",
        channel: "discord",
        status: "ok",
        ts: Date.now() - 30_000,
      },
      memory: { cache: {}, chunks: 2, files: 1, fts: {}, vector: {} },
      memoryPlugin: { enabled: true, slot: "memory" },
      muted: (value: string) => `muted(${value})`,
      ok: (value: string) => `ok(${value})`,
      opts: { deep: true, verbose: true },
      osSummary: { label: "macOS" },
      pairingRecovery: { requestId: "req-1" },
      pluginCompatibility: [{ message: "legacy", pluginId: "a", severity: "warn" }],
      renderTable: ({ rows }: { rows: Record<string, string>[] }) => `table:${rows.length}`,
      resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" }),
      resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" }),
      resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" }),
      securityAudit: {
        findings: [{ detail: "warn detail", severity: "warn", title: "Warn first" }],
        summary: { critical: 0, info: 0, warn: 1 },
      },
      shortenText: (value: string) => value,
      summary: {
        heartbeat: { agents: [{ agentId: "main", enabled: true, every: "1m", everyMs: 60_000 }] },
        queuedSystemEvents: ["one", "two"],
        sessions: {
          count: 2,
          defaults: { contextTokens: 12_000, model: "gpt-5.4" },
          paths: ["store.json"],
          recent: [
            { age: 5_000, key: "session-key", kind: "chat", model: "gpt-5.4", updatedAt: 1 },
          ],
        },
        taskAudit: { errors: 1, warnings: 0 },
        tasks: { active: 1, byStatus: { queued: 1, running: 1 }, failures: 0, total: 3 },
      },
      surface: {
        cfg: { gateway: { bind: "loopback" }, update: { channel: "stable" } },
        gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
        gatewayMode: "remote",
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewayProbeAuthWarning: "warn-text",
        gatewayReachable: true,
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: {
          installed: true,
          label: "LaunchAgent",
          loadedText: "loaded",
          managedByOpenClaw: true,
          runtimeShort: "running",
        },
        nodeOnlyGateway: null,
        nodeService: {
          installed: true,
          label: "node",
          loadedText: "loaded",
          runtime: { pid: 42, status: "running" },
        },
        remoteUrlMissing: false,
        tailscaleDns: "box.tail.ts.net",
        tailscaleHttpsUrl: "https://box.tail.ts.net",
        tailscaleMode: "serve",
        update: {
          git: {
            ahead: 0,
            behind: 2,
            branch: "main",
            dirty: false,
            fetchOk: true,
            tag: "v1.2.3",
            upstream: "origin/main",
          },
          installKind: "git",
          registry: { latestVersion: "2026.4.10" },
        } as never,
      },
      tableWidth: 120,
      theme: {
        error: (value: string) => `error(${value})`,
        heading: (value: string) => `# ${value}`,
        muted: (value: string) => `muted(${value})`,
        warn: (value: string) => `warn(${value})`,
      },
      updateValue: "available · custom update",
      usageLines: ["usage line"],
      warn: (value: string) => `warn(${value})`,
    } as unknown as Parameters<typeof buildStatusCommandReportData>[0]);

    expect(result.overviewRows[0]).toEqual({
      Item: "OS",
      Value: "macOS · node " + process.versions.node,
    });
    expect(result.taskMaintenanceHint).toBe(
      "Task maintenance: cmd:openclaw tasks maintenance --apply",
    );
    expect(result.pluginCompatibilityLines).toEqual(["  warn(WARN) legacy"]);
    expect(result.pairingRecoveryLines[0]).toBe("warn(Gateway pairing approval required.)");
    expect(result.channelsRows[0]?.Channel).toBe("Discord");
    expect(result.sessionsRows[0]?.Cache).toBe("cache ok");
    expect(result.healthRows?.[0]).toEqual({
      Detail: "42ms",
      Item: "Gateway",
      Status: "ok(reachable)",
    });
    expect(result.footerLines.at(-1)).toBe("  Need to test channels? cmd:openclaw status --deep");
  });
});
