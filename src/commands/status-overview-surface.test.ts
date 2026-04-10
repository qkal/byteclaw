import { describe, expect, it } from "vitest";
import {
  buildStatusGatewayJsonPayloadFromSurface,
  buildStatusOverviewRowsFromSurface,
  buildStatusOverviewSurfaceFromOverview,
  buildStatusOverviewSurfaceFromScan,
} from "./status-overview-surface.ts";

const baseCfg = { gateway: { bind: "loopback" }, update: { channel: "stable" } } as const;
const baseUpdate = { git: { branch: "main", tag: "v1.2.3" }, installKind: "git" } as never;
const baseGatewaySnapshot = {
  gatewayConnection: {
    message: "Gateway target: wss://gateway.example.com",
    url: "wss://gateway.example.com",
    urlSource: "config",
  },
  gatewayMode: "remote",
  gatewayProbe: { connectLatencyMs: 42, error: null } as never,
  gatewayProbeAuth: { token: "tok" },
  gatewayProbeAuthWarning: "warn-text",
  gatewayReachable: true,
  gatewaySelf: { host: "gateway", version: "1.2.3" },
  remoteUrlMissing: false,
} as const;
const baseScanFields = {
  cfg: baseCfg,
  tailscaleDns: "box.tail.ts.net",
  tailscaleHttpsUrl: "https://box.tail.ts.net",
  tailscaleMode: "serve",
  update: baseUpdate,
  ...baseGatewaySnapshot,
};
const baseGatewayService = {
  installed: true,
  label: "LaunchAgent",
  loadedText: "loaded",
  managedByOpenClaw: true,
  runtimeShort: "running",
};
const baseNodeService = {
  installed: true,
  label: "node",
  loadedText: "loaded",
  runtime: { pid: 42, status: "running" },
};
const baseServices = {
  gatewayService: baseGatewayService,
  nodeOnlyGateway: null,
  nodeService: baseNodeService,
};
const baseOverviewSurface = {
  ...baseScanFields,
  ...baseServices,
};

describe("status-overview-surface", () => {
  it("builds the shared overview surface from a status scan result", () => {
    expect(
      buildStatusOverviewSurfaceFromScan({
        scan: baseScanFields,
        ...baseServices,
      }),
    ).toEqual(baseOverviewSurface);
  });

  it("builds the shared overview surface from scan overview data", () => {
    expect(
      buildStatusOverviewSurfaceFromOverview({
        overview: {
          cfg: baseCfg,
          gatewaySnapshot: baseGatewaySnapshot,
          tailscaleDns: "box.tail.ts.net",
          tailscaleHttpsUrl: "https://box.tail.ts.net",
          tailscaleMode: "serve",
          update: baseUpdate,
        } as never,
        ...baseServices,
      }),
    ).toEqual(baseOverviewSurface);
  });

  it("builds overview rows from the shared surface bundle", () => {
    expect(
      buildStatusOverviewRowsFromSurface({
        agentsValue: "2 total",
        decorateOk: (value) => `ok(${value})`,
        decorateTailscaleOff: (value) => `muted(${value})`,
        decorateWarn: (value) => `warn(${value})`,
        gatewayAuthWarningValue: "warn(warn-text)",
        gatewaySelfFallbackValue: "gateway-self",
        includeBackendStateWhenOff: true,
        includeDnsNameWhenOff: true,
        prefixRows: [{ Item: "OS", Value: "macOS · node 22" }],
        suffixRows: [{ Item: "Secrets", Value: "none" }],
        surface: {
          ...baseOverviewSurface,
          cfg: baseCfg,
          gatewayConnection: {
            url: "wss://gateway.example.com",
            urlSource: "config",
          },
          tailscaleHttpsUrl: null,
          tailscaleMode: "off",
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
      }),
    ).toEqual([
      { Item: "OS", Value: "macOS · node 22" },
      { Item: "Dashboard", Value: "http://127.0.0.1:18789/" },
      { Item: "Tailscale", Value: "muted(off · box.tail.ts.net)" },
      { Item: "Channel", Value: "stable (config)" },
      { Item: "Git", Value: "main · tag v1.2.3" },
      { Item: "Update", Value: "available · custom update" },
      {
        Item: "Gateway",
        Value:
          "remote · wss://gateway.example.com (config) · ok(reachable 42ms) · auth token · gateway app 1.2.3",
      },
      { Item: "Gateway auth warning", Value: "warn(warn-text)" },
      { Item: "Gateway self", Value: "gateway-self" },
      { Item: "Gateway service", Value: "LaunchAgent installed · loaded · running" },
      { Item: "Node service", Value: "node loaded · running (pid 42)" },
      { Item: "Agents", Value: "2 total" },
      { Item: "Secrets", Value: "none" },
    ]);
  });

  it("builds the shared gateway json payload from the overview surface", () => {
    expect(
      buildStatusGatewayJsonPayloadFromSurface({
        surface: {
          gatewayConnection: {
            message: "Gateway target: wss://gateway.example.com",
            url: "wss://gateway.example.com",
            urlSource: "config",
          },
          gatewayMode: "remote",
          gatewayProbe: { connectLatencyMs: 42, error: null } as never,
          gatewayProbeAuthWarning: "warn-text",
          gatewayReachable: true,
          gatewaySelf: { host: "gateway", version: "1.2.3" },
          remoteUrlMissing: false,
        } as never,
      }),
    ).toEqual({
      authWarning: "warn-text",
      connectLatencyMs: 42,
      error: null,
      misconfigured: false,
      mode: "remote",
      reachable: true,
      self: { host: "gateway", version: "1.2.3" },
      url: "wss://gateway.example.com",
      urlSource: "config",
    });
  });
});
