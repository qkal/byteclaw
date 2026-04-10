import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount, resolveMattermostReplyToMode } from "./accounts.js";
import {
  type MattermostPost,
  type MattermostUser,
  createMattermostClient,
  fetchMattermostMe,
  normalizeMattermostBaseUrl,
} from "./client.js";
import {
  type MattermostInteractionResponse,
  computeInteractionCallbackUrl,
  createMattermostInteractionHandler,
  resolveInteractionCallbackPath,
  setInteractionCallbackUrl,
  setInteractionSecret,
} from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  isMattermostSenderAllowed,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
} from "./monitor-gating.js";
import {
  createDedupeCache,
  formatInboundFromLabel,
  normalizeMention,
  resolveThreadSessionKeys,
} from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import { type MattermostMediaInfo, createMattermostMonitorResources } from "./monitor-resources.js";
import { registerMattermostMonitorSlashCommands } from "./monitor-slash.js";
import {
  type MattermostEventPayload,
  type MattermostWebSocketFactory,
  createMattermostConnectOnce,
} from "./monitor-websocket.js";
import { runWithReconnect } from "./reconnect.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "./runtime-api.js";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  DM_GROUP_ACCESS_REASON,
  type HistoryEntry,
  buildAgentMediaPayload,
  buildModelsProviderData,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createChannelPairingController,
  createChannelReplyPipeline,
  isDangerousNameMatchingEnabled,
  logInboundDrop,
  logTypingFailure,
  readStoreAllowFromForDmPolicy,
  recordPendingHistoryEntryIfEnabled,
  registerPluginHttpRoute,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveChannelMediaMaxBytes,
  resolveControlCommandGate,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import { cleanupSlashCommands } from "./slash-commands.js";
import { deactivateSlashCommands, getSlashCommandState } from "./slash-state.js";

export {
  evaluateMattermostMentionGate,
  mapMattermostChannelTypeToChatType,
} from "./monitor-gating.js";
export type {
  MattermostMentionGateInput,
  MattermostRequireMentionResolverInput,
} from "./monitor-gating.js";

export interface MonitorMattermostOpts {
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  webSocketFactory?: MattermostWebSocketFactory;
}

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

interface MattermostReaction {
  user_id?: string;
  post_id?: string;
  emoji_name?: string;
  create_at?: number;
}
const RECENT_MATTERMOST_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MATTERMOST_MESSAGE_MAX = 2000;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeInteractionSourceIps(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value));
}

const recentInboundMessages = createDedupeCache({
  maxSize: RECENT_MATTERMOST_MESSAGE_MAX,
  ttlMs: RECENT_MATTERMOST_MESSAGE_TTL_MS,
});

function resolveRuntime(opts: MonitorMattermostOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
      log: console.log,
    }
  );
}

function isSystemPost(post: MattermostPost): boolean {
  return normalizeOptionalString(post.type) !== undefined;
}

function channelChatType(kind: ChatType): "direct" | "group" | "channel" {
  if (kind === "direct") {
    return "direct";
  }
  if (kind === "group") {
    return "group";
  }
  return "channel";
}

export function resolveMattermostReplyRootId(params: {
  threadRootId?: string;
  replyToId?: string;
}): string | undefined {
  const threadRootId = normalizeOptionalString(params.threadRootId);
  if (threadRootId) {
    return threadRootId;
  }
  return normalizeOptionalString(params.replyToId);
}

export function resolveMattermostEffectiveReplyToId(params: {
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): string | undefined {
  const threadRootId = normalizeOptionalString(params.threadRootId);
  if (threadRootId && params.replyToMode !== "off") {
    return threadRootId;
  }
  if (params.kind === "direct") {
    return undefined;
  }
  const postId = normalizeOptionalString(params.postId);
  if (!postId) {
    return undefined;
  }
  return params.replyToMode === "all" ||
    params.replyToMode === "first" ||
    params.replyToMode === "batched"
    ? postId
    : undefined;
}

export function resolveMattermostThreadSessionContext(params: {
  baseSessionKey: string;
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): { effectiveReplyToId?: string; sessionKey: string; parentSessionKey?: string } {
  const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
    kind: params.kind,
    postId: params.postId,
    replyToMode: params.replyToMode,
    threadRootId: params.threadRootId,
  });
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    parentSessionKey: effectiveReplyToId ? params.baseSessionKey : undefined,
    threadId: effectiveReplyToId,
  });
  return {
    effectiveReplyToId,
    parentSessionKey: threadKeys.parentSessionKey,
    sessionKey: threadKeys.sessionKey,
  };
}

export function resolveMattermostReactionChannelId(
  payload: Pick<MattermostEventPayload, "broadcast" | "data">,
): string | undefined {
  return (
    normalizeOptionalString(payload.broadcast?.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id)
  );
}

