import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedIrcAccount } from "./accounts.js";
import { normalizeIrcAllowlist, resolveIrcAllowlistMatch } from "./normalize.js";
import {
  resolveIrcGroupAccessGate,
  resolveIrcGroupMatch,
  resolveIrcGroupSenderAllowed,
  resolveIrcMentionGate,
  resolveIrcRequireMention,
} from "./policy.js";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  isDangerousNameMatchingEnabled,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
  resolveEffectiveAllowFromLists,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-api.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const CHANNEL_ID = "irc" as const;

const escapeIrcRegexLiteral = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

function resolveIrcEffectiveAllowlists(params: {
  configAllowFrom: string[];
  configGroupAllowFrom: string[];
  storeAllowList: string[];
  dmPolicy: string;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.configAllowFrom,
    groupAllowFrom: params.configGroupAllowFrom,
    storeAllowFrom: params.storeAllowList,
    dmPolicy: params.dmPolicy,
    // IRC intentionally requires explicit groupAllowFrom; do not fallback to allowFrom.
    groupAllowFromFallbackToAllowFrom: false,
  });
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

async function deliverIrcReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const delivered = await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageIrc(params.target, text, {
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
  if (!delivered) {
    return;
  }
}

export async function handleIrcInbound(params: {
  message: IrcInboundMessage;
  account: ResolvedIrcAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  connectedNick?: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, connectedNick, statusSink } = params;
  const core = getIrcRuntime();
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: CHANNEL_ID,
    core,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderHost
    ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}`
    : message.senderNick;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: account.config.groupPolicy,
      providerConfigPresent: config.channels?.irc !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (message) => runtime.log?.(message),
    providerKey: "irc",
    providerMissingFallbackApplied,
  });

  const configAllowFrom = normalizeIrcAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeIrcAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    accountId: account.accountId,
    dmPolicy,
    provider: CHANNEL_ID,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeIrcAllowlist(storeAllowFrom);

  const groupMatch = resolveIrcGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  if (message.isGroup) {
    const groupAccess = resolveIrcGroupAccessGate({ groupMatch, groupPolicy });
    if (!groupAccess.allowed) {
      runtime.log?.(`irc: drop channel ${message.target} (${groupAccess.reason})`);
      return;
    }
  }

  const directGroupAllowFrom = normalizeIrcAllowlist(groupMatch.groupConfig?.allowFrom);
  const wildcardGroupAllowFrom = normalizeIrcAllowlist(groupMatch.wildcardConfig?.allowFrom);
  const groupAllowFrom =
    directGroupAllowFrom.length > 0 ? directGroupAllowFrom : wildcardGroupAllowFrom;

  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveIrcEffectiveAllowlists({
    configAllowFrom,
    configGroupAllowFrom,
    dmPolicy,
    storeAllowList,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveIrcAllowlistMatch({
    allowFrom: message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    allowNameMatching,
    message,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    allowTextCommands,
    authorizers: [
      {
        allowed: senderAllowedForCommands,
        configured: (message.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
      },
    ],
    hasControlCommand,
    useAccessGroups,
  });
  const { commandAuthorized } = commandGate;

  if (message.isGroup) {
    const senderAllowed = resolveIrcGroupSenderAllowed({
      allowNameMatching,
      groupPolicy,
      innerAllowFrom: groupAllowFrom,
      message,
      outerAllowFrom: effectiveGroupAllowFrom,
    });
    if (!senderAllowed) {
      runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`irc: drop DM sender=${senderDisplay} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveIrcAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        allowNameMatching,
        message,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          await pairing.issueChallenge({
            meta: { name: message.senderNick || undefined },
            onReplyError: (err) => {
              runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
            },
            sendPairingReply: async (text) => {
              await deliverIrcReply({
                accountId: account.accountId,
                payload: { text },
                sendReply: params.sendReply,
                statusSink,
                target: message.senderNick,
              });
            },
            senderId: normalizeLowercaseStringOrEmpty(senderDisplay),
            senderIdLine: `Your IRC id: ${senderDisplay}`,
          });
        }
        runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
        return;
      }
    }
  }

  if (message.isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      channel: CHANNEL_ID,
      log: (line) => runtime.log?.(line),
      reason: "control command (unauthorized)",
      target: senderDisplay,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const mentionNick = connectedNick?.trim() || account.nick;
  const explicitMentionRegex = mentionNick
    ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i")
    : null;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) ||
    (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);

  const requireMention = message.isGroup
    ? resolveIrcRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;

  const mentionGate = resolveIrcMentionGate({
    allowTextCommands,
    commandAuthorized,
    hasControlCommand,
    isGroup: message.isGroup,
    requireMention,
    wasMentioned,
  });
  if (mentionGate.shouldSkip) {
    runtime.log?.(`irc: drop channel ${message.target} (${mentionGate.reason})`);
    return;
  }

  const peerId = message.isGroup ? message.target : message.senderNick;
  const route = core.channel.routing.resolveAgentRoute({
    accountId: account.accountId,
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    peer: {
      id: peerId,
      kind: message.isGroup ? "group" : "direct",
    },
  });

  const fromLabel = message.isGroup ? message.target : senderDisplay;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    sessionKey: route.sessionKey,
    storePath,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    body: rawBody,
    channel: "IRC",
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp,
    timestamp: message.timestamp,
  });

  const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: body,
    ChatType: message.isGroup ? "group" : "direct",
    CommandAuthorized: commandAuthorized,
    CommandBody: rawBody,
    ConversationLabel: fromLabel,
    From: message.isGroup ? `irc:channel:${message.target}` : `irc:${senderDisplay}`,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    MessageSid: message.messageId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `irc:${peerId}`,
    Provider: CHANNEL_ID,
    RawBody: rawBody,
    SenderId: senderDisplay,
    SenderName: message.senderNick || undefined,
    SessionKey: route.sessionKey,
    Surface: CHANNEL_ID,
    Timestamp: message.timestamp,
    To: `irc:${peerId}`,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
  });

  await dispatchInboundReplyWithBase({
    accountId: account.accountId,
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    core,
    ctxPayload,
    deliver: async (payload) => {
      await deliverIrcReply({
        accountId: account.accountId,
        payload,
        sendReply: params.sendReply,
        statusSink,
        target: peerId,
      });
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
    },
    onRecordError: (err) => {
      runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
    },
    replyOptions: {
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      skillFilter: groupMatch.groupConfig?.skills,
    },
    route,
    storePath,
  });
}

export const __testing = {
  resolveIrcEffectiveAllowlists,
};
