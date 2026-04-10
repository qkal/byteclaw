import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildDmGroupAccountAllowlistAdapter,
  createNestedAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { clearAccountEntryFields, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderRouteAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  PAIRING_APPROVED_MESSAGE,
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  type OutboundSendDeps,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  type RoutePeer,
  buildOutboundBaseSessionKey,
  normalizeOutboundThreadId,
  resolveThreadSessionKeys,
} from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { type ResolvedTelegramAccount, resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAutoThreadId } from "./action-threading.js";
import { lookupTelegramChatId } from "./api-fetch.js";
import { telegramApprovalCapability } from "./approval-native.js";
import * as auditModule from "./audit.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";
import { telegramMessageActions as telegramMessageActionsImpl } from "./channel-actions.js";
import {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./directory-config.js";
import { buildTelegramExecApprovalPendingPayload } from "./exec-approval-forwarding.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./group-policy.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import * as monitorModule from "./monitor.js";
import { looksLikeTelegramTargetId, normalizeTelegramMessagingTarget } from "./normalize.js";
import { sendTelegramPayloadMessages } from "./outbound-adapter.js";
import { telegramOutboundBaseAdapter } from "./outbound-base.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import type { TelegramProbe } from "./probe.js";
import * as probeModule from "./probe.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import { getTelegramRuntime } from "./runtime.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";
import { resolveTelegramSessionConversation } from "./session-conversation.js";
import { telegramSetupAdapter } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import {
  createTelegramPluginBase,
  findTelegramTokenOwnerAccountId,
  formatDuplicateTelegramTokenReason,
  telegramConfigAdapter,
} from "./shared.js";
import { detectTelegramLegacyStateMigrations } from "./state-migrations.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import { parseTelegramTarget } from "./targets.js";
import {
  createTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";
import { resolveTelegramToken } from "./token.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

type TelegramSendOptions = NonNullable<Parameters<TelegramSendFn>[2]>;

function resolveTelegramProbe() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.probeTelegram ?? probeModule.probeTelegram
  );
}

function resolveTelegramAuditCollector() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.collectTelegramUnmentionedGroupIds ??
    auditModule.collectTelegramUnmentionedGroupIds
  );
}

function resolveTelegramAuditMembership() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.auditTelegramGroupMembership ??
    auditModule.auditTelegramGroupMembership
  );
}

function resolveTelegramMonitor() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.monitorTelegramProvider ??
    monitorModule.monitorTelegramProvider
  );
}

function getOptionalTelegramRuntime() {
  try {
    return getTelegramRuntime();
  } catch {
    return null;
  }
}

async function resolveTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    getOptionalTelegramRuntime()?.channel?.telegram?.sendMessageTelegram ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function resolveTelegramTokenHelper() {
  return (
    getOptionalTelegramRuntime()?.channel?.telegram?.resolveTelegramToken ?? resolveTelegramToken
  );
}

function buildTelegramSendOptions(params: {
  cfg: OpenClawConfig;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
  forceDocument?: boolean | null;
  gatewayClientScopes?: readonly string[] | null;
}): TelegramSendOptions {
  return {
    verbose: false,
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    messageThreadId: parseTelegramThreadId(params.threadId),
    replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
    accountId: params.accountId ?? undefined,
    silent: params.silent ?? undefined,
    forceDocument: params.forceDocument ?? undefined,
    ...(Array.isArray(params.gatewayClientScopes)
      ? { gatewayClientScopes: [...params.gatewayClientScopes] }
      : {}),
  };
}

async function sendTelegramOutbound(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string | null;
  mediaLocalRoots?: readonly string[] | null;
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean | null;
  gatewayClientScopes?: readonly string[] | null;
}) {
  const send = await resolveTelegramSend(params.deps);
  return await send(
    params.to,
    params.text,
    buildTelegramSendOptions({
      accountId: params.accountId,
      cfg: params.cfg,
      gatewayClientScopes: params.gatewayClientScopes,
      mediaLocalRoots: params.mediaLocalRoots,
      mediaUrl: params.mediaUrl,
      replyToId: params.replyToId,
      silent: params.silent,
      threadId: params.threadId,
    }),
  );
}

const telegramMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: (ctx) =>
    getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.describeMessageTool?.(ctx) ??
    telegramMessageActionsImpl.describeMessageTool?.(ctx) ??
    null,
  extractToolSend: (ctx) =>
    getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.extractToolSend?.(ctx) ??
    telegramMessageActionsImpl.extractToolSend?.(ctx) ??
    null,
  handleAction: async (ctx) => {
    const runtimeHandleAction =
      getOptionalTelegramRuntime()?.channel?.telegram?.messageActions?.handleAction;
    if (runtimeHandleAction) {
      return await runtimeHandleAction(ctx);
    }
    if (!telegramMessageActionsImpl.handleAction) {
      throw new Error("Telegram message actions not available");
    }
    return await telegramMessageActionsImpl.handleAction(ctx);
  },
};

function normalizeTelegramAcpConversationId(conversationId: string) {
  const parsed = parseTelegramTopicConversation({ conversationId });
  if (!parsed || !parsed.chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: parsed.chatId,
  };
}

function matchTelegramAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeTelegramAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!incoming || !incoming.chatId.startsWith("-")) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    matchPriority: 2,
    parentConversationId: incoming.chatId,
  };
}

function shouldTreatTelegramDeliveredTextAsVisible(params: {
  kind: "tool" | "block" | "final";
  text?: string;
}): boolean {
  void params.text;
  return params.kind !== "final";
}

function targetsMatchTelegramReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const origin = parseTelegramTarget(params.originTarget);
  const target = parseTelegramTarget(params.targetKey);
  const originThreadId =
    origin.messageThreadId != null && normalizeOptionalString(String(origin.messageThreadId))
      ? normalizeOptionalString(String(origin.messageThreadId))
      : undefined;
  const targetThreadId =
    normalizeOptionalString(params.targetThreadId) ||
    (target.messageThreadId != null && normalizeOptionalString(String(target.messageThreadId))
      ? normalizeOptionalString(String(target.messageThreadId))
      : undefined);
  if (
    normalizeOptionalLowercaseString(origin.chatId) !==
    normalizeOptionalLowercaseString(target.chatId)
  ) {
    return false;
  }
  if (originThreadId && targetThreadId) {
    return originThreadId === targetThreadId;
  }
  return originThreadId == null && targetThreadId == null;
}

function resolveTelegramCommandConversation(params: {
  threadId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const chatId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = normalizeOptionalString(candidate) ?? "";
      return trimmed ? (normalizeOptionalString(parseTelegramTarget(trimmed).chatId) ?? "") : "";
    })
    .find((candidate) => candidate.length > 0);
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

function resolveTelegramInboundConversation(params: {
  to?: string;
  conversationId?: string;
  threadId?: string | number;
}) {
  const rawTarget =
    normalizeOptionalString(params.to) ?? normalizeOptionalString(params.conversationId) ?? "";
  if (!rawTarget) {
    return null;
  }
  const parsedTarget = parseTelegramTarget(rawTarget);
  const chatId = normalizeOptionalString(parsedTarget.chatId) ?? "";
  if (!chatId) {
    return null;
  }
  const threadId =
    parsedTarget.messageThreadId != null
      ? String(parsedTarget.messageThreadId)
      : (params.threadId != null
        ? normalizeOptionalString(String(params.threadId))
        : undefined);
  if (threadId) {
    const parsedTopic = parseTelegramTopicConversation({
      conversationId: threadId,
      parentConversationId: chatId,
    });
    if (!parsedTopic) {
      return null;
    }
    return {
      conversationId: parsedTopic.canonicalConversationId,
      parentConversationId: parsedTopic.chatId,
    };
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

function resolveTelegramDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}) {
  const parsedTopic = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (parsedTopic) {
    return {
      threadId: parsedTopic.topicId,
      to: parsedTopic.chatId,
    };
  }
  const parsedTarget = parseTelegramTarget(
    params.parentConversationId?.trim() || params.conversationId,
  );
  if (!parsedTarget.chatId.trim()) {
    return null;
  }
  return {
    to: parsedTarget.chatId,
    ...(parsedTarget.messageThreadId != null
      ? { threadId: String(parsedTarget.messageThreadId) }
      : {}),
  };
}

