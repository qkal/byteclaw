import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
} from "./accounts.js";
import { buildQaTarget, normalizeQaTarget, parseQaTarget } from "./bus-client.js";
import { qaChannelMessageActions } from "./channel-actions.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import { startQaGatewayAccount } from "./gateway.js";
import { sendQaChannelText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup } from "./setup.js";
import { qaChannelStatus } from "./status.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

const CHANNEL_ID = "qa-channel" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

export const qaChannelPlugin: ChannelPlugin<ResolvedQaChannelAccount> = createChatChannelPlugin({
  base: {
    actions: qaChannelMessageActions,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      defaultAccountId: (cfg) => resolveDefaultQaChannelAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      listAccountIds: (cfg) => listQaChannelAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveQaChannelAccount({ accountId, cfg: cfg as CoreConfig }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ accountId, cfg: cfg as CoreConfig }).config.allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ accountId, cfg: cfg as CoreConfig }).config.defaultTo,
    },
    configSchema: qaChannelPluginConfigSchema,
    gateway: {
      startAccount: async (ctx) => {
        await startQaGatewayAccount(CHANNEL_ID, meta.label, ctx);
      },
    },
    id: CHANNEL_ID,
    messaging: {
      inferTargetChatType: ({ to }) => parseQaTarget(to).chatType,
      normalizeTarget: normalizeQaTarget,
      parseExplicitTarget: ({ raw }) => {
        const parsed = parseQaTarget(raw);
        return {
          chatType: parsed.chatType,
          threadId: parsed.threadId,
          to: buildQaTarget(parsed),
        };
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, threadId }) => {
        const parsed = parseQaTarget(target);
        return buildChannelOutboundSessionRoute({
          accountId,
          agentId,
          cfg,
          channel: CHANNEL_ID,
          chatType: parsed.chatType,
          from: `qa-channel:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          peer: {
            id: buildQaTarget(parsed),
            kind: parsed.chatType === "direct" ? "direct" : "channel",
          },
          threadId: threadId ?? parsed.threadId,
          to: buildQaTarget(parsed),
        });
      },
      targetResolver: {
        hint: "<dm:user|channel:room|thread:room/thread>",
        looksLikeId: (raw) =>
          /^((dm|channel):|thread:[^/]+\/)/i.test(raw.trim()) || raw.trim().length > 0,
      },
    },
    meta,
    reload: { configPrefixes: ["channels.qa-channel"] },
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applyQaSetup({
          accountId,
          cfg,
          input: input as Record<string, unknown>,
        }),
    },
    status: qaChannelStatus,
  },
  outbound: {
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, threadId, replyToId }) =>
        await sendQaChannelText({
          accountId,
          cfg: cfg as CoreConfig,
          replyToId,
          text,
          threadId,
          to,
        }),
    },
    base: {
      deliveryMode: "direct",
    },
  },
});
