import type { ReactionTypeEmoji } from "@grammyjs/types";
import {
  type StatusReactionController,
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import type { TelegramDirectConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-runtime";
import { deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import { DEFAULT_ACCOUNT_ID, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { firstDefined, normalizeAllowFrom, normalizeDmAllowFromWithStore } from "./bot-access.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import { buildTelegramInboundContextPayload } from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import {
  buildTypingThreadParams,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import {
  type TelegramReactionEmoji,
  buildTelegramStatusReactionVariants,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";

export type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
} from "./bot-message-context.types.js";

type TelegramMessageContextRuntime = typeof import("./bot-message-context.runtime.js");

let telegramMessageContextRuntimePromise: Promise<TelegramMessageContextRuntime> | undefined;

async function loadTelegramMessageContextRuntime() {
  telegramMessageContextRuntimePromise ??= import("./bot-message-context.runtime.js");
  return await telegramMessageContextRuntimePromise;
}

type TelegramMessageContextPayload = Awaited<ReturnType<typeof buildTelegramInboundContextPayload>>;
type TelegramReactionApi = (
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"],
  messageId: number,
  reactions: { type: "emoji"; emoji: ReactionTypeEmoji["emoji"] }[],
) => Promise<unknown>;

export interface TelegramMessageContext {
  ctxPayload: TelegramMessageContextPayload["ctxPayload"];
  primaryCtx: BuildTelegramMessageContextParams["primaryCtx"];
  msg: BuildTelegramMessageContextParams["primaryCtx"]["message"];
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"];
  isGroup: boolean;
  groupConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["groupConfig"];
  topicConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["topicConfig"];
  resolvedThreadId?: number;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  replyThreadId?: number;
  isForum: boolean;
  historyKey?: string;
  historyLimit: BuildTelegramMessageContextParams["historyLimit"];
  groupHistories: BuildTelegramMessageContextParams["groupHistories"];
  route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
  skillFilter: TelegramMessageContextPayload["skillFilter"];
  sendTyping: () => Promise<void>;
  sendRecordVoice: () => Promise<void>;
  ackReactionPromise: Promise<boolean> | null;
  reactionApi: TelegramReactionApi | null;
  removeAckAfterReply: boolean;
  statusReactionController: StatusReactionController | null;
  accountId: string;
}

export const buildTelegramMessageContext = async ({
  primaryCtx,
  allMedia,
  replyMedia = [],
  storeAllowFrom,
  options,
  bot,
  cfg,
  account,
  historyLimit,
  groupHistories,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
  loadFreshConfig,
  upsertPairingRequest,
  sendChatActionHandler,
}: BuildTelegramMessageContextParams): Promise<TelegramMessageContext | null> => {
  const msg = primaryCtx.message;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const messageThreadId = (msg as { message_thread_id?: number }).message_thread_id;
  const reactionApi =
    typeof bot.api.setMessageReaction === "function"
      ? bot.api.setMessageReaction.bind(bot.api)
      : null;
  const getChatApi =
    typeof bot.api.getChat === "function"
      ? (bot.api.getChat.bind(bot.api) as TelegramGetChat)
      : undefined;
  const isForum = await resolveTelegramForumFlag({
    chatId,
    chatType: msg.chat.type,
    getChat: getChatApi,
    isForum: extractTelegramForumFlag(msg.chat),
    isGroup,
  });
  const threadSpec = resolveTelegramThreadSpec({
    isForum,
    isGroup,
    messageThreadId,
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
  const replyThreadId = threadSpec.id;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig);
  // Use direct config dmPolicy override if available for DMs
  const effectiveDmPolicy =
    !isGroup && groupConfig && "dmPolicy" in groupConfig
      ? (groupConfig.dmPolicy ?? dmPolicy)
      : dmPolicy;
  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const freshCfg = loadFreshConfig?.() ?? (await loadTelegramMessageContextRuntime()).loadConfig();
  let { route, configuredBinding, configuredBindingSessionKey } = resolveTelegramConversationRoute({
    accountId: account.accountId,
    cfg: freshCfg,
    chatId,
    isGroup,
    replyThreadId,
    resolvedThreadId,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const requiresExplicitAccountBinding = (
    candidate: ReturnType<typeof resolveTelegramConversationRoute>["route"],
  ): boolean => candidate.accountId !== DEFAULT_ACCOUNT_ID && candidate.matchedBy === "default";
  const isNamedAccountFallback = requiresExplicitAccountBinding(route);
  // Named-account groups still require an explicit binding; DMs get a
  // Per-account fallback session key below to preserve isolation.
  if (isNamedAccountFallback && isGroup) {
    logInboundDrop({
      channel: "telegram",
      log: logVerbose,
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  // Calculate groupAllowOverride first - it's needed for both DM and group allowlist checks
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  // For DMs, prefer per-DM/topic allowFrom (groupAllowOverride) over account-level allowFrom
  const dmAllowFrom = groupAllowOverride ?? allowFrom;
  const effectiveDmAllow = normalizeDmAllowFromWithStore({
    allowFrom: dmAllowFrom,
    dmPolicy: effectiveDmPolicy,
    storeAllowFrom,
  });
  // Group sender checks are explicit and must not inherit DM pairing-store entries.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  const senderUsername = msg.from?.username ?? "";
  const baseAccess = evaluateTelegramGroupBaseAccess({
    effectiveGroupAllow,
    enforceAllowOverride: true,
    groupConfig,
    hasGroupAllowOverride,
    isGroup,
    requireSenderForAllowOverride: false,
    senderId,
    senderUsername,
    topicConfig,
  });
  if (!baseAccess.allowed) {
    if (baseAccess.reason === "group-disabled") {
      logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
      return null;
    }
    if (baseAccess.reason === "topic-disabled") {
      logVerbose(
        `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
      );
      return null;
    }
    logVerbose(
      isGroup
        ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
        : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`,
    );
    return null;
  }

  const requireTopic = (groupConfig as TelegramDirectConfig | undefined)?.requireTopic;
  const topicRequiredButMissing = !isGroup && requireTopic === true && dmThreadId == null;
  if (topicRequiredButMissing) {
    logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }

  const sendTyping = async () => {
    await withTelegramApiErrorLogging({
      fn: () =>
        sendChatActionHandler.sendChatAction(
          chatId,
          "typing",
          buildTypingThreadParams(replyThreadId),
        ),
      operation: "sendChatAction",
    });
  };

  const sendRecordVoice = async () => {
    try {
      await withTelegramApiErrorLogging({
        fn: () =>
          sendChatActionHandler.sendChatAction(
            chatId,
            "record_voice",
            buildTypingThreadParams(replyThreadId),
          ),
        operation: "sendChatAction",
      });
    } catch (error) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(error)}`);
    }
  };

  if (
    !(await enforceTelegramDmAccess({
      accountId: account.accountId,
      bot,
      chatId,
      dmPolicy: effectiveDmPolicy,
      effectiveDmAllow,
      isGroup,
      logger,
      msg,
      upsertPairingRequest,
    }))
  ) {
    return null;
  }
  const ensureConfiguredBindingReady = async (): Promise<boolean> => {
    if (!configuredBinding) {
      return true;
    }
    const { ensureConfiguredBindingRouteReady } = await loadTelegramMessageContextRuntime();
    const ensured = await ensureConfiguredBindingRouteReady({
      bindingResolution: configuredBinding,
      cfg: freshCfg,
    });
    if (ensured.ok) {
      logVerbose(
        `telegram: using configured ACP binding for ${configuredBinding.record.conversation.conversationId} -> ${configuredBindingSessionKey}`,
      );
      return true;
    }
    logVerbose(
      `telegram: configured ACP binding unavailable for ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
    );
    logInboundDrop({
      channel: "telegram",
      log: logVerbose,
      reason: "configured ACP binding unavailable",
      target: configuredBinding.record.conversation.conversationId,
    });
    return false;
  };

  const baseSessionKey = resolveTelegramConversationBaseSessionKey({
    cfg: freshCfg,
    chatId,
    isGroup,
    route,
    senderId,
  });
  // DMs: use thread suffix for session isolation (works regardless of dmScope)
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${chatId}:${dmThreadId}` })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  route = {
    ...route,
    lastRoutePolicy: deriveLastRoutePolicy({
      mainSessionKey: route.mainSessionKey,
      sessionKey,
    }),
    sessionKey,
  };
  // Compute requireMention after access checks and final route selection.
  const activationOverride = resolveGroupActivation({
    agentId: route.agentId,
    chatId,
    messageThreadId: resolvedThreadId,
    sessionKey,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId);
  const requireMention = firstDefined(
    activationOverride,
    topicConfig?.requireMention,
    (groupConfig as TelegramGroupConfig | undefined)?.requireMention,
    baseRequireMention,
  );

  (await loadTelegramMessageContextRuntime()).recordChannelActivity({
    accountId: account.accountId,
    channel: "telegram",
    direction: "inbound",
  });

  const bodyResult = await resolveTelegramInboundBody({
    accountId: account.accountId,
    allMedia,
    cfg,
    chatId,
    effectiveDmAllow,
    effectiveGroupAllow,
    groupConfig,
    groupHistories,
    historyLimit,
    isGroup,
    logger,
    msg,
    options,
    primaryCtx,
    requireMention,
    resolvedThreadId,
    routeAgentId: route.agentId,
    senderId,
    senderUsername,
    sessionKey,
    topicConfig,
  });
  if (!bodyResult) {
    return null;
  }

  if (!(await ensureConfiguredBindingReady())) {
    return null;
  }

  // ACK reactions
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    accountId: account.accountId,
    channel: "telegram",
  });
  const ackReactionEmoji =
    ackReaction && isTelegramSupportedReactionEmoji(ackReaction) ? ackReaction : undefined;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        canDetectMention: bodyResult.canDetectMention,
        effectiveWasMentioned: bodyResult.effectiveWasMentioned,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention: Boolean(requireMention),
        scope: ackReactionScope,
        shouldBypassMention: bodyResult.shouldBypassMention,
      }),
    );
  // Status Reactions controller (lifecycle reactions)
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction();
  const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
    initialEmoji: ackReaction,
    overrides: statusReactionsConfig?.emojis,
  });
  const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(
    resolvedStatusReactionEmojis,
  );
  let allowedStatusReactionEmojisPromise: Promise<Set<TelegramReactionEmoji> | null> | null = null;
  const statusReactionController: StatusReactionController | null =
    statusReactionsEnabled && msg.message_id
      ? (await loadTelegramMessageContextRuntime()).createStatusReactionController({
          adapter: {
            setReaction: async (emoji: string) => {
              if (reactionApi) {
                if (!allowedStatusReactionEmojisPromise) {
                  allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
                    chat: msg.chat,
                    chatId,
                    getChat: getChatApi ?? undefined,
                  }).catch((error) => {
                    logVerbose(
                      `telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(error)}`,
                    );
                    return null;
                  });
                }
                const allowedStatusReactionEmojis = await allowedStatusReactionEmojisPromise;
                const resolvedEmoji = resolveTelegramReactionVariant({
                  allowedEmojiReactions: allowedStatusReactionEmojis,
                  requestedEmoji: emoji,
                  variantsByRequestedEmoji: statusReactionVariantsByEmoji,
                });
                if (!resolvedEmoji) {
                  return;
                }
                await reactionApi(chatId, msg.message_id, [
                  { emoji: resolvedEmoji, type: "emoji" },
                ]);
              }
            },
            // Telegram replaces atomically — no removeReaction needed
          },
          emojis: resolvedStatusReactionEmojis,
          enabled: true,
          initialEmoji: ackReaction,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
          timing: statusReactionsConfig?.timing,
        })
      : null;

  // When status reactions are enabled, setQueued() replaces the simple ack reaction
  const ackReactionPromise: Promise<boolean> | null = statusReactionController
    ? (shouldAckReaction()
      ? Promise.resolve(statusReactionController.setQueued()).then(
          () => true,
          () => false,
        )
      : null)
    : (shouldAckReaction() && msg.message_id && reactionApi && ackReactionEmoji
      ? withTelegramApiErrorLogging({
          fn: () =>
            reactionApi(chatId, msg.message_id, [{ type: "emoji", emoji: ackReactionEmoji }]),
          operation: "setMessageReaction",
        }).then(
          () => true,
          (error) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(error)}`);
            return false;
          },
        )
      : null);

  const { ctxPayload, skillFilter } = await buildTelegramInboundContextPayload({
    allMedia,
    bodyText: bodyResult.bodyText,
    cfg,
    chatId,
    commandAuthorized: bodyResult.commandAuthorized,
    dmAllowFrom,
    dmThreadId,
    effectiveGroupAllow,
    effectiveWasMentioned: bodyResult.effectiveWasMentioned,
    groupConfig,
    groupHistories,
    historyKey: bodyResult.historyKey ?? "",
    historyLimit,
    isForum,
    isGroup,
    locationData: bodyResult.locationData,
    msg,
    options,
    primaryCtx,
    rawBody: bodyResult.rawBody,
    replyMedia,
    resolvedThreadId,
    route,
    senderId,
    senderUsername,
    stickerCacheHit: bodyResult.stickerCacheHit,
    threadSpec,
    topicConfig,
  });

  return {
    accountId: account.accountId,
    ackReactionPromise,
    chatId,
    ctxPayload,
    groupConfig,
    groupHistories,
    historyKey: bodyResult.historyKey ?? "",
    historyLimit,
    isForum,
    isGroup,
    msg,
    primaryCtx,
    reactionApi,
    removeAckAfterReply,
    replyThreadId,
    resolvedThreadId,
    route,
    sendRecordVoice,
    sendTyping,
    skillFilter,
    statusReactionController,
    threadSpec,
    topicConfig,
  };
};
