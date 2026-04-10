import { ChannelType, type Message, MessageType, type User } from "@buape/carbon";
import { type APIMessage, Routes } from "discord-api-types/v10";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import {
  buildMentionRegexes,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth-native";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { isDangerousNameMatchingEnabled, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { enqueueSystemEvent, recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import {
  type HistoryEntry,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { getChildLogger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { logDebug, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import {
  formatDiscordUserTag,
  resolveDiscordSystemLocation,
  resolveTimestampMs,
} from "./format.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];

let conversationRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>
  | undefined;
let pluralkitRuntimePromise: Promise<typeof import("../pluralkit.js")> | undefined;
let discordSendRuntimePromise: Promise<typeof import("../send.js")> | undefined;
let preflightAudioRuntimePromise: Promise<typeof import("./preflight-audio.js")> | undefined;
let systemEventsRuntimePromise: Promise<typeof import("./system-events.js")> | undefined;
let discordThreadingRuntimePromise: Promise<typeof import("./threading.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("openclaw/plugin-sdk/conversation-binding-runtime");
  return await conversationRuntimePromise;
}

async function loadPluralKitRuntime() {
  pluralkitRuntimePromise ??= import("../pluralkit.js");
  return await pluralkitRuntimePromise;
}

async function loadDiscordSendRuntime() {
  discordSendRuntimePromise ??= import("../send.js");
  return await discordSendRuntimePromise;
}

async function loadPreflightAudioRuntime() {
  preflightAudioRuntimePromise ??= import("./preflight-audio.js");
  return await preflightAudioRuntimePromise;
}

async function loadSystemEventsRuntime() {
  systemEventsRuntimePromise ??= import("./system-events.js");
  return await systemEventsRuntimePromise;
}

async function loadDiscordThreadingRuntime() {
  discordThreadingRuntimePromise ??= import("./threading.js");
  return await discordThreadingRuntimePromise;
}

function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

interface BoundThreadLookupRecordLike {
  webhookId?: string | null;
  metadata?: {
    webhookId?: string | null;
  };
}

function isDiscordThreadChannelType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function isDiscordThreadChannelMessage(params: {
  isGuildMessage: boolean;
  message: Message;
  channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): boolean {
  if (!params.isGuildMessage) {
    return false;
  }
  const channel =
    "channel" in params.message ? (params.message as { channel?: unknown }).channel : undefined;
  return Boolean(
    (channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: unknown }).isThread === "function" &&
      (channel as { isThread: () => boolean }).isThread()) ||
    isDiscordThreadChannelType(params.channelInfo?.type),
  );
}

function resolveInjectedBoundThreadLookupRecord(params: {
  threadBindings: DiscordMessagePreflightParams["threadBindings"];
  threadId: string;
}): BoundThreadLookupRecordLike | undefined {
  const { getByThreadId } = params.threadBindings as {
    getByThreadId?: (threadId: string) => unknown;
  };
  if (typeof getByThreadId !== "function") {
    return undefined;
  }
  const binding = getByThreadId(params.threadId);
  return binding && typeof binding === "object"
    ? (binding as BoundThreadLookupRecordLike)
    : undefined;
}

function resolveDiscordMentionState(params: {
  authorIsBot: boolean;
  botId?: string;
  hasAnyMention: boolean;
  isDirectMessage: boolean;
  isExplicitlyMentioned: boolean;
  mentionRegexes: RegExp[];
  mentionText: string;
  mentionedEveryone: boolean;
  referencedAuthorId?: string;
  senderIsPluralKit: boolean;
  transcript?: string;
}) {
  if (params.isDirectMessage) {
    return {
      implicitMentionKinds: [],
      wasMentioned: false,
    };
  }

  const everyoneMentioned =
    params.mentionedEveryone && (!params.authorIsBot || params.senderIsPluralKit);
  const wasMentioned =
    everyoneMentioned ||
    matchesMentionWithExplicit({
      explicit: {
        canResolveExplicit: Boolean(params.botId),
        hasAnyMention: params.hasAnyMention,
        isExplicitlyMentioned: params.isExplicitlyMentioned,
      },
      mentionRegexes: params.mentionRegexes,
      text: params.mentionText,
      transcript: params.transcript,
    });
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    Boolean(params.botId) &&
      Boolean(params.referencedAuthorId) &&
      params.referencedAuthorId === params.botId,
  );

  return {
    implicitMentionKinds,
    wasMentioned,
  };
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  bypassMentionRequirement: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.bypassMentionRequirement;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  accountId?: string;
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: BoundThreadLookupRecordLike;
}): boolean {
  const webhookId = normalizeOptionalString(params.webhookId) ?? "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    normalizeOptionalString(params.threadBinding?.webhookId) ??
    normalizeOptionalString(params.threadBinding?.metadata?.webhookId) ??
    "";
  if (!boundWebhookId) {
    const threadId = normalizeOptionalString(params.threadId) ?? "";
    if (!threadId) {
      return false;
    }
    return isRecentlyUnboundThreadWebhookMessage({
      accountId: params.accountId,
      threadId,
      webhookId,
    });
  }
  return webhookId === boundWebhookId;
}

