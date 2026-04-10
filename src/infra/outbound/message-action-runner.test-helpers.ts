import type {
  ChannelDirectoryEntryKind,
  ChannelMessageActionName,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

export const slackConfig = {
  channels: {
    slack: {
      appToken: "xapp-test",
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

export const whatsappConfig = {
  channels: {
    whatsapp: {
      allowFrom: ["*"],
    },
  },
} as OpenClawConfig;

export const directOutbound: ChannelOutboundAdapter = { deliveryMode: "direct" };

export const runDryAction = (params: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runMessageAction({
    abortSignal: params.abortSignal,
    action: params.action,
    cfg: params.cfg,
    dryRun: true,
    params: params.actionParams as never,
    sandboxRoot: params.sandboxRoot,
    toolContext: params.toolContext as never,
  });

export const runDrySend = (params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sandboxRoot?: string;
}) =>
  runDryAction({
    ...params,
    action: "send",
  });

interface ResolvedTestTarget { to: string; kind: ChannelDirectoryEntryKind }

export function normalizeSlackTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  if (/^channel:/i.test(trimmed)) {
    return trimmed.replace(/^channel:/i, "").trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.replace(/^user:/i, "").trim();
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention?.[1]) {
    return mention[1];
  }
  return trimmed;
}

export function createConfiguredTestPlugin(params: {
  id: "slack" | "telegram" | "whatsapp";
  isConfigured: (cfg: OpenClawConfig) => boolean;
  normalizeTarget: (raw: string) => string | undefined;
  resolveTarget: (input: string) => ResolvedTestTarget | null;
}): ChannelPlugin {
  const messaging: ChannelMessagingAdapter = {
    inferTargetChatType: (inferParams) =>
      params.resolveTarget(inferParams.to)?.kind === "user" ? "direct" : "group",
    normalizeTarget: params.normalizeTarget,
    targetResolver: {
      hint: "<id>",
      looksLikeId: (raw) => Boolean(params.resolveTarget(raw.trim())),
      resolveTarget: async (resolverParams) => {
        const resolved = params.resolveTarget(resolverParams.input);
        return resolved ? { ...resolved, source: "normalized" } : null;
      },
    },
  };
  return {
    ...createChannelTestPluginBase({
      config: {
        isConfigured: (_account, cfg) => params.isConfigured(cfg),
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
      },
      id: params.id,
    }),
    messaging,
    outbound: directOutbound,
  };
}

export const slackTestPlugin = createConfiguredTestPlugin({
  id: "slack",
  isConfigured: (cfg) => Boolean(cfg.channels?.slack?.botToken?.trim()),
  normalizeTarget: (raw) => normalizeSlackTarget(raw) || undefined,
  resolveTarget: (input) => {
    const normalized = normalizeSlackTarget(input);
    if (!normalized) {
      return null;
    }
    if (/^[A-Z0-9]+$/i.test(normalized)) {
      const kind = /^U/i.test(normalized) ? "user" : "group";
      return { kind, to: normalized };
    }
    return null;
  },
});

export const telegramTestPlugin = createConfiguredTestPlugin({
  id: "telegram",
  isConfigured: (cfg) => Boolean(cfg.channels?.telegram?.botToken?.trim()),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      kind: normalized.startsWith("@") ? "user" : "group",
      to: normalized.replace(/^telegram:/i, ""),
    };
  },
});

export const whatsappTestPlugin = createConfiguredTestPlugin({
  id: "whatsapp",
  isConfigured: (cfg) => Boolean(cfg.channels?.whatsapp),
  normalizeTarget: (raw) => raw.trim() || undefined,
  resolveTarget: (input) => {
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }
    return {
      kind: normalized.endsWith("@g.us") ? "group" : "user",
      to: normalized,
    };
  },
});
