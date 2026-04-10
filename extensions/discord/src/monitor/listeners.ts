import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  ThreadUpdateListener,
  type User,
} from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  createSubsystemLogger,
  danger,
  formatDurationSeconds,
  logVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";
import { normalizeDiscordListenerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type LoadedConfig = ReturnType<typeof import("openclaw/plugin-sdk/config-runtime").loadConfig>;
type RuntimeEnv = import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  runtime: RuntimeEnv;
  logger: Logger;
  onEvent?: () => void;
} & DiscordReactionRoutingParams;

interface DiscordReactionRoutingParams {
  accountId: string;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
}

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function formatListenerContextValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function formatListenerContextSuffix(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }
  const entries = Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatListenerContextValue(value);
    return formatted ? [`${key}=${formatted}`] : [];
  });
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries.join(" ")})`;
}

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
  context?: Record<string, unknown>;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    ...params.context,
    consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`,
  });
}

async function runDiscordListenerWithSlowLog(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  run: (abortSignal: AbortSignal | undefined) => Promise<void>;
  timeoutMs?: number;
  context?: Record<string, unknown>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  const timeoutMs = normalizeDiscordListenerTimeoutMs(params.timeoutMs);
  const logger = params.logger ?? discordEventQueueLog;
  let timedOut = false;

  try {
    timedOut = await runDiscordTaskWithTimeout({
      onAbortAfterTimeout: () => {
        logger.warn(
          `discord handler canceled after timeout${formatListenerContextSuffix(params.context)}`,
        );
      },
      onErrorAfterTimeout: (err) => {
        logger.error(
          danger(
            `discord handler failed after timeout: ${String(err)}${formatListenerContextSuffix(params.context)}`,
          ),
        );
      },
      onTimeout: (resolvedTimeoutMs) => {
        logger.error(
          danger(
            `discord handler timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
              decimals: 1,
              unit: "seconds",
            })}${formatListenerContextSuffix(params.context)}`,
          ),
        );
      },
      run: params.run,
      timeoutMs,
    });
    if (timedOut) {
      return;
    }
  } catch (error) {
    if (params.onError) {
      params.onError(error);
      return;
    }
    throw error;
  } finally {
    if (!timedOut) {
      logSlowDiscordListener({
        context: params.context,
        durationMs: Date.now() - startedAt,
        event: params.event,
        listener: params.listener,
        logger: params.logger,
      });
    }
  }
}