function mergeFetchedDiscordMessage(base: Message, fetched: APIMessage): Message {
  const baseReferenced = (
    base as unknown as {
      referencedMessage?: {
        mentionedUsers?: unknown[];
        mentionedRoles?: unknown[];
        mentionedEveryone?: boolean;
      };
    }
  ).referencedMessage;
  const fetchedMentions = Array.isArray(fetched.mentions)
    ? fetched.mentions.map((mention) => ({
        ...mention,
        globalName: mention.global_name ?? undefined,
      }))
    : undefined;
  const assignWithPrototype = <T extends object>(baseObject: T, ...sources: object[]): T =>
    Object.assign(
      Object.create(Object.getPrototypeOf(baseObject) ?? Object.prototype),
      baseObject,
      ...sources,
    ) as T;
  const referencedMessage = fetched.referenced_message
    ? assignWithPrototype(
        ((base as { referencedMessage?: Message }).referencedMessage ?? {}) as Message,
        fetched.referenced_message,
        {
          mentionedEveryone:
            fetched.referenced_message.mention_everyone ??
            baseReferenced?.mentionedEveryone ??
            false,
          mentionedRoles:
            fetched.referenced_message.mention_roles ?? baseReferenced?.mentionedRoles ?? [],
          mentionedUsers: Array.isArray(fetched.referenced_message.mentions)
            ? fetched.referenced_message.mentions.map((mention) => ({
                ...mention,
                globalName: mention.global_name ?? undefined,
              }))
            : (baseReferenced?.mentionedUsers ?? []),
        } satisfies Record<string, unknown>,
      )
    : (base as { referencedMessage?: Message }).referencedMessage;
  const baseRawData = (base as { rawData?: Record<string, unknown> }).rawData;
  const rawData = {
    ...(base as { rawData?: Record<string, unknown> }).rawData,
    message_snapshots:
      fetched.message_snapshots ??
      (base as { rawData?: { message_snapshots?: unknown } }).rawData?.message_snapshots,
    sticker_items:
      (fetched as { sticker_items?: unknown }).sticker_items ?? baseRawData?.sticker_items,
  };
  return assignWithPrototype(base, fetched, {
    attachments: fetched.attachments ?? base.attachments,
    content: fetched.content ?? base.content,
    embeds: fetched.embeds ?? base.embeds,
    mentionedEveryone: fetched.mention_everyone ?? base.mentionedEveryone,
    mentionedRoles: fetched.mention_roles ?? base.mentionedRoles,
    mentionedUsers: fetchedMentions ?? base.mentionedUsers,
    rawData,
    referencedMessage,
    stickers:
      (fetched as { stickers?: unknown }).stickers ??
      (fetched as { sticker_items?: unknown }).sticker_items ??
      base.stickers,
  }) as unknown as Message;
}

