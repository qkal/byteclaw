import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { startTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";
import { startMcpLoopbackServer } from "./mcp-http.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

export async function startGatewayEarlyRuntime(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  tailscaleMode: GatewayTailscaleMode;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  nodeRegistry: Parameters<typeof setSkillsRemoteRegistry>[0];
  broadcast: Parameters<typeof startGatewayMaintenanceTimers>[0]["broadcast"];
  nodeSendToAllSubscribed: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["nodeSendToAllSubscribed"];
  getPresenceVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getPresenceVersion"];
  getHealthVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getHealthVersion"];
  refreshGatewayHealthSnapshot: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["refreshGatewayHealthSnapshot"];
  logHealth: Parameters<typeof startGatewayMaintenanceTimers>[0]["logHealth"];
  dedupe: Parameters<typeof startGatewayMaintenanceTimers>[0]["dedupe"];
  chatAbortControllers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatAbortControllers"];
  chatRunState: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatRunState"];
  chatRunBuffers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatRunBuffers"];
  chatDeltaSentAt: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatDeltaSentAt"];
  chatDeltaLastBroadcastLen: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["chatDeltaLastBroadcastLen"];
  removeChatRun: Parameters<typeof startGatewayMaintenanceTimers>[0]["removeChatRun"];
  agentRunSeq: Parameters<typeof startGatewayMaintenanceTimers>[0]["agentRunSeq"];
  nodeSendToSession: Parameters<typeof startGatewayMaintenanceTimers>[0]["nodeSendToSession"];
  mediaCleanupTtlMs?: number;
  skillsRefreshDelayMs: number;
  getSkillsRefreshTimer: () => ReturnType<typeof setTimeout> | null;
  setSkillsRefreshTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  loadConfig: () => OpenClawConfig;
}) {
  let mcpServer: { port: number; close: () => Promise<void> } | undefined;
  try {
    mcpServer = await startMcpLoopbackServer(0);
    params.log.info(`MCP loopback server listening on http://127.0.0.1:${mcpServer.port}/mcp`);
  } catch (error) {
    params.log.warn(`MCP loopback server failed to start: ${String(error)}`);
  }

  let bonjourStop: (() => Promise<void>) | null = null;
  if (!params.minimalTestGateway) {
    const machineDisplayName = await getMachineDisplayName();
    const discovery = await startGatewayDiscovery({
      gatewayTls: params.gatewayTls.enabled
        ? { enabled: true, fingerprintSha256: params.gatewayTls.fingerprintSha256 }
        : undefined,
      logDiscovery: params.logDiscovery,
      machineDisplayName,
      mdnsMode: params.cfgAtStart.discovery?.mdns?.mode,
      port: params.port,
      tailscaleMode: params.tailscaleMode,
      wideAreaDiscoveryDomain: params.cfgAtStart.discovery?.wideArea?.domain,
      wideAreaDiscoveryEnabled: params.cfgAtStart.discovery?.wideArea?.enabled === true,
    });
    ({ bonjourStop } = discovery);
  }

  if (!params.minimalTestGateway) {
    setSkillsRemoteRegistry(params.nodeRegistry);
    void primeRemoteSkillsCache();
    startTaskRegistryMaintenance();
  }

  const skillsChangeUnsub = params.minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
        if (event.reason === "remote-node") {
          return;
        }
        const existingTimer = params.getSkillsRefreshTimer();
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const nextTimer = setTimeout(() => {
          params.setSkillsRefreshTimer(null);
          void refreshRemoteBinsForConnectedNodes(params.loadConfig());
        }, params.skillsRefreshDelayMs);
        params.setSkillsRefreshTimer(nextTimer);
      });

  const maintenance = params.minimalTestGateway
    ? null
    : startGatewayMaintenanceTimers({
        agentRunSeq: params.agentRunSeq,
        broadcast: params.broadcast,
        chatAbortControllers: params.chatAbortControllers,
        chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
        chatDeltaSentAt: params.chatDeltaSentAt,
        chatRunBuffers: params.chatRunBuffers,
        chatRunState: params.chatRunState,
        dedupe: params.dedupe,
        getHealthVersion: params.getHealthVersion,
        getPresenceVersion: params.getPresenceVersion,
        logHealth: params.logHealth,
        nodeSendToAllSubscribed: params.nodeSendToAllSubscribed,
        nodeSendToSession: params.nodeSendToSession,
        refreshGatewayHealthSnapshot: params.refreshGatewayHealthSnapshot,
        removeChatRun: params.removeChatRun,
        ...(typeof params.mediaCleanupTtlMs === "number"
          ? { mediaCleanupTtlMs: params.mediaCleanupTtlMs }
          : {}),
      });

  return {
    bonjourStop,
    maintenance,
    mcpServer,
    skillsChangeUnsub,
  };
}