function buildMattermostAttachmentPlaceholder(mediaList: MattermostMediaInfo[]): string {
  if (mediaList.length === 0) {
    return "";
  }
  if (mediaList.length === 1) {
    const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
    return `<media:${kind}>`;
  }
  const allImages = mediaList.every((media) => media.kind === "image");
  const label = allImages ? "image" : "file";
  const suffix = mediaList.length === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${mediaList.length} ${suffix})`;
}

function buildMattermostWsUrl(baseUrl: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const wsBase = normalized.replace(/^http/i, "ws");
  return `${wsBase}/api/v4/websocket`;
}

export async function monitorMattermostProvider(opts: MonitorMattermostOpts = {}): Promise<void> {
  const core = getMattermostRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    accountId: opts.accountId,
    cfg,
  });
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "mattermost",
    core,
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const botToken =
    normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
  if (!botToken) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  const client = createMattermostClient({
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    baseUrl,
    botToken,
  });

  // Wait for the Mattermost API to accept our bot token before proceeding.
  // When a bot account is disabled and re-enabled, the session is invalidated
  // And API calls return 401 until the account is fully active again.  Retrying
  // Here (with exponential backoff) keeps the monitor alive and prevents the
  // Framework's auto-restart budget from being exhausted.
  let botUser!: MattermostUser;
  await runWithReconnect(
    async () => {
      botUser = await fetchMattermostMe(client);
    },
    {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      onError: (err) => {
        runtime.error?.(`mattermost: API auth failed: ${String(err)}`);
        opts.statusSink?.({ connected: false, lastError: String(err) });
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost: API not accessible, retrying in ${Math.round(delayMs / 1000)}s`);
      },
      shouldReconnect: ({ outcome }) => outcome === "rejected",
    },
  );
  if (opts.abortSignal?.aborted) {
    return;
  }
  const botUserId = botUser.id;
  const botUsername = normalizeOptionalString(botUser.username);
  runtime.log?.(`mattermost connected as ${botUsername ? `@${botUsername}` : botUserId}`);
  await registerMattermostMonitorSlashCommands({
    account,
    baseUrl,
    botUserId,
    cfg,
    client,
    runtime,
  });
  const slashEnabled = getSlashCommandState(account.accountId) != null;

  // ─── Interactive buttons registration ──────────────────────────────────────
  // Derive a stable HMAC secret from the bot token so CLI and gateway share it.
  setInteractionSecret(account.accountId, botToken);

  // Register HTTP callback endpoint for interactive button clicks.
  // Mattermost POSTs to this URL when a user clicks a button action.
  const interactionPath = resolveInteractionCallbackPath(account.accountId);
  // Recompute from config on each monitor start so reconnects or config reloads can refresh the
  // Cached callback URL for downstream callers such as `message action=send`.
  const callbackUrl = computeInteractionCallbackUrl(account.accountId, {
    gateway: cfg.gateway,
    interactions: account.config.interactions,
  });
  setInteractionCallbackUrl(account.accountId, callbackUrl);
  const allowedInteractionSourceIps = normalizeInteractionSourceIps(
    account.config.interactions?.allowedSourceIps,
  );

  try {
    const mmHost = new URL(baseUrl).hostname;
    const callbackHost = new URL(callbackUrl).hostname;
    if (isLoopbackHost(callbackHost) && !isLoopbackHost(mmHost)) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} (loopback) while baseUrl is ${baseUrl}. This MAY be unreachable depending on your deployment. If button clicks don't work, set channels.mattermost.interactions.callbackBaseUrl to a URL reachable from the Mattermost server (e.g. your public reverse proxy URL).`,
      );
    }
    if (!isLoopbackHost(callbackHost) && allowedInteractionSourceIps.length === 0) {
      runtime.error?.(
        `mattermost: interactions callbackUrl resolved to ${callbackUrl} without channels.mattermost.interactions.allowedSourceIps. For safety, non-loopback callback sources will be rejected until you allowlist the Mattermost server or trusted ingress IPs.`,
      );
    }
  } catch {
    // URL parse failed; ignore and continue (we will fail naturally if callbacks cannot be delivered).
  }

  const effectiveInteractionSourceIps =
    allowedInteractionSourceIps.length > 0 ? allowedInteractionSourceIps : ["127.0.0.1", "::1"];

  const unregisterInteractions = registerPluginHttpRoute({
    accountId: account.accountId,
    auth: "plugin",
    fallbackPath: "/mattermost/interactions/default",
    handler: createMattermostInteractionHandler({
      accountId: account.accountId,
      allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
      allowedSourceIps: effectiveInteractionSourceIps,
      authorizeButtonClick: async ({ payload, post }) => {
        const channelInfo = await resolveChannelInfo(payload.channel_id);
        const isDirect = channelInfo?.type?.trim().toUpperCase() === "D";
        const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
          cfg,
          surface: "mattermost",
        });
        const decision = authorizeMattermostCommandInvocation({
          account,
          cfg,
          senderId: payload.user_id,
          senderName: payload.user_name ?? "",
          channelId: payload.channel_id,
          channelInfo,
          storeAllowFrom: isDirect
            ? await readStoreAllowFromForDmPolicy({
                provider: "mattermost",
                accountId: account.accountId,
                dmPolicy: account.config.dmPolicy ?? "pairing",
                readStore: pairing.readStoreForDmPolicy,
              })
            : undefined,
          allowTextCommands,
          hasControlCommand: false,
        });
        if (decision.ok) {
          return { ok: true };
        }
        return {
          ok: false,
          response: {
            update: {
              message: post.message ?? "",
              props: post.props ?? undefined,
            },
            ephemeral_text: `OpenClaw ignored this action for ${decision.roomLabel}.`,
          },
        };
      },
      botUserId,
      client,
      dispatchButtonClick: async (opts) => {
        const channelInfo = await resolveChannelInfo(opts.channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const chatType = channelChatType(kind);
        const teamId = channelInfo?.team_id ?? undefined;
        const channelName = channelInfo?.name ?? undefined;
        const channelDisplay = channelInfo?.display_name ?? channelName ?? opts.channelId;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? opts.userId : opts.channelId,
          },
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        const threadContext = resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: opts.post.id || opts.postId,
          replyToMode,
          threadRootId: opts.post.root_id,
        });
        const to = kind === "direct" ? `user:${opts.userId}` : `channel:${opts.channelId}`;
        const bodyText = `[Button click: user @${opts.userName} selected "${opts.actionName}"]`;
        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: bodyText,
          BodyForAgent: bodyText,
          RawBody: bodyText,
          CommandBody: bodyText,
          From:
            kind === "direct"
              ? `mattermost:${opts.userId}`
              : kind === "group"
                ? `mattermost:group:${opts.channelId}`
                : `mattermost:channel:${opts.channelId}`,
          To: to,
          SessionKey: threadContext.sessionKey,
          ParentSessionKey: threadContext.parentSessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: `mattermost:${opts.userName}`,
          GroupSubject: kind !== "direct" ? channelDisplay : undefined,
          GroupChannel: channelName ? `#${channelName}` : undefined,
          GroupSpace: teamId,
          SenderName: opts.userName,
          SenderId: opts.userId,
          Provider: "mattermost" as const,
          Surface: "mattermost" as const,
          MessageSid: `interaction:${opts.postId}:${opts.actionId}`,
          ReplyToId: threadContext.effectiveReplyToId,
          MessageThreadId: threadContext.effectiveReplyToId,
          WasMentioned: true,
          CommandAuthorized: false,
          OriginatingChannel: "mattermost" as const,
          OriginatingTo: to,
        });

        const textLimit = core.channel.text.resolveTextChunkLimit(
          cfg,
          "mattermost",
          account.accountId,
          { fallbackLimit: account.textChunkLimit ?? 4000 },
        );
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
        });
        const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
          cfg,
          agentId: route.agentId,
          channel: "mattermost",
          accountId: account.accountId,
          typing: {
            start: () => sendTypingIndicator(opts.channelId, threadContext.effectiveReplyToId),
            onStartError: (err) => {
              logTypingFailure({
                log: (message) => logger.debug?.(message),
                channel: "mattermost",
                target: opts.channelId,
                error: err,
              });
            },
          },
        });
        const { dispatcher, replyOptions, markDispatchIdle } =
          core.channel.reply.createReplyDispatcherWithTyping({
            ...replyPipeline,
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload: ReplyPayload) => {
              await deliverMattermostReplyPayload({
                core,
                cfg,
                payload,
                to,
                accountId: account.accountId,
                agentId: route.agentId,
                replyToId: resolveMattermostReplyRootId({
                  threadRootId: threadContext.effectiveReplyToId,
                  replyToId: payload.replyToId,
                }),
                textLimit,
                tableMode,
                sendMessage: sendMessageMattermost,
              });
              runtime.log?.(`delivered button-click reply to ${to}`);
            },
            onError: (err, info) => {
              runtime.error?.(`mattermost button-click ${info.kind} reply failed: ${String(err)}`);
            },
            onReplyStart: typingCallbacks?.onReplyStart,
          });

        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        });
        markDispatchIdle();
      },
      handleInteraction: handleModelPickerInteraction,
      log: (msg) => runtime.log?.(msg),
      resolveSessionKey: async ({ channelId, userId, post }) => {
        const channelInfo = await resolveChannelInfo(channelId);
        const kind = mapMattermostChannelTypeToChatType(channelInfo?.type);
        const teamId = channelInfo?.team_id ?? undefined;
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "mattermost",
          accountId: account.accountId,
          teamId,
          peer: {
            kind,
            id: kind === "direct" ? userId : channelId,
          },
        });
        const replyToMode = resolveMattermostReplyToMode(account, kind);
        return resolveMattermostThreadSessionContext({
          baseSessionKey: route.sessionKey,
          kind,
          postId: post.id || undefined,
          replyToMode,
          threadRootId: post.root_id,
        }).sessionKey;
      },
      trustedProxies: cfg.gateway?.trustedProxies,
    }),
    log: (msg: string) => runtime.log?.(msg),
    path: interactionPath,
    pluginId: "mattermost",
    source: "mattermost-interactions",
  });

  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      accountId: account.accountId,
      cfg,
      resolveChannelLimitMb: () => undefined,
    }) ?? 8 * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: account.config.groupPolicy,
      providerConfigPresent: cfg.channels?.mattermost !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    log: (message) => logVerboseMessage(message),
    providerKey: "mattermost",
    providerMissingFallbackApplied,
  });

  const {
    resolveMattermostMedia,
    sendTypingIndicator,
    resolveChannelInfo,
    resolveUserInfo,
    updateModelPickerPost,
  } = createMattermostMonitorResources({
    accountId: account.accountId,
    callbackUrl,
    client,
    fetchRemoteMedia: (params) => core.channel.media.fetchRemoteMedia(params),
    logger: {
      debug: (message) => logger.debug?.(String(message)),
    },
    mediaKindFromMime: (contentType) => core.media.mediaKindFromMime(contentType) as MediaKind,
    mediaMaxBytes,
    saveMediaBuffer: (buffer, contentType, direction, maxBytes) =>
      core.channel.media.saveMediaBuffer(Buffer.from(buffer), contentType, direction, maxBytes),
  });

  const runModelPickerCommand = async (params: {
    commandText: string;
    commandAuthorized: boolean;
    route: ReturnType<typeof core.channel.routing.resolveAgentRoute>;
    sessionKey: string;
    parentSessionKey?: string;
    channelId: string;
    senderId: string;
    senderName: string;
    kind: ChatType;
    chatType: "direct" | "group" | "channel";
    channelName?: string;
    channelDisplay?: string;
    roomLabel: string;
    teamId?: string;
    postId: string;
    effectiveReplyToId?: string;
    deliverReplies?: boolean;
  }): Promise<string> => {
    const to = params.kind === "direct" ? `user:${params.senderId}` : `channel:${params.channelId}`;
    const fromLabel =
      params.kind === "direct"
        ? `Mattermost DM from ${params.senderName}`
        : `Mattermost message in ${params.roomLabel} from ${params.senderName}`;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      AccountId: params.route.accountId,
      Body: params.commandText,
      BodyForAgent: params.commandText,
      ChatType: params.chatType,
      CommandAuthorized: params.commandAuthorized,
      CommandBody: params.commandText,
      CommandSource: "native" as const,
      ConversationLabel: fromLabel,
      From:
        params.kind === "direct"
          ? `mattermost:${params.senderId}`
          : (params.kind === "group"
            ? `mattermost:group:${params.channelId}`
            : `mattermost:channel:${params.channelId}`),
      GroupChannel: params.channelName ? `#${params.channelName}` : undefined,
      GroupSpace: params.teamId,
      GroupSubject:
        params.kind !== "direct" ? params.channelDisplay || params.roomLabel : undefined,
      MessageSid: `interaction:${params.postId}:${Date.now()}`,
      MessageThreadId: params.effectiveReplyToId,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
      ParentSessionKey: params.parentSessionKey,
      Provider: "mattermost" as const,
      RawBody: params.commandText,
      ReplyToId: params.effectiveReplyToId,
      SenderId: params.senderId,
      SenderName: params.senderName,
      SessionKey: params.sessionKey,
      Surface: "mattermost" as const,
      Timestamp: Date.now(),
      To: to,
      WasMentioned: true,
    });

    const tableMode = core.channel.text.resolveMarkdownTableMode({
      accountId: account.accountId,
      cfg,
      channel: "mattermost",
    });
    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4000,
      },
    );
    const shouldDeliverReplies = params.deliverReplies === true;
    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      accountId: account.accountId,
      agentId: params.route.agentId,
      cfg,
      channel: "mattermost",
      typing: shouldDeliverReplies
        ? {
            onStartError: (err) => {
              logTypingFailure({
                log: (message) => logger.debug?.(message),
                channel: "mattermost",
                target: params.channelId,
                error: err,
              });
            },
            start: () => sendTypingIndicator(params.channelId, params.effectiveReplyToId),
          }
        : undefined,
    });
    const capturedTexts: string[] = [];
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...replyPipeline,
        // Picker-triggered confirmations should stay immediate.
        deliver: async (payload: ReplyPayload) => {
          const trimmedPayload = {
            ...payload,
            text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim(),
          };

          if (!shouldDeliverReplies) {
            if (trimmedPayload.text) {
              capturedTexts.push(trimmedPayload.text);
            }
            return;
          }

          await deliverMattermostReplyPayload({
            core,
            cfg,
            payload: trimmedPayload,
            to,
            accountId: account.accountId,
            agentId: params.route.agentId,
            replyToId: resolveMattermostReplyRootId({
              replyToId: trimmedPayload.replyToId,
              threadRootId: params.effectiveReplyToId,
            }),
            textLimit,
            // The picker path already converts and trims text before capture/delivery.
            tableMode: "off",
            sendMessage: sendMessageMattermost,
          });
        },
        onError: (err, info) => {
          runtime.error?.(`mattermost model picker ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks?.onReplyStart,
      });

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          cfg,
          ctx: ctxPayload,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        }),
    });

    return capturedTexts.join("\n\n").trim();
  };

  async function handleModelPickerInteraction(params: {
    payload: {
      channel_id: string;
      post_id: string;
      team_id?: string;
      user_id: string;
    };
    userName: string;
    context: Record<string, unknown>;
    post: MattermostPost;
  }): Promise<MattermostInteractionResponse | null> {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }

    if (pickerState.ownerUserId !== params.payload.user_id) {
      return {
        ephemeral_text: "Only the person who opened this picker can use it.",
      };
    }

    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText =
      pickerState.action === "select"
        ? `/model ${pickerState.provider}/${pickerState.model}`
        : (pickerState.action === "list"
          ? `/models ${pickerState.provider}`
          : "/models");
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(pickerCommandText, cfg);
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        accountId: account.accountId,
        dmPolicy,
        provider: "mattermost",
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const auth = authorizeMattermostCommandInvocation({
      account,
      allowTextCommands,
      cfg,
      channelId: params.payload.channel_id,
      channelInfo,
      hasControlCommand,
      senderId: params.payload.user_id,
      senderName: params.userName,
      storeAllowFrom,
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName },
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            code,
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
          }),
        };
      }
      const denyText =
        auth.denyReason === "unknown-channel"
          ? "Temporary error: unable to determine channel type. Please try again."
          : auth.denyReason === "dm-disabled"
            ? "This bot is not accepting direct messages."
            : auth.denyReason === "channels-disabled"
              ? "Model picker actions are disabled in channels."
              : auth.denyReason === "channel-no-allowlist"
                ? "Model picker actions are not configured for this channel."
                : "Unauthorized.";
      return {
        ephemeral_text: denyText,
      };
    }
    const {kind} = auth;
    const {chatType} = auth;
    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const channelName = auth.channelName || undefined;
    const channelDisplay = auth.channelDisplay || auth.channelName || params.payload.channel_id;
    const {roomLabel} = auth;
    const route = core.channel.routing.resolveAgentRoute({
      accountId: account.accountId,
      cfg,
      channel: "mattermost",
      peer: {
        id: kind === "direct" ? params.payload.user_id : params.payload.channel_id,
        kind,
      },
      teamId,
    });
    const replyToMode = resolveMattermostReplyToMode(account, kind);
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey: route.sessionKey,
      kind,
      postId: params.post.id || params.payload.post_id,
      replyToMode,
      threadRootId: params.post.root_id,
    });
    const modelSessionRoute = {
      agentId: route.agentId,
      sessionKey: threadContext.sessionKey,
    };

    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      return await updateModelPickerPost({
        channelId: params.payload.channel_id,
        message: "No models available.",
        postId: params.payload.post_id,
      });
    }

    if (pickerState.action === "providers" || pickerState.action === "back") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        data,
        route: modelSessionRoute,
      });
      const view = renderMattermostProviderPickerView({
        currentModel,
        data,
        ownerUserId: pickerState.ownerUserId,
      });
      return await updateModelPickerPost({
        buttons: view.buttons,
        channelId: params.payload.channel_id,
        message: view.text,
        postId: params.payload.post_id,
      });
    }

    if (pickerState.action === "list") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        data,
        route: modelSessionRoute,
      });
      const view = renderMattermostModelsPickerView({
        currentModel,
        data,
        ownerUserId: pickerState.ownerUserId,
        page: pickerState.page,
        provider: pickerState.provider,
      });
      return await updateModelPickerPost({
        buttons: view.buttons,
        channelId: params.payload.channel_id,
        message: view.text,
        postId: params.payload.post_id,
      });
    }

    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
      return {
        ephemeral_text: `That model is no longer available: ${targetModelRef}`,
      };
    }

    void (async () => {
      try {
        await runModelPickerCommand({
          channelDisplay,
          channelId: params.payload.channel_id,
          channelName,
          chatType,
          commandAuthorized: auth.commandAuthorized,
          commandText: `/model ${targetModelRef}`,
          deliverReplies: true,
          effectiveReplyToId: threadContext.effectiveReplyToId,
          kind,
          parentSessionKey: threadContext.parentSessionKey,
          postId: params.payload.post_id,
          roomLabel,
          route,
          senderId: params.payload.user_id,
          senderName: params.userName,
          sessionKey: threadContext.sessionKey,
          teamId,
        });
        const updatedModel = resolveMattermostModelPickerCurrentModel({
          cfg,
          data,
          route: modelSessionRoute,
          skipCache: true,
        });
        const view = renderMattermostModelsPickerView({
          currentModel: updatedModel,
          data,
          ownerUserId: pickerState.ownerUserId,
          page: pickerState.page,
          provider: pickerState.provider,
        });

        await updateModelPickerPost({
          buttons: view.buttons,
          channelId: params.payload.channel_id,
          message: view.text,
          postId: params.payload.post_id,
        });
      } catch (error) {
        runtime.error?.(`mattermost model picker select failed: ${String(error)}`);
      }
    })();

    return {};
  }

  const handlePost = async (
    post: MattermostPost,
    payload: MattermostEventPayload,
    messageIds?: string[],
  ) => {
    const channelId = post.channel_id ?? payload.data?.channel_id ?? payload.broadcast?.channel_id;
    if (!channelId) {
      logVerboseMessage("mattermost: drop post (missing channel id)");
      return;
    }

    const allMessageIds = messageIds?.length ? messageIds : (post.id ? [post.id] : []);
    if (allMessageIds.length === 0) {
      logVerboseMessage("mattermost: drop post (missing message id)");
      return;
    }
    const dedupeEntries = allMessageIds.map((id) =>
      recentInboundMessages.check(`${account.accountId}:${id}`),
    );
    if (dedupeEntries.length > 0 && dedupeEntries.every(Boolean)) {
      logVerboseMessage(
        `mattermost: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`,
      );
      return;
    }

    const senderId = post.user_id ?? payload.broadcast?.user_id;
    if (!senderId) {
      logVerboseMessage("mattermost: drop post (missing sender id)");
      return;
    }
    if (senderId === botUserId) {
      logVerboseMessage(`mattermost: drop post (self sender=${senderId})`);
      return;
    }
    if (isSystemPost(post)) {
      logVerboseMessage(`mattermost: drop post (system post type=${post.type ?? "unknown"})`);
      return;
    }

    const channelInfo = await resolveChannelInfo(channelId);
    const channelType = payload.data?.channel_type ?? channelInfo?.type ?? undefined;
    const kind = mapMattermostChannelTypeToChatType(channelType);
    const chatType = channelChatType(kind);

    const senderName =
      normalizeOptionalString(payload.data?.sender_name) ??
      normalizeOptionalString((await resolveUserInfo(senderId))?.username) ??
      senderId;
    const rawText = normalizeOptionalString(post.message) ?? "";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const normalizedAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
    const normalizedGroupAllowFrom = normalizeMattermostAllowList(
      account.config.groupAllowFrom ?? [],
    );
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        accountId: account.accountId,
        dmPolicy,
        provider: "mattermost",
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const accessDecision = resolveDmGroupAccessWithLists({
      allowFrom: normalizedAllowFrom,
      dmPolicy,
      groupAllowFrom: normalizedGroupAllowFrom,
      groupPolicy,
      isGroup: kind !== "direct",
      isSenderAllowed: (allowFrom) =>
        isMattermostSenderAllowed({
          allowFrom,
          allowNameMatching,
          senderId,
          senderName,
        }),
      storeAllowFrom,
    });
    const {effectiveAllowFrom} = accessDecision;
    const {effectiveGroupAllowFrom} = accessDecision;
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(rawText, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : normalizedAllowFrom;
    const senderAllowedForCommands = isMattermostSenderAllowed({
      allowFrom: commandDmAllowFrom,
      allowNameMatching,
      senderId,
      senderName,
    });
    const groupAllowedForCommands = isMattermostSenderAllowed({
      allowFrom: effectiveGroupAllowFrom,
      allowNameMatching,
      senderId,
      senderName,
    });
    const commandGate = resolveControlCommandGate({
      allowTextCommands,
      authorizers: [
        { allowed: senderAllowedForCommands, configured: commandDmAllowFrom.length > 0 },
        {
          allowed: groupAllowedForCommands,
          configured: effectiveGroupAllowFrom.length > 0,
        },
      ],
      hasControlCommand,
      useAccessGroups,
    });
    const {commandAuthorized} = commandGate;

    if (accessDecision.decision !== "allow") {
      if (kind === "direct") {
        if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
          logVerboseMessage(`mattermost: drop dm (dmPolicy=disabled sender=${senderId})`);
          return;
        }
        if (accessDecision.decision === "pairing") {
          const { code, created } = await pairing.upsertPairingRequest({
            id: senderId,
            meta: { name: senderName },
          });
          logVerboseMessage(`mattermost: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageMattermost(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "mattermost",
                  code,
                  idLine: `Your Mattermost user id: ${senderId}`,
                }),
                { accountId: account.accountId, cfg },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (error) {
              logVerboseMessage(`mattermost: pairing reply failed for ${senderId}: ${String(error)}`);
            }
          }
          return;
        }
        logVerboseMessage(`mattermost: drop dm sender=${senderId} (dmPolicy=${dmPolicy})`);
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerboseMessage("mattermost: drop group message (groupPolicy=disabled)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerboseMessage("mattermost: drop group message (no group allowlist)");
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerboseMessage(`mattermost: drop group sender=${senderId} (not in groupAllowFrom)`);
        return;
      }
      logVerboseMessage(
        `mattermost: drop group message (groupPolicy=${groupPolicy} reason=${accessDecision.reason})`,
      );
      return;
    }

    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        channel: "mattermost",
        log: logVerboseMessage,
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    const teamId = payload.data?.team_id ?? channelInfo?.team_id ?? undefined;
    const channelName = payload.data?.channel_name ?? channelInfo?.name ?? "";
    const channelDisplay =
      payload.data?.channel_display_name ?? channelInfo?.display_name ?? channelName;
    const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

    const route = core.channel.routing.resolveAgentRoute({
      accountId: account.accountId,
      cfg,
      channel: "mattermost",
      peer: {
        id: kind === "direct" ? senderId : channelId,
        kind,
      },
      teamId,
    });

    const baseSessionKey = route.sessionKey;
    const threadRootId = normalizeOptionalString(post.root_id);
    const replyToMode = resolveMattermostReplyToMode(account, kind);
    const threadContext = resolveMattermostThreadSessionContext({
      baseSessionKey,
      kind,
      postId: post.id,
      replyToMode,
      threadRootId,
    });
    const { effectiveReplyToId, sessionKey, parentSessionKey } = threadContext;
    const historyKey = kind === "direct" ? null : sessionKey;

    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" &&
      ((botUsername
        ? normalizeLowercaseStringOrEmpty(rawText).includes(
            `@${normalizeLowercaseStringOrEmpty(botUsername)}`,
          )
        : false) ||
        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
    const pendingBody =
      rawText ||
      (post.file_ids?.length
        ? `[Mattermost ${post.file_ids.length === 1 ? "file" : "files"}]`
        : "");
    const pendingSender = senderName;
    const recordPendingHistory = () => {
      const trimmed = pendingBody.trim();
      recordPendingHistoryEntryIfEnabled({
        entry:
          historyKey && trimmed
            ? {
                body: trimmed,
                messageId: post.id ?? undefined,
                sender: pendingSender,
                timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
              }
            : null,
        historyKey: historyKey ?? "",
        historyMap: channelHistories,
        limit: historyLimit,
      });
    };

    const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
    const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
    const oncharResult = oncharEnabled
      ? stripOncharPrefix(rawText, oncharPrefixes)
      : { stripped: rawText, triggered: false };
    const oncharTriggered = oncharResult.triggered;
    const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
    const mentionDecision = evaluateMattermostMentionGate({
      accountId: account.accountId,
      canDetectMention,
      cfg,
      channelId,
      commandAuthorized,
      isControlCommand,
      kind,
      oncharEnabled,
      oncharTriggered,
      requireMentionOverride: account.requireMention,
      resolveRequireMention: core.channel.groups.resolveRequireMention,
      threadRootId,
      wasMentioned,
    });
    const { shouldRequireMention, shouldBypassMention } = mentionDecision;

    if (mentionDecision.dropReason === "onchar-not-triggered") {
      logVerboseMessage(
        `mattermost: drop group message (onchar not triggered channel=${channelId} sender=${senderId})`,
      );
      recordPendingHistory();
      return;
    }

    if (mentionDecision.dropReason === "missing-mention") {
      logVerboseMessage(
        `mattermost: drop group message (missing mention channel=${channelId} sender=${senderId} requireMention=${shouldRequireMention} bypass=${shouldBypassMention} canDetectMention=${canDetectMention})`,
      );
      recordPendingHistory();
      return;
    }
    const mediaList = await resolveMattermostMedia(post.file_ids);
    const mediaPlaceholder = buildMattermostAttachmentPlaceholder(mediaList);
    const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
    const baseText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
    const bodyText = normalizeMention(baseText, botUsername);
    if (!bodyText) {
      logVerboseMessage(
        `mattermost: drop group message (empty body after normalization channel=${channelId} sender=${senderId})`,
      );
      return;
    }

    core.channel.activity.record({
      accountId: account.accountId,
      channel: "mattermost",
      direction: "inbound",
    });

    const fromLabel = formatInboundFromLabel({
      directId: senderId,
      directLabel: senderName,
      groupFallback: roomLabel || "Channel",
      groupId: channelId,
      groupLabel: channelDisplay || roomLabel,
      isGroup: kind !== "direct",
    });

    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Mattermost DM from ${senderName}`
        : `Mattermost message in ${roomLabel} from ${senderName}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      contextKey: `mattermost:message:${channelId}:${post.id ?? "unknown"}`,
      sessionKey,
    });

    const textWithId = `${bodyText}\n[mattermost message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      body: textWithId,
      channel: "Mattermost",
      chatType,
      from: fromLabel,
      sender: { id: senderId, name: senderName },
      timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
    });
    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""
            }`,
            channel: "Mattermost",
            chatType,
            from: fromLabel,
            senderLabel: entry.sender,
            timestamp: entry.timestamp,
          }),
        historyKey,
        historyMap: channelHistories,
        limit: historyLimit,
      });
    }

    const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
    const mediaPayload = buildAgentMediaPayload(mediaList);
    const commandBody = rawText.trim();
    const inboundHistory =
      historyKey && historyLimit > 0
        ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
            body: entry.body,
            sender: entry.sender,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      AccountId: route.accountId,
      Body: combinedBody,
      BodyForAgent: bodyText,
      BodyForCommands: commandBody,
      ChatType: chatType,
      CommandAuthorized: commandAuthorized,
      CommandBody: commandBody,
      ConversationLabel: fromLabel,
      From:
        kind === "direct"
          ? `mattermost:${senderId}`
          : (kind === "group"
            ? `mattermost:group:${channelId}`
            : `mattermost:channel:${channelId}`),
      GroupChannel: channelName ? `#${channelName}` : undefined,
      GroupSpace: teamId,
      GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
      InboundHistory: inboundHistory,
      MessageSid: post.id ?? undefined,
      MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
      MessageSidLast:
        allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
      MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
      MessageThreadId: effectiveReplyToId,
      OriginatingChannel: "mattermost" as const,
      OriginatingTo: to,
      ParentSessionKey: parentSessionKey,
      Provider: "mattermost" as const,
      RawBody: bodyText,
      ReplyToId: effectiveReplyToId,
      SenderId: senderId,
      SenderName: senderName,
      SessionKey: sessionKey,
      Surface: "mattermost" as const,
      Timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
      To: to,
      WasMentioned: kind !== "direct" ? mentionDecision.effectiveWasMentioned : undefined,
      ...mediaPayload,
    });

    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        deliveryContext: {
          accountId: route.accountId,
          channel: "mattermost",
          to,
        },
        sessionKey: route.mainSessionKey,
        storePath,
      });
    }

    const previewLine = bodyText.slice(0, 200).replace(/\n/g, String.raw`\n`);
    logVerboseMessage(
      `mattermost inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`,
    );

    const textLimit = core.channel.text.resolveTextChunkLimit(
      cfg,
      "mattermost",
      account.accountId,
      {
        fallbackLimit: account.textChunkLimit ?? 4000,
      },
    );
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      accountId: account.accountId,
      cfg,
      channel: "mattermost",
    });

    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      accountId: account.accountId,
      agentId: route.agentId,
      cfg,
      channel: "mattermost",
      typing: {
        onStartError: (err) => {
          logTypingFailure({
            channel: "mattermost",
            error: err,
            log: (message) => logger.debug?.(message),
            target: channelId,
          });
        },
        start: () => sendTypingIndicator(channelId, effectiveReplyToId),
      },
    });
    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...replyPipeline,
        deliver: async (payload: ReplyPayload) => {
          await deliverMattermostReplyPayload({
            accountId: account.accountId,
            agentId: route.agentId,
            cfg,
            core,
            payload,
            replyToId: resolveMattermostReplyRootId({
              threadRootId: effectiveReplyToId,
              replyToId: payload.replyToId,
            }),
            sendMessage: sendMessageMattermost,
            tableMode,
            textLimit,
            to,
          });
          runtime.log?.(`delivered reply to ${to}`);
        },
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        onError: (err, info) => {
          runtime.error?.(`mattermost ${info.kind} reply failed: ${String(err)}`);
        },
        typingCallbacks,
      });

    await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => {
        markDispatchIdle();
      },
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          cfg,
          ctx: ctxPayload,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            disableBlockStreaming:
              typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
            onModelSelected,
          },
        }),
    });
    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyKey,
        historyMap: channelHistories,
        limit: historyLimit,
      });
    }
  };

  const handleReactionEvent = async (payload: MattermostEventPayload) => {
    const reactionData = payload.data?.reaction;
    if (!reactionData) {
      return;
    }
    let reaction: MattermostReaction | null = null;
    if (typeof reactionData === "string") {
      try {
        reaction = JSON.parse(reactionData) as MattermostReaction;
      } catch {
        return;
      }
    } else if (typeof reactionData === "object") {
      reaction = reactionData as MattermostReaction;
    }
    if (!reaction) {
      return;
    }

    const userId = reaction.user_id?.trim();
    const postId = reaction.post_id?.trim();
    const emojiName = reaction.emoji_name?.trim();
    if (!userId || !postId || !emojiName) {
      return;
    }

    // Skip reactions from the bot itself
    if (userId === botUserId) {
      return;
    }

    const isRemoved = payload.event === "reaction_removed";
    const action = isRemoved ? "removed" : "added";

    const senderInfo = await resolveUserInfo(userId);
    const senderName = normalizeOptionalString(senderInfo?.username) ?? userId;

    // Resolve the channel from broadcast or post to route to the correct agent session
    const channelId = resolveMattermostReactionChannelId(payload);
    if (!channelId) {
      // Without a channel id we cannot verify DM/group policies — drop to be safe
      logVerboseMessage(
        `mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)`,
      );
      return;
    }
    const channelInfo = await resolveChannelInfo(channelId);
    if (!channelInfo?.type) {
      // Cannot determine channel type — drop to avoid policy bypass
      logVerboseMessage(`mattermost: drop reaction (cannot resolve channel type for ${channelId})`);
      return;
    }
    const kind = mapMattermostChannelTypeToChatType(channelInfo.type);

    // Enforce DM/group policy and allowlist checks (same as normal messages)
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const storeAllowFrom = normalizeMattermostAllowList(
      await readStoreAllowFromForDmPolicy({
        accountId: account.accountId,
        dmPolicy,
        provider: "mattermost",
        readStore: pairing.readStoreForDmPolicy,
      }),
    );
    const reactionAccess = resolveDmGroupAccessWithLists({
      allowFrom: normalizeMattermostAllowList(account.config.allowFrom ?? []),
      dmPolicy,
      groupAllowFrom: normalizeMattermostAllowList(account.config.groupAllowFrom ?? []),
      groupPolicy,
      isGroup: kind !== "direct",
      isSenderAllowed: (allowFrom) =>
        isMattermostSenderAllowed({
          allowFrom,
          allowNameMatching,
          senderId: userId,
          senderName,
        }),
      storeAllowFrom,
    });
    if (reactionAccess.decision !== "allow") {
      if (kind === "direct") {
        logVerboseMessage(
          `mattermost: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.reason})`,
        );
      } else {
        logVerboseMessage(
          `mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.reason} channel=${channelId})`,
        );
      }
      return;
    }

    const teamId = channelInfo?.team_id ?? undefined;
    const route = core.channel.routing.resolveAgentRoute({
      accountId: account.accountId,
      cfg,
      channel: "mattermost",
      peer: {
        id: kind === "direct" ? userId : channelId,
        kind,
      },
      teamId,
    });
    const {sessionKey} = route;

    const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;

    core.system.enqueueSystemEvent(eventText, {
      contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`,
      sessionKey,
    });

    logVerboseMessage(
      `mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`,
    );
  };

  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "mattermost",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    post: MattermostPost;
    payload: MattermostEventPayload;
  }>({
    buildKey: (entry) => {
      const channelId =
        entry.post.channel_id ??
        entry.payload.data?.channel_id ??
        entry.payload.broadcast?.channel_id;
      if (!channelId) {
        return null;
      }
      const threadId = normalizeOptionalString(entry.post.root_id);
      const threadKey = threadId ? `thread:${threadId}` : "channel";
      return `mattermost:${account.accountId}:${channelId}:${threadKey}`;
    },
    debounceMs: inboundDebounceMs,
    onError: (err) => {
      runtime.error?.(`mattermost debounce flush failed: ${String(err)}`);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handlePost(last.post, last.payload);
        return;
      }
      const combinedText = entries
        .map((entry) => normalizeOptionalString(entry.post.message) ?? "")
        .filter(Boolean)
        .join("\n");
      const mergedPost: MattermostPost = {
        ...last.post,
        file_ids: [],
        message: combinedText,
      };
      const ids = entries.map((entry) => entry.post.id).filter(Boolean);
      await handlePost(mergedPost, last.payload, ids.length > 0 ? ids : undefined);
    },
    shouldDebounce: (entry) => {
      if (entry.post.file_ids && entry.post.file_ids.length > 0) {
        return false;
      }
      const text = normalizeOptionalString(entry.post.message) ?? "";
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg);
    },
  });

  const wsUrl = buildMattermostWsUrl(baseUrl);
  let seq = 1;
  const connectOnce = createMattermostConnectOnce({
    abortSignal: opts.abortSignal,
    botToken,
    getBotUpdateAt: async () => {
      const me = await fetchMattermostMe(client);
      return me.update_at ?? 0;
    },
    nextSeq: () => seq++,
    onPosted: async (post, payload) => {
      await debouncer.enqueue({ payload, post });
    },
    onReaction: async (payload) => {
      await handleReactionEvent(payload);
    },
    runtime,
    statusSink: opts.statusSink,
    webSocketFactory: opts.webSocketFactory,
    wsUrl,
  });

  let slashShutdownCleanup: Promise<void> | null = null;

  // Clean up slash commands on shutdown
  if (slashEnabled) {
    const runAbortCleanup = () => {
      if (slashShutdownCleanup) {
        return;
      }
      // Snapshot registered commands before deactivating state.
      // This listener may run concurrently with startup in a new process, so we keep
      // Monitor shutdown alive until the remote cleanup completes.
      const commands = getSlashCommandState(account.accountId)?.registeredCommands ?? [];
      // Deactivate state immediately to prevent new local dispatches during teardown.
      deactivateSlashCommands(account.accountId);

      slashShutdownCleanup = cleanupSlashCommands({
        client,
        commands,
        log: (msg) => runtime.log?.(msg),
      }).catch((error) => {
        runtime.error?.(`mattermost: slash cleanup failed: ${String(error)}`);
      });
    };

    if (opts.abortSignal?.aborted) {
      runAbortCleanup();
    } else {
      opts.abortSignal?.addEventListener("abort", runAbortCleanup, { once: true });
    }
  }

  try {
    await runWithReconnect(connectOnce, {
      abortSignal: opts.abortSignal,
      jitterRatio: 0.2,
      onError: (err) => {
        runtime.error?.(`mattermost connection failed: ${String(err)}`);
        opts.statusSink?.({ connected: false, lastError: String(err) });
      },
      onReconnect: (delayMs) => {
        runtime.log?.(`mattermost reconnecting in ${Math.round(delayMs / 1000)}s`);
      },
    });
  } finally {
    unregisterInteractions?.();
  }

  const slashShutdownCleanupPromise = slashShutdownCleanup;
  if (slashShutdownCleanupPromise) {
    await Promise.resolve(slashShutdownCleanupPromise);
  }
}
