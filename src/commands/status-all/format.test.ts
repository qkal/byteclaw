import { describe, expect, it } from "vitest";
import {
  buildGatewayStatusJsonPayload,
  buildGatewayStatusSummaryParts,
  buildStatusGatewaySurfaceValues,
  buildStatusOverviewRows,
  buildStatusOverviewSurfaceRows,
  buildStatusUpdateSurface,
  formatGatewaySelfSummary,
  formatStatusDashboardValue,
  formatStatusServiceValue,
  formatStatusTailscaleValue,
  resolveStatusDashboardUrl,
} from "./format.js";

describe("status-all format", () => {
  it("formats gateway self summary consistently", () => {
    expect(
      formatGatewaySelfSummary({
        host: "gateway-host",
        ip: "100.64.0.1",
        platform: "linux",
        version: "1.2.3",
      }),
    ).toBe("gateway-host (100.64.0.1) app 1.2.3 linux");
    expect(formatGatewaySelfSummary(null)).toBeNull();
  });

  it("builds gateway summary parts for fallback remote targets", () => {
    expect(
      buildGatewayStatusSummaryParts({
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "missing gateway.remote.url (fallback local)",
        },
        gatewayMode: "remote",
        gatewayProbe: null,
        gatewayProbeAuth: { token: "tok" },
        gatewayReachable: false,
        remoteUrlMissing: true,
      }),
    ).toEqual({
      authText: "",
      modeLabel: "remote (remote.url missing)",
      reachText: "misconfigured (remote.url missing)",
      targetText: "fallback ws://127.0.0.1:18789",
      targetTextWithSource:
        "fallback ws://127.0.0.1:18789 (missing gateway.remote.url (fallback local))",
    });
  });

  it("formats dashboard values consistently", () => {
    expect(formatStatusDashboardValue("https://openclaw.local")).toBe("https://openclaw.local");
    expect(formatStatusDashboardValue("")).toBe("disabled");
    expect(formatStatusDashboardValue(null)).toBe("disabled");
  });

  it("builds shared update surface values", () => {
    const newerRegistryVersion = "9999.0.0";

    expect(
      buildStatusUpdateSurface({
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
          registry: {
            latestVersion: newerRegistryVersion,
          },
        } as never,
        updateConfigChannel: "stable",
      }),
    ).toEqual({
      channelInfo: {
        channel: "stable",
        label: "stable (config)",
        source: "config",
      },
      channelLabel: "stable (config)",
      gitLabel: "main · tag v1.2.3",
      updateAvailable: true,
      updateLine: `git main · ↔ origin/main · behind 2 · npm update ${newerRegistryVersion}`,
    });
  });

  it("resolves dashboard urls from gateway config", () => {
    expect(
      resolveStatusDashboardUrl({
        cfg: {
          gateway: {
            bind: "loopback",
            controlUi: { basePath: "/ui", enabled: true },
          },
        },
      }),
    ).toBe("http://127.0.0.1:18789/ui/");
    expect(
      resolveStatusDashboardUrl({
        cfg: {
          gateway: {
            controlUi: { enabled: false },
          },
        },
      }),
    ).toBeNull();
  });

  it("formats tailscale values for terse and detailed views", () => {
    expect(
      formatStatusTailscaleValue({
        dnsName: "box.tail.ts.net",
        httpsUrl: "https://box.tail.ts.net",
        tailscaleMode: "serve",
      }),
    ).toBe("serve · box.tail.ts.net · https://box.tail.ts.net");
    expect(
      formatStatusTailscaleValue({
        backendState: "Running",
        includeBackendStateWhenOn: true,
        tailscaleMode: "funnel",
      }),
    ).toBe("funnel · Running · magicdns unknown");
    expect(
      formatStatusTailscaleValue({
        backendState: "Stopped",
        dnsName: "box.tail.ts.net",
        includeBackendStateWhenOff: true,
        includeDnsNameWhenOff: true,
        tailscaleMode: "off",
      }),
    ).toBe("off · Stopped · box.tail.ts.net");
  });

  it("formats service values across short and detailed runtime surfaces", () => {
    expect(
      formatStatusServiceValue({
        installed: false,
        label: "LaunchAgent",
        loadedText: "loaded",
      }),
    ).toBe("LaunchAgent not installed");
    expect(
      formatStatusServiceValue({
        installed: true,
        label: "LaunchAgent",
        loadedText: "loaded",
        managedByOpenClaw: true,
        runtimeShort: "running",
      }),
    ).toBe("LaunchAgent installed · loaded · running");
    expect(
      formatStatusServiceValue({
        installed: true,
        label: "systemd",
        loadedText: "not loaded",
        runtimePid: 42,
        runtimeStatus: "failed",
      }),
    ).toBe("systemd not loaded · failed (pid 42)");
  });

  it("builds gateway json payloads consistently", () => {
    expect(
      buildGatewayStatusJsonPayload({
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        gatewayMode: "remote",
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuthWarning: "warn",
        gatewayReachable: true,
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        remoteUrlMissing: false,
      }),
    ).toEqual({
      authWarning: "warn",
      connectLatencyMs: 123,
      error: null,
      misconfigured: false,
      mode: "remote",
      reachable: true,
      self: { host: "gateway", version: "1.2.3" },
      url: "wss://gateway.example.com",
      urlSource: "config",
    });
  });

  it("builds shared gateway surface values for node and gateway views", () => {
    expect(
      buildStatusGatewaySurfaceValues({
        cfg: { gateway: { bind: "loopback" } },
        decorateOk: (value) => `ok(${value})`,
        decorateWarn: (value) => `warn(${value})`,
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
        gatewayMode: "remote",
        gatewayProbe: { connectLatencyMs: 123, error: null },
        gatewayProbeAuth: { token: "tok" },
        gatewayReachable: true,
        gatewaySelf: { host: "gateway", version: "1.2.3" },
        gatewayService: {
          installed: true,
          label: "LaunchAgent",
          loadedText: "loaded",
          managedByOpenClaw: true,
          runtimeShort: "running",
        },
        nodeService: {
          installed: true,
          label: "node",
          loadedText: "loaded",
          runtime: { pid: 42, status: "running" },
        },
        remoteUrlMissing: false,
      }),
    ).toEqual({
      dashboardUrl: "http://127.0.0.1:18789/",
      gatewaySelfValue: "gateway app 1.2.3",
      gatewayServiceValue: "LaunchAgent installed · loaded · running",
      gatewayValue:
        "remote · wss://gateway.example.com (config) · ok(reachable 123ms) · auth token · gateway app 1.2.3",
      nodeServiceValue: "node loaded · running (pid 42)",
    });
  });

  it("prefers node-only gateway values when present", () => {
    expect(
      buildStatusGatewaySurfaceValues({
        cfg: { gateway: { controlUi: { enabled: false } } },
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
        },
        gatewayMode: "local",
        gatewayProbe: null,
        gatewayProbeAuth: null,
        gatewayReachable: false,
        gatewaySelf: null,
        gatewayService: {
          installed: false,
          label: "LaunchAgent",
          loadedText: "not loaded",
        },
        nodeOnlyGateway: {
          gatewayValue: "node → remote.example:18789 · no local gateway",
        },
        nodeService: {
          installed: true,
          label: "node",
          loadedText: "loaded",
          runtimeShort: "running",
        },
        remoteUrlMissing: false,
      }),
    ).toEqual({
      dashboardUrl: null,
      gatewaySelfValue: null,
      gatewayServiceValue: "LaunchAgent not installed",
      gatewayValue: "node → remote.example:18789 · no local gateway",
      nodeServiceValue: "node loaded · running",
    });
  });

  it("builds overview rows with shared ordering", () => {
    expect(
      buildStatusOverviewRows({
        agentsValue: "2 total",
        channelLabel: "stable",
        dashboardValue: "https://openclaw.local",
        gatewayAuthWarning: "warning",
        gatewaySelfValue: "gateway-host",
        gatewayServiceValue: "launchd loaded",
        gatewayValue: "local · reachable",
        gitLabel: "main @ v1.0.0",
        middleRows: [{ Item: "Security", Value: "Run: openclaw security audit --deep" }],
        nodeServiceValue: "node loaded",
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        tailscaleValue: "serve · https://tail.example",
        updateValue: "up to date",
      }),
    ).toEqual([
      { Item: "Version", Value: "1.0.0" },
      { Item: "Dashboard", Value: "https://openclaw.local" },
      { Item: "Tailscale", Value: "serve · https://tail.example" },
      { Item: "Channel", Value: "stable" },
      { Item: "Git", Value: "main @ v1.0.0" },
      { Item: "Update", Value: "up to date" },
      { Item: "Gateway", Value: "local · reachable" },
      { Item: "Gateway auth warning", Value: "warning" },
      { Item: "Security", Value: "Run: openclaw security audit --deep" },
      { Item: "Gateway self", Value: "gateway-host" },
      { Item: "Gateway service", Value: "launchd loaded" },
      { Item: "Node service", Value: "node loaded" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });

  it("builds overview surface rows from shared gateway and update inputs", () => {
    expect(
      buildStatusOverviewSurfaceRows({
        agentsValue: "2 total",
        cfg: {
          gateway: { bind: "loopback" },
          update: { channel: "stable" },
        },
        gatewayAuthWarningValue: "warn(warn-text)",
        gatewayConnection: {
          url: "wss://gateway.example.com",
          urlSource: "config",
        },
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
        middleRows: [{ Item: "Security", Value: "Run audit" }],
        nodeService: {
          installed: true,
          label: "node",
          loadedText: "loaded",
          runtime: { pid: 42, status: "running" },
        },
        prefixRows: [{ Item: "Version", Value: "1.0.0" }],
        remoteUrlMissing: false,
        suffixRows: [{ Item: "Secrets", Value: "none" }],
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
        updateValue: "available · custom update",
      }),
    ).toEqual([
      { Item: "Version", Value: "1.0.0" },
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      { Item: "Tailscale", Value: "serve · box.tail.ts.net · https://box.tail.ts.net" },
      { Item: "Channel", Value: "stable (config)" },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "available · custom update" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · reachable 123ms · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway auth warning", Value: "warn(warn-text)" },
      { Item: "Security", Value: "Run audit" },
      { Item: "Gateway self", Value: "gateway app 1.2.3" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });
});
