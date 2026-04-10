import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import {
  type StatusOverviewSurface,
  buildStatusGatewayJsonPayloadFromSurface,
} from "./status-overview-surface.ts";

export { resolveStatusUpdateChannelInfo } from "./status-all/format.js";

export function buildStatusJsonPayload(params: {
  summary: Record<string, unknown>;
  surface: StatusOverviewSurface;
  osSummary: unknown;
  memory: unknown;
  memoryPlugin: unknown;
  agents: unknown;
  secretDiagnostics: string[];
  securityAudit?: unknown;
  health?: unknown;
  usage?: unknown;
  lastHeartbeat?: unknown;
  pluginCompatibility?: Record<string, unknown>[] | null | undefined;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    update: params.surface.update,
    updateConfigChannel: params.surface.cfg.update?.channel ?? undefined,
  });
  return {
    ...params.summary,
    agents: params.agents,
    gateway: buildStatusGatewayJsonPayloadFromSurface({ surface: params.surface }),
    gatewayService: params.surface.gatewayService,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    nodeService: params.surface.nodeService,
    os: params.osSummary,
    secretDiagnostics: params.secretDiagnostics,
    update: params.surface.update,
    updateChannel: channelInfo.channel,
    updateChannelSource: channelInfo.source,
    ...(params.securityAudit ? { securityAudit: params.securityAudit } : {}),
    ...(params.pluginCompatibility
      ? {
          pluginCompatibility: {
            count: params.pluginCompatibility.length,
            warnings: params.pluginCompatibility,
          },
        }
      : {}),
    ...(params.health || params.usage || params.lastHeartbeat
      ? {
          health: params.health,
          lastHeartbeat: params.lastHeartbeat,
          usage: params.usage,
        }
      : {}),
  };
}
