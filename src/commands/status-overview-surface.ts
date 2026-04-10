import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  type StatusOverviewRow,
  buildGatewayStatusJsonPayload,
  buildStatusOverviewSurfaceRows,
} from "./status-all/format.js";
import type { NodeOnlyGatewayInfo } from "./status.node-mode.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

interface StatusGatewayConnection {
  url: string;
  urlSource?: string;
}

type StatusGatewayProbe = {
  connectLatencyMs?: number | null;
  error?: string | null;
} | null;

type StatusGatewayAuth = {
  token?: string;
  password?: string;
} | null;

type StatusGatewaySelf =
  | {
      host?: string | null;
      ip?: string | null;
      version?: string | null;
      platform?: string | null;
    }
  | null
  | undefined;

interface StatusServiceSummary {
  label: string;
  installed: boolean | null;
  managedByOpenClaw?: boolean;
  loadedText: string;
  runtimeShort?: string | null;
  runtime?: {
    status?: string | null;
    pid?: number | null;
  } | null;
}

export interface StatusOverviewSurface {
  cfg: Pick<OpenClawConfig, "update" | "gateway">;
  update: UpdateCheckResult;
  tailscaleMode: string;
  tailscaleDns?: string | null;
  tailscaleHttpsUrl?: string | null;
  gatewayMode: "local" | "remote";
  remoteUrlMissing: boolean;
  gatewayConnection: StatusGatewayConnection;
  gatewayReachable: boolean;
  gatewayProbe: StatusGatewayProbe;
  gatewayProbeAuth: StatusGatewayAuth;
  gatewayProbeAuthWarning?: string | null;
  gatewaySelf: StatusGatewaySelf;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}

