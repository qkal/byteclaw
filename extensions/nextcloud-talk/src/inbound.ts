import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  dispatchInboundReplyWithBase,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithCommandGate,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const CHANNEL_ID = "nextcloud-talk" as const;

async function deliverNextcloudTalkReply(params: {
  payload: OutboundReplyPayload;
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, roomToken, accountId, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text, replyToId }) => {
      await sendMessageNextcloudTalk(roomToken, text, {
        accountId,
        replyTo: replyToId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: CHANNEL_ID,
    core,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : (roomKind === "group" ? true : message.isGroupChat);
  const {senderId} = message;
  const {senderName} = message;
  const {roomToken} = message;
  const {roomName} = message;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config as OpenClawConfig);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: account.config.groupPolicy,
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] ??
          undefined) !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
    providerKey: "nextcloud-talk",
    providerMissingFallbackApplied,
  });

  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    accountId: account.accountId,
    dmPolicy,
    provider: CHANNEL_ID,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);

  const roomMatch = resolveNextcloudTalkRoomMatch({
    roomToken,
    rooms: account.config.rooms,
  });
  const {roomConfig} = roomMatch;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }

  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups =
    (config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false;
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const access = resolveDmGroupAccessWithCommandGate({
    allowFrom: configAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
      useAccessGroups,
    },
    dmPolicy,
    groupAllowFrom: configGroupAllowFrom,
    groupPolicy,
    isGroup,
    isSenderAllowed: (allowFrom) =>
      resolveNextcloudTalkAllowlistMatch({
        allowFrom,
        senderId,
      }).allowed,
    storeAllowFrom: storeAllowList,
  });
  const {commandAuthorized} = access;
  const {effectiveGroupAllowFrom} = access;

  if (isGroup) {
    if (access.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${access.reason})`);
      return;
    }
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      innerAllowFrom: roomAllowFrom,
      outerAllowFrom: effectiveGroupAllowFrom,
      senderId,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
  } else {
    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await pairing.issueChallenge({
          meta: { name: senderName || undefined },
          onReplyError: (err) => {
            runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageNextcloudTalk(roomToken, text, { accountId: account.accountId });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          senderId,
          senderIdLine: `Your Nextcloud user id: ${senderId}`,
        });
      }
      runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${access.reason})`);
      return;
    }
  }

  if (access.shouldBlockControlCommand) {
    logInboundDrop({
      channel: CHANNEL_ID,
      log: (message) => runtime.log?.(message),
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    allowTextCommands,
    commandAuthorized,
    hasControlCommand,
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    accountId: account.accountId,
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    peer: {
      id: isGroup ? roomToken : senderId,
      kind: isGroup ? "group" : "direct",
    },
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    {
      agentId: route.agentId,
    },
  );
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    sessionKey: route.sessionKey,
    storePath,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    body: rawBody,
    channel: "Nextcloud Talk",
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp,
    timestamp: message.timestamp,
  });

  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: body,
    BodyForAgent: rawBody,
    ChatType: isGroup ? "group" : "direct",
    CommandAuthorized: commandAuthorized,
    CommandBody: rawBody,
    ConversationLabel: fromLabel,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    GroupSubject: isGroup ? roomName || roomToken : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    MessageSid: message.messageId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    Provider: CHANNEL_ID,
    RawBody: rawBody,
    SenderId: senderId,
    SenderName: senderName || undefined,
    SessionKey: route.sessionKey,
    Surface: CHANNEL_ID,
    Timestamp: message.timestamp,
    To: `nextcloud-talk:${roomToken}`,
    WasMentioned: isGroup ? wasMentioned : undefined,
  });

  await dispatchInboundReplyWithBase({
    accountId: account.accountId,
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    core,
    ctxPayload,
    deliver: async (payload) => {
      await deliverNextcloudTalkReply({
        accountId: account.accountId,
        payload,
        roomToken,
        statusSink,
      });
    },
    onDispatchError: (err, info) => {
      runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
    },
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
    replyOptions: {
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      skillFilter: roomConfig?.skills,
    },
    route,
    storePath,
  });
}
