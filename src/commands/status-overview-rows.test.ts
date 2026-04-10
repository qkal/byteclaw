import { describe, expect, it } from "vitest";
import {
  buildStatusAllOverviewRows,
  buildStatusCommandOverviewRows,
} from "./status-overview-rows.ts";

describe("status-overview-rows", () => {
  it("builds command overview rows from the shared surface", () => {
    expect(
      buildStatusCommandOverviewRows({
        agentStatus: {
          agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
          bootstrapPendingCount: 1,
          defaultId: "main",
          totalSessions: 2,
        },
        formatKTokens: (value: number) => `${Math.round(value / 1000)}k`,
        formatTimeAgo: (value: number) => `${value}ms`,
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
        opts: { deep: true },
        osLabel: "macOS",
        pluginCompatibility: [{ message: "legacy", pluginId: "a", severity: "warn" }],
        resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" }),
        resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" }),
        resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" }),
        summary: {
          heartbeat: {
            agents: [{ agentId: "main", enabled: true, every: "1m", everyMs: 60_000 }],
          },
          queuedSystemEvents: ["one", "two"],
          sessions: {
            count: 2,
            defaults: { contextTokens: 12_000, model: "gpt-5.4" },
            paths: ["store.json"],
          },
          taskAudit: { errors: 1, warnings: 0 },
          tasks: { active: 1, byStatus: { queued: 1, running: 1 }, failures: 0, total: 3 },
        },
        surface: {
          cfg: { gateway: { bind: "loopback" }, update: { channel: "stable" } },
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayMode: "remote",
          gatewayProbe: { connectLatencyMs: 42, error: null },
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
        updateValue: "available · custom update",
        warn: (value: string) => `warn(${value})`,
      } as unknown as Parameters<typeof buildStatusCommandOverviewRows>[0]),
    ).toEqual(
      expect.arrayContaining([
        { Item: "OS", Value: `macOS · node ${process.versions.node}` },
        {
          Item: "Memory",
          Value:
            "1 files · 2 chunks · plugin memory · ok(vector ready) · warn(fts ready) · muted(cache warm)",
        },
        { Item: "Plugin compatibility", Value: "warn(1 notice · 1 plugin)" },
        { Item: "Sessions", Value: "2 active · default gpt-5.4 (12k ctx) · store.json" },
      ]),
    );
  });

  it("builds status-all overview rows from the shared surface", () => {
    expect(
      buildStatusAllOverviewRows({
        agentStatus: {
          agents: [{ id: "main", lastActiveAgeMs: 60_000 }],
          bootstrapPendingCount: 1,
          totalSessions: 2,
        },
        configPath: "/tmp/openclaw.json",
        osLabel: "macOS",
        secretDiagnosticsCount: 2,
        surface: {
          cfg: { gateway: { bind: "loopback" }, update: { channel: "stable" } },
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayMode: "remote",
          gatewayProbe: { connectLatencyMs: 42, error: null },
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
          tailscaleHttpsUrl: null,
          tailscaleMode: "off",
          update: {
            git: { branch: "main", tag: "v1.2.3", upstream: "origin/main" },
            installKind: "git",
          } as never,
        },
        tailscaleBackendState: "Running",
      } as unknown as Parameters<typeof buildStatusAllOverviewRows>[0]),
    ).toEqual(
      expect.arrayContaining([
        { Item: "Version", Value: expect.any(String) },
        { Item: "OS", Value: "macOS" },
        { Item: "Config", Value: "/tmp/openclaw.json" },
        { Item: "Security", Value: "Run: openclaw security audit --deep" },
        { Item: "Secrets", Value: "2 diagnostics" },
      ]),
    );
  });
});
