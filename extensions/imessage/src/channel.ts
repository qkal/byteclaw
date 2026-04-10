import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import { type RoutePeer, buildOutboundBaseSessionKey } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { type ResolvedIMessageAccount, resolveIMessageAccount } from "./accounts.js";
import {
  type ChannelPlugin,
  DEFAULT_ACCOUNT_ID,
  chunkTextForOutbound,
  collectStatusIssuesFromLastError,
  formatTrimmedAllowFromEntries,
  normalizeIMessageMessagingTarget,
} from "./channel-api.js";
import { createIMessageConversationBindingManager } from "./conversation-bindings.js";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
  resolveIMessageConversationIdFromTarget,
} from "./conversation-id.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import type { IMessageProbe } from "./probe.js";
import { imessageSetupAdapter } from "./setup-core.js";
import {
  createIMessagePluginBase,
  imessageSecurityAdapter,
  imessageSetupWizard,
} from "./shared.js";
import { probeIMessageStatusAccount } from "./status-core.js";
import {
  inferIMessageTargetChatType,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const loadIMessageChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

function buildIMessageBaseSessionKey(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "imessage" });
}

function resolveIMessageOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const parsed = parseIMessageTarget(params.target);
  if (parsed.kind === "handle") {
    const handle = normalizeIMessageHandle(parsed.to);
    if (!handle) {
      return null;
    }
    const peer: RoutePeer = { id: handle, kind: "direct" };
    const baseSessionKey = buildIMessageBaseSessionKey({
      accountId: params.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      peer,
    });
    return {
      baseSessionKey,
      chatType: "direct" as const,
      from: `imessage:${handle}`,
      peer,
      sessionKey: baseSessionKey,
      to: `imessage:${handle}`,
    };
  }

  const peerId =
    parsed.kind === "chat_id"
      ? String(parsed.chatId)
      : (parsed.kind === "chat_guid"
        ? parsed.chatGuid
        : parsed.chatIdentifier);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { id: peerId, kind: "group" };
  const baseSessionKey = buildIMessageBaseSessionKey({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    peer,
  });
  const toPrefix =
    parsed.kind === "chat_id"
      ? "chat_id"
      : (parsed.kind === "chat_guid"
        ? "chat_guid"
        : "chat_identifier");
  return {
    baseSessionKey,
    chatType: "group" as const,
    from: `imessage:group:${peerId}`,
    peer,
    sessionKey: baseSessionKey,
    to: `${toPrefix}:${peerId}`,
  };
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount, IMessageProbe> =
  createChatChannelPlugin<ResolvedIMessageAccount, IMessageProbe>({
    base: {
      ...createIMessagePluginBase({
        setup: imessageSetupAdapter,
        setupWizard: imessageSetupWizard,
      }),
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "imessage",
        normalize: ({ values }) => formatTrimmedAllowFromEntries(values),
        resolveAccount: resolveIMessageAccount,
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeIMessageAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId }) =>
          matchIMessageAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
          }),
        resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
          const conversationId =
            resolveIMessageConversationIdFromTarget(originatingTo ?? "") ??
            resolveIMessageConversationIdFromTarget(commandTo ?? "") ??
            resolveIMessageConversationIdFromTarget(fallbackTo ?? "");
          return conversationId ? { conversationId } : null;
        },
      },
      conversationBindings: {
        createManager: ({ cfg, accountId }) =>
          createIMessageConversationBindingManager({
            accountId: accountId ?? undefined,
            cfg,
          }),
        supportsCurrentConversationBinding: true,
      },
      doctor: {
        groupAllowFromFallbackToAllowFrom: false,
      },
      gateway: {
        startAccount: async (ctx) => {
          const conversationBindings = createIMessageConversationBindingManager({
            accountId: ctx.accountId,
            cfg: ctx.cfg,
          });
          try {
            return await (await loadIMessageChannelRuntime()).startIMessageGatewayAccount(ctx);
          } finally {
            conversationBindings.stop();
          }
        },
      },
      groups: {
        resolveRequireMention: resolveIMessageGroupRequireMention,
        resolveToolPolicy: resolveIMessageGroupToolPolicy,
      },
      messaging: {
        inferTargetChatType: ({ to }) => inferIMessageTargetChatType(to),
        normalizeTarget: normalizeIMessageMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveIMessageOutboundSessionRoute(params),
        targetResolver: {
          hint: "<handle|chat_id:ID>",
          looksLikeId: looksLikeIMessageExplicitTargetId,
          resolveTarget: async ({ normalized }) => {
            const to = normalized?.trim();
            if (!to) {
              return null;
            }
            const chatType = inferIMessageTargetChatType(to);
            if (!chatType) {
              return null;
            }
            return {
              kind: chatType === "direct" ? "user" : "group",
              source: "normalized" as const,
              to,
            };
          },
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedIMessageAccount, IMessageProbe>({
        buildChannelSummary: ({ snapshot }) =>
          buildPassiveProbedChannelStatusSummary(snapshot, {
            cliPath: snapshot.cliPath ?? null,
            dbPath: snapshot.dbPath ?? null,
          }),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
          cliPath: null,
          dbPath: null,
        }),
        probeAccount: async ({ account, timeoutMs }) =>
          await probeIMessageStatusAccount({
            account,
            timeoutMs,
            probeIMessageAccount: async (params) =>
              await (await loadIMessageChannelRuntime()).probeIMessageAccount(params),
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
            dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
          },
        }),
        resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
      }),
    },
    outbound: {
      attachedResults: {
        channel: "imessage",
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          accountId,
          deps,
          replyToId,
        }) =>
          await (
            await loadIMessageChannelRuntime()
          ).sendIMessageOutbound({
            accountId: accountId ?? undefined,
            cfg,
            deps,
            mediaLocalRoots,
            mediaUrl,
            replyToId: replyToId ?? undefined,
            text,
            to,
          }),
        sendText: async ({ cfg, to, text, accountId, deps, replyToId }) =>
          await (
            await loadIMessageChannelRuntime()
          ).sendIMessageOutbound({
            accountId: accountId ?? undefined,
            cfg,
            deps,
            replyToId: replyToId ?? undefined,
            text,
            to,
          }),
      },
      base: {
        chunker: chunkTextForOutbound,
        chunkerMode: "text",
        deliveryMode: "direct",
        sanitizeText: ({ text }) => sanitizeForPlainText(text),
        textChunkLimit: 4000,
      },
    },
    pairing: {
      text: {
        idLabel: "imessageSenderId",
        message: "OpenClaw: your access has been approved.",
        notify: async ({ id }) =>
          await (await loadIMessageChannelRuntime()).notifyIMessageApproval(id),
      },
    },
    security: imessageSecurityAdapter,
  });