async function hydrateDiscordMessageIfEmpty(params: {
  client: DiscordMessagePreflightParams["client"];
  message: Message;
  messageChannelId: string;
}): Promise<Message> {
  const currentText = resolveDiscordMessageText(params.message, {
    includeForwarded: true,
  });
  if (currentText) {
    return params.message;
  }
  const rest = params.client.rest as { get?: (route: string) => Promise<unknown> } | undefined;
  if (typeof rest?.get !== "function") {
    return params.message;
  }
  try {
    const fetched = (await rest.get(
      Routes.channelMessage(params.messageChannelId, params.message.id),
    )) as APIMessage | null | undefined;
    if (!fetched) {
      return params.message;
    }
    logVerbose(`discord: hydrated empty inbound payload via REST for ${params.message.id}`);
    return mergeFetchedDiscordMessage(params.message, fetched);
  } catch (error) {
    logVerbose(`discord: failed to hydrate message ${params.message.id}: ${String(error)}`);
    return params.message;
  }
}

export async function preflightDiscordMessage(
  params: DiscordMessagePreflightParams,
): Promise<DiscordMessagePreflightContext | null> {
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const logger = getChildLogger({ module: "discord-auto-reply" });
  let { message } = params.data;
  const { author } = params.data;
  if (!author) {
    return null;
  }
  const messageChannelId = resolveDiscordMessageChannelId({
    eventChannelId: params.data.channel_id,
    message,
  });
  if (!messageChannelId) {
    logVerbose(`discord: drop message ${message.id} (missing channel id)`);
    return null;
  }

  const allowBotsSetting = params.discordConfig?.allowBots;
  const allowBotsMode =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
  if (params.botUserId && author.id === params.botUserId) {
    // Always ignore own messages to prevent self-reply loops
    return null;
  }

  message = await hydrateDiscordMessageIfEmpty({
    client: params.client,
    message,
    messageChannelId,
  });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const pluralkitConfig = params.discordConfig?.pluralkit;
  const webhookId = resolveDiscordWebhookId(message);
  const shouldCheckPluralKit = Boolean(pluralkitConfig?.enabled) && !webhookId;
  let pluralkitInfo: Awaited<
    ReturnType<typeof import("../pluralkit.js").fetchPluralKitMessageInfo>
  > = null;
  if (shouldCheckPluralKit) {
    try {
      const { fetchPluralKitMessageInfo } = await loadPluralKitRuntime();
      pluralkitInfo = await fetchPluralKitMessageInfo({
        config: pluralkitConfig,
        messageId: message.id,
      });
      if (isPreflightAborted(params.abortSignal)) {
        return null;
      }
    } catch (error) {
      logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(error)}`);
    }
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  if (author.bot) {
    if (allowBotsMode === "off" && !sender.isPluralKit) {
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }

  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const isDirectMessage = channelInfo?.type === ChannelType.DM;
  const isGroupDm = channelInfo?.type === ChannelType.GroupDM;
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const injectedBoundThreadBinding =
    !isDirectMessage && !isGroupDm
      ? resolveInjectedBoundThreadLookupRecord({
          threadBindings: params.threadBindings,
          threadId: messageChannelId,
        })
      : undefined;
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadBinding: injectedBoundThreadBinding,
      threadId: messageChannelId,
      webhookId,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  if (
    isBoundThreadBotSystemMessage({
      isBotAuthor: Boolean(author.bot),
      isBoundThreadSession:
        Boolean(injectedBoundThreadBinding) &&
        isDiscordThreadChannelMessage({
          channelInfo,
          isGuildMessage,
          message,
        }),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const data = message === params.data.message ? params.data : { ...params.data, message };
  logDebug(
    `[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
  );

  if (isGroupDm && !params.groupDmEnabled) {
    logVerbose("discord: drop group dm (group dms disabled)");
    return null;
  }
  if (isDirectMessage && !params.dmEnabled) {
    logVerbose("discord: drop dm (dms disabled)");
    return null;
  }

  const dmPolicy = params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing";
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (dmPolicy === "disabled") {
      logVerbose("discord: drop dm (dmPolicy: disabled)");
      return null;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId: resolvedAccountId,
      allowNameMatching,
      configuredAllowFrom: params.allowFrom ?? [],
      dmPolicy,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      useAccessGroups,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    ({ commandAuthorized } = dmAccess);
    if (dmAccess.decision !== "allow") {
      const allowMatchMeta = formatAllowlistMatchMeta(
        dmAccess.allowMatch.allowed ? dmAccess.allowMatch : undefined,
      );
      await handleDiscordDmCommandDecision({
        accountId: resolvedAccountId,
        dmAccess,
        onPairingCreated: async (code) => {
          logVerbose(
            `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} (${allowMatchMeta})`,
          );
          try {
            const conversationRuntime = await loadConversationRuntime();
            const { sendMessageDiscord } = await loadDiscordSendRuntime();
            await sendMessageDiscord(
              `user:${author.id}`,
              conversationRuntime.buildPairingReply({
                channel: "discord",
                code,
                idLine: `Your Discord user id: ${author.id}`,
              }),
              {
                accountId: params.accountId,
                rest: params.client.rest,
                token: params.token,
              },
            );
          } catch (error) {
            logVerbose(`discord pairing reply failed for ${author.id}: ${String(error)}`);
          }
        },
        onUnauthorized: async () => {
          logVerbose(
            `Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        },
        sender: {
          id: author.id,
          name: author.username ?? undefined,
          tag: formatDiscordUserTag(author),
        },
      });
      return null;
    }
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });

  // Intercept text-only slash commands (e.g. user typing "/reset" instead of using Discord's slash command picker)
  // These should not be forwarded to the agent; proper slash command interactions are handled elsewhere
  if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
    logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
    return null;
  }

  recordChannelActivity({
    accountId: params.accountId,
    channel: "discord",
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    ((isGuildMessage || isGroupDm) && message.channel && "name" in message.channel
      ? message.channel.name
      : undefined);
  const { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } =
    await loadDiscordThreadingRuntime();
  const earlyThreadChannel = resolveDiscordThreadChannel({
    channelInfo,
    isGuildMessage,
    message,
    messageChannelId,
  });
  let earlyThreadParentId: string | undefined;
  let earlyThreadParentName: string | undefined;
  let earlyThreadParentType: ChannelType | undefined;
  if (earlyThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      channelInfo,
      client: params.client,
      threadChannel: earlyThreadChannel,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    earlyThreadParentId = parentInfo.id;
    earlyThreadParentName = parentInfo.name;
    earlyThreadParentType = parentInfo.type;
  }

  // Use the active runtime snapshot for bindings lookup; routing inputs are
  // Still payload-derived, but this path should not reparse config from disk.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles.map((roleId: string) => String(roleId))
    : [];
  const freshCfg = loadConfig();
  const conversationRuntime = await loadConversationRuntime();
  const route = resolveDiscordConversationRoute({
    accountId: params.accountId,
    cfg: freshCfg,
    guildId: params.data.guild_id ?? undefined,
    memberRoleIds,
    parentConversationId: earlyThreadParentId,
    peer: buildDiscordRoutePeer({
      conversationId: messageChannelId,
      directUserId: author.id,
      isDirectMessage,
      isGroupDm,
    }),
  });
  const bindingConversationId = isDirectMessage
    ? (resolveDiscordConversationIdentity({
        isDirectMessage,
        userId: author.id,
      }) ?? `user:${author.id}`)
    : messageChannelId;
  let threadBinding: SessionBindingRecord | undefined;
  threadBinding =
    conversationRuntime.getSessionBindingService().resolveByConversation({
      accountId: params.accountId,
      channel: "discord",
      conversationId: bindingConversationId,
      parentConversationId: earlyThreadParentId,
    }) ?? undefined;
  const configuredRoute =
    threadBinding == null
      ? conversationRuntime.resolveConfiguredBindingRoute({
          cfg: freshCfg,
          conversation: {
            accountId: params.accountId,
            channel: "discord",
            conversationId: messageChannelId,
            parentConversationId: earlyThreadParentId,
          },
          route,
        })
      : null;
  const configuredBinding = configuredRoute?.bindingResolution ?? null;
  if (!threadBinding && configuredBinding) {
    threadBinding = configuredBinding.record;
  }
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadBinding,
      threadId: messageChannelId,
      webhookId,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const boundSessionKey = conversationRuntime.isPluginOwnedSessionBindingRecord(threadBinding)
    ? ""
    : threadBinding?.targetSessionKey?.trim();
  const effectiveRoute = resolveDiscordEffectiveRoute({
    boundSessionKey,
    configuredRoute,
    matchedBy: "binding.channel",
    route,
  });
  const boundAgentId = boundSessionKey ? effectiveRoute.agentId : undefined;
  const isBoundThreadSession = Boolean(threadBinding && earlyThreadChannel);
  const bypassMentionRequirement = isBoundThreadSession;
  if (
    isBoundThreadBotSystemMessage({
      isBotAuthor: Boolean(author.bot),
      isBoundThreadSession,
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
  const explicitlyMentioned = Boolean(
    botId && message.mentionedUsers?.some((user: User) => user.id === botId),
  );
  const hasAnyMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit))),
  );
  const hasUserOrRoleMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0),
  );

  if (
    isGuildMessage &&
    (message.type === MessageType.ChatInputCommand ||
      message.type === MessageType.ContextMenuCommand)
  ) {
    logVerbose("discord: drop channel command message");
    return null;
  }

  const guildInfo = isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: params.data.guild ?? undefined,
        guildEntries: params.guildEntries,
        guildId: params.data.guild_id ?? undefined,
      })
    : null;
  logDebug(
    `[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${Boolean(params.data.guild)} guild_obj_id=${params.data.guild?.id} guildInfo=${Boolean(guildInfo)} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`,
  );
  if (
    isGuildMessage &&
    params.guildEntries &&
    Object.keys(params.guildEntries).length > 0 &&
    !guildInfo
  ) {
    logDebug(
      `[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`,
    );
    logVerbose(
      `Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`,
    );
    return null;
  }

  // Reuse early thread resolution from above (for binding inheritance)
  const threadChannel = earlyThreadChannel;
  const threadParentId = earlyThreadParentId;
  const threadParentName = earlyThreadParentName;
  const threadParentType = earlyThreadParentType;
  const threadName = threadChannel?.name;
  const configChannelName = threadParentName ?? channelName;
  const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
  const displayChannelName = threadName ?? channelName;
  const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
  const guildSlug =
    guildInfo?.slug ||
    (params.data.guild?.name ? normalizeDiscordSlug(params.data.guild.name) : "");

  const threadChannelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";

  const baseSessionKey = effectiveRoute.sessionKey;
  const channelConfig = isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        channelId: messageChannelId,
        channelName,
        channelSlug: threadChannelSlug,
        guildInfo,
        parentId: threadParentId ?? undefined,
        parentName: threadParentName ?? undefined,
        parentSlug: threadParentSlug,
        scope: threadChannel ? "thread" : "channel",
      })
    : null;
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  if (shouldLogVerbose()) {
    const channelConfigSummary = channelConfig
      ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}`
      : "none";
    logDebug(
      `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${channelMatchMeta} channelId=${messageChannelId}`,
    );
  }
  if (isGuildMessage && channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} (channel disabled, ${channelMatchMeta})`,
    );
    return null;
  }

  const groupDmAllowed =
    isGroupDm &&
    resolveGroupDmAllow({
      channelId: messageChannelId,
      channelName: displayChannelName,
      channelSlug: displayChannelSlug,
      channels: params.groupDmChannels,
    });
  if (isGroupDm && !groupDmAllowed) {
    return null;
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      channelAllowed,
      channelAllowlistConfigured,
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logDebug(`[discord-preflight] drop: groupPolicy disabled`);
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`,
      );
    } else {
      logDebug(
        `[discord] Ignored message from channel ${messageChannelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`,
      );
      logVerbose(
        `Blocked discord channel ${messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`,
      );
    }
    return null;
  }

  if (isGuildMessage && channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} not in guild channel allowlist (${channelMatchMeta})`,
    );
    return null;
  }
  if (isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${messageChannelId} (${channelMatchMeta})`);
  }

  const textForHistory = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const historyEntry =
    isGuildMessage && params.historyLimit > 0 && textForHistory
      ? ({
          body: textForHistory,
          messageId: message.id,
          sender: sender.label,
          timestamp: resolveTimestampMs(message.timestamp),
        } satisfies HistoryEntry)
      : undefined;

  const threadOwnerId = threadChannel ? (threadChannel.ownerId ?? channelInfo?.ownerId) : undefined;
  const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
    botId,
    channelConfig,
    guildInfo,
    isGuildMessage,
    isThread: Boolean(threadChannel),
    threadOwnerId,
  });
  const shouldRequireMention = resolvePreflightMentionRequirement({
    bypassMentionRequirement,
    shouldRequireMention: shouldRequireMentionByConfig,
  });
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    allowNameMatching,
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
  });

  if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
    logDebug(`[discord-preflight] drop: member not allowed`);
    // Keep stable Discord user IDs out of routine deny-path logs.
    logVerbose("Blocked discord guild sender (not in users/roles allowlist)");
    return null;
  }

  // Only authorized guild senders should reach the expensive transcription path.
  const { resolveDiscordPreflightAudioMentionContext } = await loadPreflightAudioRuntime();
  const { hasTypedText, transcript: preflightTranscript } =
    await resolveDiscordPreflightAudioMentionContext({
      abortSignal: params.abortSignal,
      cfg: params.cfg,
      isDirectMessage,
      mentionRegexes,
      message,
      shouldRequireMention,
    });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const mentionText = hasTypedText ? baseText : "";
  const { implicitMentionKinds, wasMentioned } = resolveDiscordMentionState({
    authorIsBot: Boolean(author.bot),
    botId,
    hasAnyMention,
    isDirectMessage,
    isExplicitlyMentioned: explicitlyMentioned,
    mentionRegexes,
    mentionText,
    mentionedEveryone: Boolean(message.mentionedEveryone),
    referencedAuthorId: message.referencedMessage?.author?.id,
    senderIsPluralKit: sender.isPluralKit,
    transcript: preflightTranscript,
  });
  if (shouldLogVerbose()) {
    logVerbose(
      `discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${messageChannelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
    );
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);

  if (!isDirectMessage) {
    const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
      allowFrom: params.allowFrom,
      allowNameMatching,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
    });
    const commandGate = resolveControlCommandGate({
      allowTextCommands,
      authorizers: [
        { allowed: ownerOk, configured: ownerAllowList != null },
        { allowed: memberAllowed, configured: hasAccessRestrictions },
      ],
      hasControlCommand: hasControlCommandInMessage,
      modeWhenAccessGroupsOff: "configured",
      useAccessGroups,
    });
    ({ commandAuthorized } = commandGate);

    if (commandGate.shouldBlock) {
      logInboundDrop({
        channel: "discord",
        log: logVerbose,
        reason: "control command (unauthorized)",
        target: sender.id,
      });
      return null;
    }
  }

  const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      hasAnyMention,
      implicitMentionKinds,
      wasMentioned,
    },
    policy: {
      allowTextCommands,
      commandAuthorized,
      hasControlCommand: hasControlCommandInMessage,
      isGroup: isGuildMessage,
      requireMention: Boolean(shouldRequireMention),
    },
  });
  const { effectiveWasMentioned } = mentionDecision;
  logDebug(
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionDecision.shouldSkip=${mentionDecision.shouldSkip} wasMentioned=${wasMentioned}`,
  );
  if (isGuildMessage && shouldRequireMention) {
    if (botId && mentionDecision.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
      logger.info(
        {
          channelId: messageChannelId,
          reason: "no-mention",
        },
        "discord: skipping guild message",
      );
      recordPendingHistoryEntryIfEnabled({
        entry: historyEntry ?? null,
        historyKey: messageChannelId,
        historyMap: params.guildHistories,
        limit: params.historyLimit,
      });
      return null;
    }
  }

  if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
    const botMentioned = isDirectMessage || wasMentioned || mentionDecision.implicitMention;
    if (!botMentioned) {
      logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
      logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }

  const ignoreOtherMentions =
    channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
  if (
    isGuildMessage &&
    ignoreOtherMentions &&
    hasUserOrRoleMention &&
    !wasMentioned &&
    !mentionDecision.implicitMention
  ) {
    logDebug(`[discord-preflight] drop: other-mention`);
    logVerbose(
      `discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`,
    );
    recordPendingHistoryEntryIfEnabled({
      entry: historyEntry ?? null,
      historyKey: messageChannelId,
      historyMap: params.guildHistories,
      limit: params.historyLimit,
    });
    return null;
  }

  const systemLocation = resolveDiscordSystemLocation({
    channelName: channelName ?? messageChannelId,
    guild: params.data.guild ?? undefined,
    isDirectMessage,
    isGroupDm,
  });
  const { resolveDiscordSystemEvent } = await loadSystemEventsRuntime();
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    enqueueSystemEvent(systemText, {
      contextKey: `discord:system:${messageChannelId}:${message.id}`,
      sessionKey: effectiveRoute.sessionKey,
    });
    return null;
  }

  if (!messageText) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }
  if (configuredBinding) {
    const ensured = await conversationRuntime.ensureConfiguredBindingRouteReady({
      bindingResolution: configuredBinding,
      cfg: freshCfg,
    });
    if (!ensured.ok) {
      logVerbose(
        `discord: configured ACP binding unavailable for channel ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
      );
      return null;
    }
  }

  logDebug(
    `[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`,
  );
  return {
    abortSignal: params.abortSignal,
    accountId: params.accountId,
    ackReactionScope: params.ackReactionScope,
    allowTextCommands,
    author,
    baseSessionKey,
    baseText,
    botUserId: params.botUserId,
    boundAgentId,
    boundSessionKey: boundSessionKey || undefined,
    canDetectMention,
    cfg: params.cfg,
    channelAllowed,
    channelAllowlistConfigured,
    channelConfig,
    channelInfo,
    channelName,
    client: params.client,
    commandAuthorized,
    configChannelName,
    configChannelSlug,
    data,
    discordConfig: params.discordConfig,
    discordRestFetch: params.discordRestFetch,
    displayChannelName,
    displayChannelSlug,
    effectiveWasMentioned,
    groupPolicy: params.groupPolicy,
    guildHistories: params.guildHistories,
    guildInfo,
    guildSlug,
    hasAnyMention,
    historyEntry,
    historyLimit: params.historyLimit,
    isDirectMessage,
    isGroupDm,
    isGuildMessage,
    mediaMaxBytes: params.mediaMaxBytes,
    message,
    messageChannelId,
    messageText,
    replyToMode: params.replyToMode,
    route: effectiveRoute,
    runtime: params.runtime,
    sender,
    shouldBypassMention: mentionDecision.shouldBypassMention,
    shouldRequireMention,
    textLimit: params.textLimit,
    threadBinding,
    threadBindings: params.threadBindings,
    threadChannel,
    threadName,
    threadParentId,
    threadParentName,
    threadParentType,
    token: params.token,
    wasMentioned,
  };
}
