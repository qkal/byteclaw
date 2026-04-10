import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { vi } from "vitest";
import type { createDiscordMessageHandler } from "./message-handler.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export const DEFAULT_DISCORD_BOT_USER_ID = "bot-123";

export function createDiscordHandlerParams(overrides?: {
  botUserId?: string;
  setStatus?: (patch: Record<string, unknown>) => void;
  abortSignal?: AbortSignal;
  workerRunTimeoutMs?: number;
}): Parameters<typeof createDiscordMessageHandler>[0] {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        groupPolicy: "allowlist",
        token: "test-token",
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
      },
    },
  };
  return {
    abortSignal: overrides?.abortSignal,
    accountId: "default",
    botUserId: overrides?.botUserId ?? DEFAULT_DISCORD_BOT_USER_ID,
    cfg,
    discordConfig: cfg.channels?.discord,
    dmEnabled: true,
    groupDmEnabled: false,
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    replyToMode: "off" as const,
    runtime: {
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
      log: vi.fn(),
    },
    setStatus: overrides?.setStatus,
    textLimit: 2000,
    threadBindings: createNoopThreadBindingManager("default"),
    token: "test-token",
    workerRunTimeoutMs: overrides?.workerRunTimeoutMs,
  };
}

export function createDiscordPreflightContext(channelId = "ch-1") {
  return {
    baseSessionKey: `agent:main:discord:channel:${channelId}`,
    data: {
      channel_id: channelId,
      message: {
        attachments: [],
        channel_id: channelId,
        id: `msg-${channelId}`,
      },
    },
    message: {
      attachments: [],
      channel_id: channelId,
      id: `msg-${channelId}`,
    },
    messageChannelId: channelId,
    route: {
      sessionKey: `agent:main:discord:channel:${channelId}`,
    },
  };
}