export function buildStatusOverviewSurfaceFromScan(params: {
  scan: Pick<
    StatusScanResult,
    | "cfg"
    | "update"
    | "tailscaleMode"
    | "tailscaleDns"
    | "tailscaleHttpsUrl"
    | "gatewayMode"
    | "remoteUrlMissing"
    | "gatewayConnection"
    | "gatewayReachable"
    | "gatewayProbe"
    | "gatewayProbeAuth"
    | "gatewayProbeAuthWarning"
    | "gatewaySelf"
  >;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface {
  return {
    cfg: params.scan.cfg,
    gatewayConnection: params.scan.gatewayConnection,
    gatewayMode: params.scan.gatewayMode,
    gatewayProbe: params.scan.gatewayProbe,
    gatewayProbeAuth: params.scan.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.scan.gatewayProbeAuthWarning,
    gatewayReachable: params.scan.gatewayReachable,
    gatewaySelf: params.scan.gatewaySelf,
    gatewayService: params.gatewayService,
    nodeOnlyGateway: params.nodeOnlyGateway,
    nodeService: params.nodeService,
    remoteUrlMissing: params.scan.remoteUrlMissing,
    tailscaleDns: params.scan.tailscaleDns,
    tailscaleHttpsUrl: params.scan.tailscaleHttpsUrl,
    tailscaleMode: params.scan.tailscaleMode,
    update: params.scan.update,
  };
}

export function buildStatusOverviewSurfaceFromOverview(params: {
  overview: Pick<
    StatusScanOverviewResult,
    "cfg" | "update" | "tailscaleMode" | "tailscaleDns" | "tailscaleHttpsUrl" | "gatewaySnapshot"
  >;
  gatewayService: StatusServiceSummary;
  nodeService: StatusServiceSummary;
  nodeOnlyGateway?: NodeOnlyGatewayInfo | null;
}): StatusOverviewSurface {
  return {
    cfg: params.overview.cfg,
    gatewayConnection: params.overview.gatewaySnapshot.gatewayConnection,
    gatewayMode: params.overview.gatewaySnapshot.gatewayMode,
    gatewayProbe: params.overview.gatewaySnapshot.gatewayProbe,
    gatewayProbeAuth: params.overview.gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.overview.gatewaySnapshot.gatewayProbeAuthWarning,
    gatewayReachable: params.overview.gatewaySnapshot.gatewayReachable,
    gatewaySelf: params.overview.gatewaySnapshot.gatewaySelf,
    gatewayService: params.gatewayService,
    nodeOnlyGateway: params.nodeOnlyGateway,
    nodeService: params.nodeService,
    remoteUrlMissing: params.overview.gatewaySnapshot.remoteUrlMissing,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    tailscaleMode: params.overview.tailscaleMode,
    update: params.overview.update,
  };
}

export function buildStatusOverviewRowsFromSurface(params: {
  surface: StatusOverviewSurface;
  prefixRows?: StatusOverviewRow[];
  middleRows?: StatusOverviewRow[];
  suffixRows?: StatusOverviewRow[];
  agentsValue: string;
  updateValue?: string;
  gatewayAuthWarningValue?: string | null;
  gatewaySelfFallbackValue?: string | null;
  tailscaleBackendState?: string | null;
  includeBackendStateWhenOff?: boolean;
  includeBackendStateWhenOn?: boolean;
  includeDnsNameWhenOff?: boolean;
  decorateOk?: (value: string) => string;
  decorateWarn?: (value: string) => string;
  decorateTailscaleOff?: (value: string) => string;
  decorateTailscaleWarn?: (value: string) => string;
}) {
  return buildStatusOverviewSurfaceRows({
    agentsValue: params.agentsValue,
    cfg: params.surface.cfg,
    decorateOk: params.decorateOk,
    decorateTailscaleOff: params.decorateTailscaleOff,
    decorateTailscaleWarn: params.decorateTailscaleWarn,
    decorateWarn: params.decorateWarn,
    gatewayAuthWarningValue: params.gatewayAuthWarningValue,
    gatewayConnection: params.surface.gatewayConnection,
    gatewayMode: params.surface.gatewayMode,
    gatewayProbe: params.surface.gatewayProbe,
    gatewayProbeAuth: params.surface.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
    gatewayReachable: params.surface.gatewayReachable,
    gatewaySelf: params.surface.gatewaySelf,
    gatewaySelfFallbackValue: params.gatewaySelfFallbackValue,
    gatewayService: params.surface.gatewayService,
    includeBackendStateWhenOff: params.includeBackendStateWhenOff,
    includeBackendStateWhenOn: params.includeBackendStateWhenOn,
    includeDnsNameWhenOff: params.includeDnsNameWhenOff,
    middleRows: params.middleRows,
    nodeOnlyGateway: params.surface.nodeOnlyGateway,
    nodeService: params.surface.nodeService,
    prefixRows: params.prefixRows,
    remoteUrlMissing: params.surface.remoteUrlMissing,
    suffixRows: params.suffixRows,
    tailscaleBackendState: params.tailscaleBackendState,
    tailscaleDns: params.surface.tailscaleDns,
    tailscaleHttpsUrl: params.surface.tailscaleHttpsUrl,
    tailscaleMode: params.surface.tailscaleMode,
    update: params.surface.update,
    updateValue: params.updateValue,
  });
}

export function buildStatusGatewayJsonPayloadFromSurface(params: {
  surface: Pick<
    StatusOverviewSurface,
    | "gatewayMode"
    | "gatewayConnection"
    | "remoteUrlMissing"
    | "gatewayReachable"
    | "gatewayProbe"
    | "gatewaySelf"
    | "gatewayProbeAuthWarning"
  >;
}) {
  return buildGatewayStatusJsonPayload({
    gatewayConnection: params.surface.gatewayConnection,
    gatewayMode: params.surface.gatewayMode,
    gatewayProbe: params.surface.gatewayProbe,
    gatewayProbeAuthWarning: params.surface.gatewayProbeAuthWarning,
    gatewayReachable: params.surface.gatewayReachable,
    gatewaySelf: params.surface.gatewaySelf,
    remoteUrlMissing: params.surface.remoteUrlMissing,
  });
}