export function registerDiscordListener(listeners: object[], listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    private onEvent?: () => void,
    _options?: { timeoutMs?: number },
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    this.onEvent?.();
    // Fire-and-forget: hand off to the handler without blocking the
    // Carbon listener.  Per-session ordering and run timeouts are owned
    // By the inbound worker queue, so the listener no longer serializes
    // Or applies its own timeout.
    void Promise.resolve()
      .then(() => this.handler(data, client))
      .catch((error) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(error)}`));
      });
  }
}

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      action: "added",
      client,
      data,
      event: this.type,
      handlerParams: this.params,
      listener: this.constructor.name,
    });
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      action: "removed",
      client,
      data,
      event: this.type,
      handlerParams: this.params,
      listener: this.constructor.name,
    });
  }
}

async function runDiscordReactionHandler(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  handlerParams: DiscordReactionListenerParams;
  listener: string;
  event: string;
}): Promise<void> {
  await runDiscordListenerWithSlowLog({
    event: params.event,
    listener: params.listener,
    logger: params.handlerParams.logger,
    run: async () =>
      handleDiscordReactionEvent({
        accountId: params.handlerParams.accountId,
        action: params.action,
        allowFrom: params.handlerParams.allowFrom,
        allowNameMatching: params.handlerParams.allowNameMatching,
        botUserId: params.handlerParams.botUserId,
        cfg: params.handlerParams.cfg,
        client: params.client,
        data: params.data,
        dmEnabled: params.handlerParams.dmEnabled,
        dmPolicy: params.handlerParams.dmPolicy,
        groupDmChannels: params.handlerParams.groupDmChannels,
        groupDmEnabled: params.handlerParams.groupDmEnabled,
        groupPolicy: params.handlerParams.groupPolicy,
        guildEntries: params.handlerParams.guildEntries,
        logger: params.handlerParams.logger,
      }),
  });
}

interface DiscordReactionIngressAuthorizationParams {
  accountId: string;
  user: User;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuildMessage: boolean;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null;
  channelConfig?: import("./allow-list.js").DiscordChannelConfigResolved | null;
}

async function authorizeDiscordReactionIngress(
  params: DiscordReactionIngressAuthorizationParams,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (params.isDirectMessage && !params.dmEnabled) {
    return { allowed: false, reason: "dm-disabled" };
  }
  if (params.isGroupDm && !params.groupDmEnabled) {
    return { allowed: false, reason: "group-dm-disabled" };
  }
  if (params.isDirectMessage) {
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      accountId: params.accountId,
      dmPolicy: params.dmPolicy,
      provider: "discord",
    });
    const access = resolveDmGroupAccessWithLists({
      allowFrom: params.allowFrom,
      dmPolicy: params.dmPolicy,
      groupAllowFrom: [],
      groupPolicy: params.groupPolicy,
      isGroup: false,
      isSenderAllowed: (allowEntries) => {
        const allowList = normalizeDiscordAllowList(allowEntries, ["discord:", "user:", "pk:"]);
        const allowMatch = allowList
          ? resolveDiscordAllowListMatch({
              allowList,
              allowNameMatching: params.allowNameMatching,
              candidate: {
                id: params.user.id,
                name: params.user.username,
                tag: formatDiscordUserTag(params.user),
              },
            })
          : { allowed: false };
        return allowMatch.allowed;
      },
      storeAllowFrom,
    });
    if (access.decision !== "allow") {
      return { allowed: false, reason: access.reason };
    }
  }
  if (
    params.isGroupDm &&
    !resolveGroupDmAllow({
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
      channels: params.groupDmChannels,
    })
  ) {
    return { allowed: false, reason: "group-dm-not-allowlisted" };
  }
  if (!params.isGuildMessage) {
    return { allowed: true };
  }
  const channelAllowlistConfigured =
    Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      channelAllowed,
      channelAllowlistConfigured,
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(params.guildInfo),
    })
  ) {
    return { allowed: false, reason: "guild-policy" };
  }
  if (params.channelConfig?.allowed === false) {
    return { allowed: false, reason: "guild-channel-denied" };
  }
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    allowNameMatching: params.allowNameMatching,
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: {
      id: params.user.id,
      name: params.user.username,
      tag: formatDiscordUserTag(params.user),
    },
  });
  if (hasAccessRestrictions && !memberAllowed) {
    return { allowed: false, reason: "guild-member-denied" };
  }
  return { allowed: true };
}

async function handleDiscordReactionEvent(
  params: {
    data: DiscordReactionEvent;
    client: Client;
    action: "added" | "removed";
    cfg: LoadedConfig;
    logger: Logger;
  } & DiscordReactionRoutingParams,
) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const { user } = data;
    if (!user || user.bot) {
      return;
    }

    // Early exit: skip bot's own reactions before expensive network calls
    if (botUserId && user.id === botUserId) {
      return;
    }

    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage
      ? resolveDiscordGuildEntry({
          guild: data.guild ?? undefined,
          guildEntries,
          guildId: data.guild_id ?? undefined,
        })
      : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    const memberRoleIds = Array.isArray(data.rawMember?.roles)
      ? data.rawMember.roles.map((roleId: string) => String(roleId))
      : [];
    const reactionIngressBase: Omit<DiscordReactionIngressAuthorizationParams, "channelConfig"> = {
      accountId: params.accountId,
      allowFrom: params.allowFrom,
      allowNameMatching: params.allowNameMatching,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      dmEnabled: params.dmEnabled,
      dmPolicy: params.dmPolicy,
      groupDmChannels: params.groupDmChannels,
      groupDmEnabled: params.groupDmEnabled,
      groupPolicy: params.groupPolicy,
      guildInfo,
      isDirectMessage,
      isGroupDm,
      isGuildMessage,
      memberRoleIds,
      user,
    };
    // Guild reactions need resolved channel/thread config before member access
    // Can mirror the normal message preflight path.
    if (!isGuildMessage) {
      const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
      if (!ingressAccess.allowed) {
        logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
        return;
      }
    }
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
    let reactionBase: { baseText: string; contextKey: string } | null = null;
    const resolveReactionBase = () => {
      if (reactionBase) {
        return reactionBase;
      }
      const emojiLabel = formatDiscordReactionEmoji(data.emoji);
      const actorLabel = formatDiscordUserTag(user);
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name
          ? normalizeDiscordSlug(data.guild.name)
          : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${data.channel_id}`;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`;
      reactionBase = { baseText, contextKey };
      return reactionBase;
    };
    const emitReaction = (text: string, parentPeerId?: string) => {
      const { contextKey } = resolveReactionBase();
      const route = resolveAgentRoute({
        accountId: params.accountId,
        cfg: params.cfg,
        channel: "discord",
        guildId: data.guild_id ?? undefined,
        memberRoleIds,
        parentPeer: parentPeerId ? { id: parentPeerId, kind: "channel" } : undefined,
        peer: {
          id: isDirectMessage ? user.id : data.channel_id,
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
        },
      });
      enqueueSystemEvent(text, {
        contextKey,
        sessionKey: route.sessionKey,
      });
    };
    const shouldNotifyReaction = (options: {
      mode: "off" | "own" | "all" | "allowlist";
      messageAuthorId?: string;
      channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
    }) =>
      shouldEmitDiscordReactionNotification({
        allowNameMatching: params.allowNameMatching,
        botId: botUserId,
        channelConfig: options.channelConfig,
        guildInfo,
        memberRoleIds,
        messageAuthorId: options.messageAuthorId,
        mode: options.mode,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
      });
    const emitReactionWithAuthor = (message: { author?: User } | null) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const loadThreadParentInfo = async () => {
      if (!parentId) {
        return;
      }
      const parentInfo = await resolveDiscordChannelInfo(client, parentId);
      parentName = parentInfo?.name;
      parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
    };
    const resolveThreadChannelConfig = () =>
      resolveDiscordChannelConfigWithFallback({
        channelId: data.channel_id,
        channelName,
        channelSlug,
        guildInfo,
        parentId,
        parentName,
        parentSlug,
        scope: "thread",
      });
    const authorizeReactionIngressForChannel = async (
      channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>,
    ) =>
      await authorizeDiscordReactionIngress({
        ...reactionIngressBase,
        channelConfig,
      });
    const resolveThreadChannelAccess = async (channelInfo: { parentId?: string } | null) => {
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();
      const channelConfig = resolveThreadChannelConfig();
      const access = await authorizeReactionIngressForChannel(channelConfig);
      return { access, channelConfig };
    };

    // Parallelize async operations for thread channels
    if (isThreadChannel) {
      const reactionMode = guildInfo?.reactionNotifications ?? "own";

      // Early exit: skip fetching message if notifications are off
      if (reactionMode === "off") {
        return;
      }

      const channelInfoPromise = parentId
        ? Promise.resolve({ parentId })
        : resolveDiscordChannelInfo(client, data.channel_id);

      // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
      if (reactionMode === "all" || reactionMode === "allowlist") {
        const channelInfo = await channelInfoPromise;
        const { access: threadAccess, channelConfig: threadChannelConfig } =
          await resolveThreadChannelAccess(channelInfo);
        if (!threadAccess.allowed) {
          return;
        }
        if (
          !shouldNotifyReaction({
            channelConfig: threadChannelConfig,
            mode: reactionMode,
          })
        ) {
          return;
        }

        const { baseText } = resolveReactionBase();
        emitReaction(baseText, parentId);
        return;
      }

      // For "own" mode, we need to fetch the message to check the author
      const messagePromise = data.message.fetch().catch(() => null);

      const [channelInfo, message] = await Promise.all([channelInfoPromise, messagePromise]);
      const { access: threadAccess, channelConfig: threadChannelConfig } =
        await resolveThreadChannelAccess(channelInfo);
      if (!threadAccess.allowed) {
        return;
      }

      const messageAuthorId = message?.author?.id ?? undefined;
      if (
        !shouldNotifyReaction({
          channelConfig: threadChannelConfig,
          messageAuthorId,
          mode: reactionMode,
        })
      ) {
        return;
      }

      emitReactionWithAuthor(message);
      return;
    }

    // Non-thread channel path
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      channelId: data.channel_id,
      channelName,
      channelSlug,
      guildInfo,
      parentId,
      parentName,
      parentSlug,
      scope: "channel",
    });
    if (isGuildMessage) {
      const channelAccess = await authorizeReactionIngressForChannel(channelConfig);
      if (!channelAccess.allowed) {
        return;
      }
    }

    const reactionMode = guildInfo?.reactionNotifications ?? "own";

    // Early exit: skip fetching message if notifications are off
    if (reactionMode === "off") {
      return;
    }

    // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
    if (reactionMode === "all" || reactionMode === "allowlist") {
      if (!shouldNotifyReaction({ channelConfig, mode: reactionMode })) {
        return;
      }

      const { baseText } = resolveReactionBase();
      emitReaction(baseText, parentId);
      return;
    }

    // For "own" mode, we need to fetch the message to check the author
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    if (!shouldNotifyReaction({ channelConfig, messageAuthorId, mode: reactionMode })) {
      return;
    }

    emitReactionWithAuthor(message);
  } catch (error) {
    params.logger.error(danger(`discord reaction handler failed: ${String(error)}`));
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? String(data.user.id)
          : undefined;
      if (!userId) {
        return;
      }
      setPresence(
        this.accountId,
        userId,
        data as import("discord-api-types/v10").GatewayPresenceUpdate,
      );
    } catch (error) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(error)}`));
    }
  }
}

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadUpdateEvent) {
    await runDiscordListenerWithSlowLog({
      event: this.type,
      listener: this.constructor.name,
      logger: this.logger,
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
      run: async () => {
        // Discord only fires THREAD_UPDATE when a field actually changes, so
        // `thread_metadata.archived === true` in this payload means the thread
        // Just transitioned to the archived state.
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        const count = await closeDiscordThreadSessions({
          accountId: this.accountId,
          cfg: this.cfg,
          threadId,
        });
        if (count > 0) {
          logger.info("Discord thread archived — reset sessions", { count, threadId });
        }
      },
    });
  }
}