function parseTelegramExplicitTarget(raw: string) {
  const target = parseTelegramTarget(raw);
  return {
    chatType: target.chatType === "unknown" ? undefined : target.chatType,
    threadId: target.messageThreadId,
    to: target.chatId,
  };
}

function shouldStripTelegramThreadFromAnnounceOrigin(params: {
  requester: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
  entry: {
    channel?: string;
    to?: string;
    threadId?: string | number;
  };
}): boolean {
  const requesterChannel = normalizeOptionalLowercaseString(params.requester.channel);
  if (requesterChannel && requesterChannel !== "telegram") {
    return true;
  }
  const requesterTo = params.requester.to?.trim();
  if (!requesterTo) {
    return false;
  }
  if (!requesterChannel && !requesterTo.startsWith("telegram:")) {
    return true;
  }
  const requesterTarget = parseTelegramExplicitTarget(requesterTo);
  if (requesterTarget.chatType !== "group") {
    return true;
  }
  const entryTo = params.entry.to?.trim();
  if (!entryTo) {
    return false;
  }
  const entryTarget = parseTelegramExplicitTarget(entryTo);
  return entryTarget.to !== requesterTarget.to;
}

function buildTelegramBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "telegram" });
}

function resolveTelegramOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { kind: string };
  threadId?: string | number | null;
}) {
  const parsed = parseTelegramTarget(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const fallbackThreadId = normalizeOutboundThreadId(params.threadId);
  const resolvedThreadId = parsed.messageThreadId ?? parseTelegramThreadId(fallbackThreadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : chatId;
  const peer: RoutePeer = {
    id: peerId,
    kind: isGroup ? "group" : "direct",
  };
  const baseSessionKey = buildTelegramBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    peer,
  });
  const threadKeys =
    resolvedThreadId && !isGroup
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(resolvedThreadId) })
      : null;
  return {
    baseSessionKey,
    chatType: isGroup ? ("group" as const) : ("direct" as const),
    from: isGroup
      ? `telegram:group:${peerId}`
      : (resolvedThreadId
        ? `telegram:${chatId}:topic:${resolvedThreadId}`
        : `telegram:${chatId}`),
    peer,
    sessionKey: threadKeys?.sessionKey ?? baseSessionKey,
    threadId: resolvedThreadId,
    to: `telegram:${chatId}`,
  };
}

async function resolveTelegramTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
}) {
  if (params.kind !== "user") {
    return params.inputs.map((input) => ({
      input,
      note: "Telegram runtime target resolution only supports usernames for direct-message lookups.",
      resolved: false as const,
    }));
  }
  const account = resolveTelegramAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  const token = account.token.trim();
  if (!token) {
    return params.inputs.map((input) => ({
      input,
      note: "Telegram bot token is required to resolve @username targets.",
      resolved: false as const,
    }));
  }
  return await Promise.all(
    params.inputs.map(async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return {
          input,
          note: "Telegram target is required.",
          resolved: false as const,
        };
      }
      const normalized = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      try {
        const id = await lookupTelegramChatId({
          chatId: normalized,
          network: account.config.network,
          token,
        });
        if (!id) {
          return {
            input,
            note: "Telegram username could not be resolved by the configured bot.",
            resolved: false as const,
          };
        }
        return {
          id,
          input,
          name: normalized,
          resolved: true as const,
        };
      } catch (error) {
        return {
          input,
          note: formatErrorMessage(error),
          resolved: false as const,
        };
      }
    }),
  );
}

const resolveTelegramAllowlistGroupOverrides = createNestedAllowlistOverrideResolver({
  innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
  outerLabel: (groupId) => groupId,
  resolveChildren: (groupCfg) => groupCfg?.topics,
  resolveInnerEntries: (topicCfg) => topicCfg?.allowFrom,
  resolveOuterEntries: (groupCfg) => groupCfg?.allowFrom,
  resolveRecord: (account: ResolvedTelegramAccount) => account.config.groups,
});

const collectTelegramSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedTelegramAccount>({
    noRouteAllowlist: {
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
      groupPolicyPath: "channels.telegram.groupPolicy",
      routeAllowlistPath: "channels.telegram.groups",
      routeScope: "group",
      surface: "Telegram groups",
    },
    providerConfigPresent: (cfg) => cfg.channels?.telegram !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.groups) && Object.keys(account.config.groups ?? {}).length > 0,
    restrictSenders: {
      groupAllowFromPath: "channels.telegram.groupAllowFrom",
      groupPolicyPath: "channels.telegram.groupPolicy",
      openScope: "any member in allowed groups",
      surface: "Telegram groups",
    },
  });

export const telegramPlugin = createChatChannelPlugin({
  base: {
    ...createTelegramPluginBase({
      setup: telegramSetupAdapter,
      setupWizard: telegramSetupWizard,
    }),
    actions: telegramMessageActions,
    agentPrompt: {
      messageToolCapabilities: ({ cfg, accountId }) => {
        const inlineButtonsScope = resolveTelegramInlineButtonsScope({
          accountId: accountId ?? undefined,
          cfg,
        });
        return inlineButtonsScope === "off" ? [] : ["inlineButtons"];
      },
      reactionGuidance: ({ cfg, accountId }) => {
        const level = resolveTelegramReactionLevel({
          accountId: accountId ?? undefined,
          cfg,
        }).agentReactionGuidance;
        return level ? { channelLabel: "Telegram", level } : undefined;
      },
    },
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: "telegram",
      normalize: ({ cfg, accountId, values }) =>
        telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveAccount: resolveTelegramAccount,
      resolveDmAllowFrom: (account) => account.config.allowFrom,
      resolveDmPolicy: (account) => account.config.dmPolicy,
      resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
      resolveGroupOverrides: resolveTelegramAllowlistGroupOverrides,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
    }),
    approvalCapability: {
      ...telegramApprovalCapability,
      render: {
        exec: {
          buildPendingPayload: ({ request, nowMs }) =>
            buildTelegramExecApprovalPendingPayload({ nowMs, request }),
        },
      },
    },
    bindings: {
      compileConfiguredBinding: ({ conversationId }) =>
        normalizeTelegramAcpConversationId(conversationId),
      matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
        matchTelegramAcpConversation({
          bindingConversationId: compiledBinding.conversationId,
          conversationId,
          parentConversationId,
        }),
      resolveCommandConversation: ({ threadId, originatingTo, commandTo, fallbackTo }) =>
        resolveTelegramCommandConversation({
          commandTo,
          fallbackTo,
          originatingTo,
          threadId,
        }),
      selfParentConversationByDefault: true,
    },
    conversationBindings: {
      buildBoundReplyChannelData: ({ operation, conversation }) => {
        if (operation !== "acp-spawn") {
          return null;
        }
        return conversation.conversationId.includes(":topic:") ? { telegram: { pin: true } } : null;
      },
      createManager: ({ accountId }) =>
        createTelegramThreadBindingManager({
          accountId: accountId ?? undefined,
          enableSweeper: false,
          persist: false,
        }),
      defaultTopLevelPlacement: "current",
      resolveConversationRef: ({
        accountId: _accountId,
        conversationId,
        parentConversationId,
        threadId,
      }) =>
        resolveTelegramInboundConversation({
          conversationId,
          threadId: threadId ?? undefined,
          to: parentConversationId ?? conversationId,
        }),
      setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
        setTelegramThreadBindingIdleTimeoutBySessionKey({
          accountId: accountId ?? undefined,
          idleTimeoutMs,
          targetSessionKey,
        }),
      setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
        setTelegramThreadBindingMaxAgeBySessionKey({
          accountId: accountId ?? undefined,
          maxAgeMs,
          targetSessionKey,
        }),
      shouldStripThreadFromAnnounceOrigin: shouldStripTelegramThreadFromAnnounceOrigin,
      supportsCurrentConversationBinding: true,
    },
    directory: createChannelDirectoryAdapter({
      listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
      listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),
    }),
    gateway: {
      logoutAccount: async ({ accountId, cfg }) => {
        const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
        const nextCfg = { ...cfg } as OpenClawConfig;
        const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : undefined;
        let cleared = false;
        let changed = false;
        if (nextTelegram) {
          if (accountId === DEFAULT_ACCOUNT_ID && nextTelegram.botToken) {
            delete nextTelegram.botToken;
            cleared = true;
            changed = true;
          }
          const accountCleanup = clearAccountEntryFields({
            accountId,
            accounts: nextTelegram.accounts,
            fields: ["botToken"],
          });
          if (accountCleanup.changed) {
            changed = true;
            if (accountCleanup.cleared) {
              cleared = true;
            }
            if (accountCleanup.nextAccounts) {
              nextTelegram.accounts = accountCleanup.nextAccounts;
            } else {
              delete nextTelegram.accounts;
            }
          }
        }
        if (changed) {
          if (nextTelegram && Object.keys(nextTelegram).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, telegram: nextTelegram };
          } else {
            const nextChannels = { ...nextCfg.channels };
            delete nextChannels.telegram;
            if (Object.keys(nextChannels).length > 0) {
              nextCfg.channels = nextChannels;
            } else {
              delete nextCfg.channels;
            }
          }
        }
        const resolved = resolveTelegramAccount({
          accountId,
          cfg: changed ? nextCfg : cfg,
        });
        const loggedOut = resolved.tokenSource === "none";
        if (changed) {
          await getTelegramRuntime().config.writeConfigFile(nextCfg);
        }
        return { cleared, envToken: Boolean(envToken), loggedOut };
      },
      startAccount: async (ctx) => {
        const {account} = ctx;
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          accountId: account.accountId,
          cfg: ctx.cfg,
        });
        if (ownerAccountId) {
          const reason = formatDuplicateTelegramTokenReason({
            accountId: account.accountId,
            ownerAccountId,
          });
          ctx.log?.error?.(`[${account.accountId}] ${reason}`);
          throw new Error(reason);
        }
        const token = (account.token ?? "").trim();
        let telegramBotLabel = "";
        try {
          const probe = await resolveTelegramProbe()(token, 2500, {
            accountId: account.accountId,
            apiRoot: account.config.apiRoot,
            network: account.config.network,
            proxyUrl: account.config.proxy,
          });
          const username = probe.ok ? probe.bot?.username?.trim() : null;
          if (username) {
            telegramBotLabel = ` (@${username})`;
          }
        } catch (error) {
          if (getTelegramRuntime().logging.shouldLogVerbose()) {
            ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(error)}`);
          }
        }
        ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);
        return resolveTelegramMonitor()({
          abortSignal: ctx.abortSignal,
          accountId: account.accountId,
          channelRuntime: ctx.channelRuntime,
          config: ctx.cfg,
          runtime: ctx.runtime,
          token,
          useWebhook: Boolean(account.config.webhookUrl),
          webhookCertPath: account.config.webhookCertPath,
          webhookHost: account.config.webhookHost,
          webhookPath: account.config.webhookPath,
          webhookPort: account.config.webhookPort,
          webhookSecret: account.config.webhookSecret,
          webhookUrl: account.config.webhookUrl,
        });
      },
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    lifecycle: {
      detectLegacyStateMigrations: ({ cfg, env }) =>
        detectTelegramLegacyStateMigrations({ cfg, env }),
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        const previousToken = resolveTelegramAccount({ accountId, cfg: prevCfg }).token.trim();
        const nextToken = resolveTelegramAccount({ accountId, cfg: nextCfg }).token.trim();
        if (previousToken !== nextToken) {
          const { deleteTelegramUpdateOffset } = await import("../update-offset-runtime-api.js");
          await deleteTelegramUpdateOffset({ accountId });
        }
      },
      onAccountRemoved: async ({ accountId }) => {
        const { deleteTelegramUpdateOffset } = await import("../update-offset-runtime-api.js");
        await deleteTelegramUpdateOffset({ accountId });
      },
    },
    messaging: {
      formatTargetDisplay: ({ target, display, kind }) => {
        const formatted = display?.trim();
        if (formatted) {
          return formatted;
        }
        const trimmedTarget = target.trim();
        if (!trimmedTarget) {
          return trimmedTarget;
        }
        const withoutProvider = trimmedTarget.replace(/^(telegram|tg):/i, "");
        if (kind === "user" || /^user:/i.test(withoutProvider)) {
          return `@${withoutProvider.replace(/^user:/i, "")}`;
        }
        if (/^channel:/i.test(withoutProvider)) {
          return `#${withoutProvider.replace(/^channel:/i, "")}`;
        }
        return withoutProvider;
      },
      inferTargetChatType: ({ to }) => parseTelegramExplicitTarget(to).chatType,
      normalizeTarget: normalizeTelegramMessagingTarget,
      parseExplicitTarget: ({ raw }) => parseTelegramExplicitTarget(raw),
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) =>
        resolveTelegramDeliveryTarget({ conversationId, parentConversationId }),
      resolveInboundConversation: ({ to, conversationId, threadId }) =>
        resolveTelegramInboundConversation({ conversationId, threadId, to }),
      resolveOutboundSessionRoute: (params) => resolveTelegramOutboundSessionRoute(params),
      resolveSessionConversation: ({ kind, rawId }) =>
        resolveTelegramSessionConversation({ kind, rawId }),
      targetResolver: {
        hint: "<chatId>",
        looksLikeId: looksLikeTelegramTargetId,
      },
    },
    resolver: {
      resolveTargets: async ({ cfg, accountId, inputs, kind }) =>
        await resolveTelegramTargets({ accountId, cfg, inputs, kind }),
    },
    status: createComputedAccountStatusAdapter<ResolvedTelegramAccount, TelegramProbe>({
      auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
        const groups =
          cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
          cfg.channels?.telegram?.groups;
        const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
          resolveTelegramAuditCollector()(groups);
        if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
          return undefined;
        }
        const botId = probe?.ok && probe.bot?.id != null ? probe.bot.id : null;
        if (!botId) {
          return {
            ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
            checkedGroups: 0,
            unresolvedGroups,
            hasWildcardUnmentionedGroups,
            groups: [],
            elapsedMs: 0,
          };
        }
        const audit = await resolveTelegramAuditMembership()({
          token: account.token,
          botId,
          groupIds,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
          timeoutMs,
        });
        return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
      },
      buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
      collectStatusIssues: collectTelegramStatusIssues,
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      formatCapabilitiesProbe: ({ probe }) => {
        const lines = [];
        if (probe?.bot?.username) {
          const botId = probe.bot.id ? ` (${probe.bot.id})` : "";
          lines.push({ text: `Bot: @${probe.bot.username}${botId}` });
        }
        const flags: string[] = [];
        if (typeof probe?.bot?.canJoinGroups === "boolean") {
          flags.push(`joinGroups=${probe.bot.canJoinGroups}`);
        }
        if (typeof probe?.bot?.canReadAllGroupMessages === "boolean") {
          flags.push(`readAllGroupMessages=${probe.bot.canReadAllGroupMessages}`);
        }
        if (typeof probe?.bot?.supportsInlineQueries === "boolean") {
          flags.push(`inlineQueries=${probe.bot.supportsInlineQueries}`);
        }
        if (flags.length > 0) {
          lines.push({ text: `Flags: ${flags.join(" ")}` });
        }
        if (probe?.webhook?.url !== undefined) {
          lines.push({ text: `Webhook: ${probe.webhook.url || "none"}` });
        }
        return lines;
      },
      probeAccount: async ({ account, timeoutMs }) =>
        resolveTelegramProbe()(account.token, timeoutMs, {
          accountId: account.accountId,
          proxyUrl: account.config.proxy,
          network: account.config.network,
          apiRoot: account.config.apiRoot,
        }),
      resolveAccountSnapshot: ({ account, cfg, runtime, audit }) => {
        const configuredFromStatus = resolveConfiguredFromCredentialStatuses(account);
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          cfg,
          accountId: account.accountId,
        });
        const duplicateTokenReason = ownerAccountId
          ? formatDuplicateTelegramTokenReason({
              accountId: account.accountId,
              ownerAccountId,
            })
          : null;
        const configured =
          (configuredFromStatus ?? Boolean(account.token?.trim())) && !ownerAccountId;
        const groups =
          cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
          cfg.channels?.telegram?.groups;
        const allowUnmentionedGroups =
          groups?.["*"]?.requireMention === false ||
          Object.entries(groups ?? {}).some(
            ([key, value]) => key !== "*" && value?.requireMention === false,
          );
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          extra: {
            ...projectCredentialSnapshotFields(account),
            lastError: runtime?.lastError ?? duplicateTokenReason,
            mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
            audit,
            allowUnmentionedGroups,
          },
        };
      },
      skipStaleSocketHealthCheck: true,
    }),
  },
  outbound: {
    attachedResults: {
      channel: "telegram",
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        gatewayClientScopes,
      }) =>
        await sendTelegramOutbound({
          accountId,
          cfg,
          deps,
          gatewayClientScopes,
          mediaLocalRoots,
          mediaUrl,
          replyToId,
          silent,
          text,
          threadId,
          to,
        }),
      sendPoll: async ({
        cfg,
        to,
        poll,
        accountId,
        threadId,
        silent,
        isAnonymous,
        gatewayClientScopes,
      }) => {
        const { sendPollTelegram } = await loadTelegramSendModule();
        return await sendPollTelegram(to, poll, {
          accountId: accountId ?? undefined,
          cfg,
          gatewayClientScopes,
          isAnonymous: isAnonymous ?? undefined,
          messageThreadId: parseTelegramThreadId(threadId),
          silent: silent ?? undefined,
        });
      },
      sendText: async ({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        gatewayClientScopes,
      }) =>
        await sendTelegramOutbound({
          accountId,
          cfg,
          deps,
          gatewayClientScopes,
          replyToId,
          silent,
          text,
          threadId,
          to,
        }),
    },
    base: {
      ...telegramOutboundBaseAdapter,
      beforeDeliverPayload: async ({ cfg, target, hint }) => {
        if (hint?.kind !== "approval-pending" || hint.approvalKind !== "exec") {
          return;
        }
        const threadId =
          typeof target.threadId === "number"
            ? target.threadId
            : (typeof target.threadId === "string"
              ? Number.parseInt(target.threadId, 10)
              : undefined);
        const { sendTypingTelegram } = await loadTelegramSendModule();
        await sendTypingTelegram(target.to, {
          accountId: target.accountId ?? undefined,
          cfg,
          ...(Number.isFinite(threadId) ? { messageThreadId: threadId } : {}),
        }).catch(() => {});
      },
      resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
        typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
      sendPayload: async ({
        cfg,
        to,
        payload,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        threadId,
        silent,
        forceDocument,
        gatewayClientScopes,
      }) => {
        const send = await resolveTelegramSend(deps);
        const result = await sendTelegramPayloadMessages({
          baseOpts: buildTelegramSendOptions({
            cfg,
            mediaLocalRoots,
            accountId,
            replyToId,
            threadId,
            silent,
            forceDocument,
            gatewayClientScopes,
          }),
          payload,
          send,
          to,
        });
        return attachChannelToResult("telegram", result);
      },
      shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload }) =>
        shouldSuppressLocalTelegramExecApprovalPrompt({
          accountId,
          cfg,
          payload,
        }),
      shouldTreatDeliveredTextAsVisible: shouldTreatTelegramDeliveredTextAsVisible,
      supportsAnonymousPolls: true,
      supportsPollDurationSeconds: true,
      targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
    },
  },
  pairing: {
    text: {
      idLabel: "telegramUserId",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: createPairingPrefixStripper(/^(telegram|tg):/i),
      notify: async ({ cfg, id, message, accountId }) => {
        const { token } = resolveTelegramTokenHelper()(cfg, { accountId });
        if (!token) {
          throw new Error("telegram token not configured");
        }
        const send = await resolveTelegramSend();
        await send(id, message, { accountId, token });
      },
    },
  },
  security: {
    collectAuditFindings: collectTelegramSecurityAuditFindings,
    collectWarnings: collectTelegramSecurityWarnings,
    dm: {
      channelKey: "telegram",
      normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
      policyPathSuffix: "dmPolicy",
      resolveAllowFrom: (account) => account.config.allowFrom,
      resolvePolicy: (account) => account.config.dmPolicy,
    },
  },
  threading: {
    buildToolContext: (params) => buildTelegramThreadingToolContext(params),
    resolveAutoThreadId: ({ to, toolContext }) => resolveTelegramAutoThreadId({ to, toolContext }),
    topLevelReplyToMode: "telegram",
  },
});
