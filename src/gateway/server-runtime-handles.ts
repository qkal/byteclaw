import type { OpenClawConfig } from "../config/config.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { ChannelHealthMonitor } from "./channel-health-monitor.js";

export interface GatewayConfigReloaderHandle {
  stop: () => Promise<void>;
}

export interface GatewayServerMutableState {
  bonjourStop: (() => Promise<void>) | null;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  heartbeatRunner: HeartbeatRunner;
  stopGatewayUpdateCheck: () => void;
  tailscaleCleanup: (() => Promise<void>) | null;
  skillsRefreshTimer: ReturnType<typeof setTimeout> | null;
  skillsRefreshDelayMs: number;
  skillsChangeUnsub: () => void;
  channelHealthMonitor: ChannelHealthMonitor | null;
  stopModelPricingRefresh: () => void;
  mcpServer: { port: number; close: () => Promise<void> } | undefined;
  configReloader: GatewayConfigReloaderHandle;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
}

export function createGatewayServerMutableState(): GatewayServerMutableState {
  const noopInterval = () => {
    const timer = setInterval(() => {}, 1 << 30);
    timer.unref?.();
    return timer;
  };
  return {
    agentUnsub: null as (() => void) | null,
    bonjourStop: null as (() => Promise<void>) | null,
    channelHealthMonitor: null as ChannelHealthMonitor | null,
    configReloader: { stop: async () => {} } satisfies GatewayConfigReloaderHandle,
    dedupeCleanup: noopInterval(),
    healthInterval: noopInterval(),
    heartbeatRunner: {
      stop: () => {},
      updateConfig: (_cfg: OpenClawConfig) => {},
    } satisfies HeartbeatRunner,
    heartbeatUnsub: null as (() => void) | null,
    lifecycleUnsub: null as (() => void) | null,
    mcpServer: undefined as { port: number; close: () => Promise<void> } | undefined,
    mediaCleanup: null as ReturnType<typeof setInterval> | null,
    skillsChangeUnsub: () => {},
    skillsRefreshDelayMs: 30_000,
    skillsRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    stopGatewayUpdateCheck: () => {},
    stopModelPricingRefresh: () => {},
    tailscaleCleanup: null as (() => Promise<void>) | null,
    tickInterval: noopInterval(),
    transcriptUnsub: null as (() => void) | null,
  };
}
