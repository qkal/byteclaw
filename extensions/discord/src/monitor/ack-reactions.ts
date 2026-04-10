import type { RequestClient } from "@buape/carbon";
import type {
  createStatusReactionController} from "openclaw/plugin-sdk/channel-feedback";
import {
  type StatusReactionAdapter,
  logAckFailure,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createDiscordRuntimeAccountContext } from "../client.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import type { DiscordReactionRuntimeContext } from "../send.types.js";

export function createDiscordAckReactionContext(params: {
  rest: RequestClient;
  cfg: OpenClawConfig;
  accountId: string;
}): DiscordReactionRuntimeContext {
  return {
    rest: params.rest,
    ...createDiscordRuntimeAccountContext({
      accountId: params.accountId,
      cfg: params.cfg,
    }),
  };
}

export function createDiscordAckReactionAdapter(params: {
  channelId: string;
  messageId: string;
  reactionContext: DiscordReactionRuntimeContext;
}): StatusReactionAdapter {
  return {
    removeReaction: async (emoji) => {
      await removeReactionDiscord(
        params.channelId,
        params.messageId,
        emoji,
        params.reactionContext,
      );
    },
    setReaction: async (emoji) => {
      await reactMessageDiscord(params.channelId, params.messageId, emoji, params.reactionContext);
    },
  };
}

export function queueInitialDiscordAckReaction(params: {
  enabled: boolean;
  shouldSendAckReaction: boolean;
  ackReaction: string | undefined;
  statusReactions: ReturnType<typeof createStatusReactionController>;
  reactionAdapter: StatusReactionAdapter;
  target: string;
}) {
  if (params.enabled) {
    void params.statusReactions.setQueued();
    return;
  }
  if (!params.shouldSendAckReaction || !params.ackReaction) {
    return;
  }
  void params.reactionAdapter.setReaction(params.ackReaction).catch((error) => {
    logAckFailure({
      channel: "discord",
      error: error,
      log: logVerbose,
      target: params.target,
    });
  });
}
