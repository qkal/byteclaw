import type { IncomingMessage, ServerResponse } from "node:http";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ResolvedZaloAccount } from "./accounts.js";
import {
  ZaloApiError,
  type ZaloFetch,
  type ZaloMessage,
  type ZaloUpdate,
  deleteWebhook,
  getUpdates,
  getWebhookInfo,
  sendChatAction,
  sendMessage,
  sendPhoto,
  setWebhook,
} from "./api.js";
import {
  evaluateZaloGroupAccess,
  isZaloSenderAllowed,
  resolveZaloRuntimeGroupPolicy,
} from "./group-access.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import {
  createChannelPairingController,
  createChannelReplyPipeline,
  deliverTextOrMediaReply,
  logTypingFailure,
  resolveDefaultGroupPolicy,
  resolveDirectDmAuthorizationOutcome,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveSenderCommandAuthorizationWithRuntime,
  resolveWebhookPath,
  waitForAbortSignal,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./runtime-api.js";
import { getZaloRuntime } from "./runtime.js";
export type { ZaloRuntimeEnv } from "./monitor.types.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";

export interface ZaloMonitorOptions {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  abortSignal: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  fetcher?: ZaloFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

const ZALO_TEXT_LIMIT = 2000;
const DEFAULT_MEDIA_MAX_MB = 5;
const WEBHOOK_CLEANUP_TIMEOUT_MS = 5000;
const ZALO_TYPING_TIMEOUT_MS = 5000;

type ZaloCoreRuntime = ReturnType<typeof getZaloRuntime>;
type ZaloStatusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
interface ZaloProcessingContext {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  statusSink?: ZaloStatusSink;
  fetcher?: ZaloFetch;
}
type ZaloPollingLoopParams = ZaloProcessingContext & {
  abortSignal: AbortSignal;
  isStopped: () => boolean;
  mediaMaxMb: number;
};
type ZaloUpdateProcessingParams = ZaloProcessingContext & {
  update: ZaloUpdate;
  mediaMaxMb: number;
};
type ZaloMessagePipelineParams = ZaloProcessingContext & {
  message: ZaloMessage;
  text?: string;
  mediaPath?: string;
  mediaType?: string;
  authorization?: ZaloMessageAuthorizationResult;
};
type ZaloImageMessageParams = ZaloProcessingContext & {
  message: ZaloMessage;
  mediaMaxMb: number;
};
interface ZaloMessageAuthorizationResult {
  chatId: string;
  commandAuthorized: boolean | undefined;
  isGroup: boolean;
  rawBody: string;
  senderId: string;
  senderName: string | undefined;
}

function formatZaloError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

function describeWebhookTarget(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl;
  }
}

function normalizeWebhookUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function logVerbose(core: ZaloCoreRuntime, runtime: ZaloRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[zalo] ${message}`);
  }
}

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const { handleZaloWebhookRequest: handleZaloWebhookRequestInternal } =
    await import("./monitor.webhook.js");
  return await handleZaloWebhookRequestInternal(req, res, async ({ update, target }) => {
    await processUpdate({
      account: target.account,
      config: target.config,
      core: target.core as ZaloCoreRuntime,
      fetcher: target.fetcher,
      mediaMaxMb: target.mediaMaxMb,
      runtime: target.runtime,
      statusSink: target.statusSink,
      token: target.token,
      update,
    });
  });
}

function startPollingLoop(params: ZaloPollingLoopParams) {
  const {
    token,
    account,
    config,
    runtime,
    core,
    abortSignal,
    isStopped,
    mediaMaxMb,
    statusSink,
    fetcher,
  } = params;
  const pollTimeout = 30;
  const processingContext = {
    account,
    config,
    core,
    fetcher,
    mediaMaxMb,
    runtime,
    statusSink,
    token,
  };

  runtime.log?.(`[${account.accountId}] Zalo polling loop started timeout=${String(pollTimeout)}s`);

  const poll = async () => {
    if (isStopped() || abortSignal.aborted) {
      return;
    }

    try {
      const response = await getUpdates(token, { timeout: pollTimeout }, fetcher);
      if (response.ok && response.result) {
        statusSink?.({ lastInboundAt: Date.now() });
        await processUpdate({
          update: response.result,
          ...processingContext,
        });
      }
    } catch (error) {
      if (error instanceof ZaloApiError && error.isPollingTimeout) {
        // No updates
      } else if (!isStopped() && !abortSignal.aborted) {
        runtime.error?.(`[${account.accountId}] Zalo polling error: ${formatZaloError(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    if (!isStopped() && !abortSignal.aborted) {
      setImmediate(poll);
    }
  };

  void poll();
}

async function processUpdate(params: ZaloUpdateProcessingParams): Promise<void> {
  const { update, token, account, config, runtime, core, mediaMaxMb, statusSink, fetcher } = params;
  const { event_name, message } = update;
  const sharedContext = { account, config, core, fetcher, runtime, statusSink, token };
  if (!message) {
    return;
  }

  switch (event_name) {
    case "message.text.received": {
      await handleTextMessage({
        message,
        ...sharedContext,
      });
      break;
    }
    case "message.image.received": {
      await handleImageMessage({
        message,
        ...sharedContext,
        mediaMaxMb,
      });
      break;
    }
    case "message.sticker.received": {
      logVerbose(core, runtime, `[${account.accountId}] Received sticker from ${message.from.id}`);
      break;
    }
    case "message.unsupported.received": {
      logVerbose(
        core,
        runtime,
        `[${account.accountId}] Received unsupported message type from ${message.from.id}`,
      );
      break;
    }
  }
}

async function handleTextMessage(
  params: ZaloProcessingContext & { message: ZaloMessage },
): Promise<void> {
  const { message } = params;
  const { text } = message;
  if (!text?.trim()) {
    return;
  }

  await processMessageWithPipeline({
    ...params,
    mediaPath: undefined,
    mediaType: undefined,
    text,
  });
}

async function handleImageMessage(params: ZaloImageMessageParams): Promise<void> {
  const { message, mediaMaxMb, account, core, runtime } = params;
  const { photo_url, caption } = message;
  const authorization = await authorizeZaloMessage({
    ...params,
    text: caption,
    // Use a sentinel so auth sees this as an inbound image before the download happens.
    mediaPath: photo_url ? "__pending_media__" : undefined,
    mediaType: undefined,
  });
  if (!authorization) {
    return;
  }

  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (photo_url) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await core.channel.media.fetchRemoteMedia({ maxBytes, url: photo_url });
      const saved = await core.channel.media.saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (error) {
      runtime.error?.(`[${account.accountId}] Failed to download Zalo image: ${String(error)}`);
    }
  }

  await processMessageWithPipeline({
    ...params,
    authorization,
    mediaPath,
    mediaType,
    text: caption,
  });
}

async function authorizeZaloMessage(
  params: ZaloMessagePipelineParams,
): Promise<ZaloMessageAuthorizationResult | undefined> {
  const { message, account, config, runtime, core, text, mediaPath, token, statusSink, fetcher } =
    params;
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "zalo",
    core,
  });
  const { from, chat } = message;

  const isGroup = chat.chat_type === "GROUP";
  const chatId = chat.id;
  const senderId = from.id;
  const senderName = from.display_name ?? from.name;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const configuredGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
  const groupAllowFrom =
    configuredGroupAllowFrom.length > 0 ? configuredGroupAllowFrom : configAllowFrom;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const groupAccess = isGroup
    ? evaluateZaloGroupAccess({
        configuredGroupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
        groupAllowFrom,
        providerConfigPresent: config.channels?.zalo !== undefined,
        senderId,
      })
    : undefined;
  if (groupAccess) {
    warnMissingProviderGroupPolicyFallbackOnce({
      accountId: account.accountId,
      log: (message) => logVerbose(core, runtime, message),
      providerKey: "zalo",
      providerMissingFallbackApplied: groupAccess.providerMissingFallbackApplied,
    });
    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        logVerbose(core, runtime, `zalo: drop group ${chatId} (groupPolicy=disabled)`);
      } else if (groupAccess.reason === "empty_allowlist") {
        logVerbose(
          core,
          runtime,
          `zalo: drop group ${chatId} (groupPolicy=allowlist, no groupAllowFrom)`,
        );
      } else if (groupAccess.reason === "sender_not_allowlisted") {
        logVerbose(core, runtime, `zalo: drop group sender ${senderId} (groupPolicy=allowlist)`);
      }
      return;
    }
  }

  const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: config,
      configuredAllowFrom: configAllowFrom,
      configuredGroupAllowFrom: groupAllowFrom,
      dmPolicy,
      isGroup,
      isSenderAllowed: isZaloSenderAllowed,
      rawBody,
      readAllowFromStore: pairing.readAllowFromStore,
      runtime: core.channel.commands,
      senderId,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    dmPolicy,
    isGroup,
    senderAllowedForCommands,
  });
  if (directDmOutcome === "disabled") {
    logVerbose(core, runtime, `Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
    return;
  }
  if (directDmOutcome === "unauthorized") {
    if (dmPolicy === "pairing") {
      await pairing.issueChallenge({
        meta: { name: senderName ?? undefined },
        onCreated: () => {
          logVerbose(core, runtime, `zalo pairing request sender=${senderId}`);
        },
        onReplyError: (err) => {
          logVerbose(core, runtime, `zalo pairing reply failed for ${senderId}: ${String(err)}`);
        },
        sendPairingReply: async (text) => {
          await sendMessage(
            token,
            {
              chat_id: chatId,
              text,
            },
            fetcher,
          );
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        senderId,
        senderIdLine: `Your Zalo user id: ${senderId}`,
      });
    } else {
      logVerbose(
        core,
        runtime,
        `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return;
  }

  return {
    chatId,
    commandAuthorized,
    isGroup,
    rawBody,
    senderId,
    senderName,
  };
}

async function processMessageWithPipeline(params: ZaloMessagePipelineParams): Promise<void> {
  const {
    message,
    token,
    account,
    config,
    runtime,
    core,
    mediaPath,
    mediaType,
    statusSink,
    fetcher,
    authorization: authorizationOverride,
  } = params;
  const { message_id, date } = message;
  const authorization =
    authorizationOverride ??
    (await authorizeZaloMessage({
      ...params,
      mediaPath,
      mediaType,
    }));
  if (!authorization) {
    return;
  }
  const { isGroup, chatId, senderId, senderName, rawBody, commandAuthorized } = authorization;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    accountId: account.accountId,
    cfg: config,
    channel: "zalo",
    peer: {
      id: chatId,
      kind: isGroup ? ("group" as const) : ("direct" as const),
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `zalo: drop control command from unauthorized sender ${senderId}`);
    return;
  }

  const fromLabel = isGroup ? `group:${chatId}` : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    body: rawBody,
    channel: "Zalo",
    from: fromLabel,
    timestamp: date ? date * 1000 : undefined,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: body,
    BodyForAgent: rawBody,
    ChatType: isGroup ? "group" : "direct",
    CommandAuthorized: commandAuthorized,
    CommandBody: rawBody,
    ConversationLabel: fromLabel,
    From: isGroup ? `zalo:group:${chatId}` : `zalo:${senderId}`,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    MessageSid: message_id,
    OriginatingChannel: "zalo",
    OriginatingTo: `zalo:${chatId}`,
    Provider: "zalo",
    RawBody: rawBody,
    SenderId: senderId,
    SenderName: senderName || undefined,
    SessionKey: route.sessionKey,
    Surface: "zalo",
    To: `zalo:${chatId}`,
  });

  await core.channel.session.recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`zalo: failed updating session meta: ${String(err)}`);
    },
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    storePath,
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    accountId: account.accountId,
    cfg: config,
    channel: "zalo",
  });
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: account.accountId,
    agentId: route.agentId,
    cfg: config,
    channel: "zalo",
    typing: {
      onStartError: (err) => {
        logTypingFailure({
          action: "start",
          channel: "zalo",
          error: err,
          log: (message) => logVerbose(core, runtime, message),
          target: chatId,
        });
      },
      start: async () => {
        await sendChatAction(
          token,
          {
            action: "typing",
            chat_id: chatId,
          },
          fetcher,
          ZALO_TYPING_TIMEOUT_MS,
        );
      },
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    cfg: config,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        await deliverZaloReply({
          accountId: account.accountId,
          chatId,
          config,
          core,
          fetcher,
          payload,
          runtime,
          statusSink,
          tableMode,
          token,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Zalo ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function deliverZaloReply(params: {
  payload: OutboundReplyPayload;
  token: string;
  chatId: string;
  runtime: ZaloRuntimeEnv;
  core: ZaloCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  statusSink?: ZaloStatusSink;
  fetcher?: ZaloFetch;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, token, chatId, runtime, core, config, accountId, statusSink, fetcher } = params;
  const tableMode = params.tableMode ?? "code";
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "zalo", accountId);
  await deliverTextOrMediaReply({
    chunkText: (value) =>
      core.channel.text.chunkMarkdownTextWithMode(value, ZALO_TEXT_LIMIT, chunkMode),
    onMediaError: (error) => {
      runtime.error?.(
        `Zalo photo send failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    },
    payload,
    sendMedia: async ({ mediaUrl, caption }) => {
      await sendPhoto(token, { caption, chat_id: chatId, photo: mediaUrl }, fetcher);
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    sendText: async (chunk) => {
      try {
        await sendMessage(token, { chat_id: chatId, text: chunk }, fetcher);
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (error) {
        runtime.error?.(`Zalo message send failed: ${String(error)}`);
      }
    },
    text: reply.text,
  });
}

export async function monitorZaloProvider(options: ZaloMonitorOptions): Promise<void> {
  const {
    token,
    account,
    config,
    runtime,
    abortSignal,
    useWebhook,
    webhookUrl,
    webhookSecret,
    webhookPath,
    statusSink,
    fetcher: fetcherOverride,
  } = options;

  const core = getZaloRuntime();
  const effectiveMediaMaxMb = account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const fetcher = fetcherOverride ?? resolveZaloProxyFetch(account.config.proxy);
  const mode = useWebhook ? "webhook" : "polling";

  let stopped = false;
  const stopHandlers: (() => void)[] = [];
  let cleanupWebhook: (() => Promise<void>) | undefined;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const handler of stopHandlers) {
      handler();
    }
  };

  runtime.log?.(
    `[${account.accountId}] Zalo provider init mode=${mode} mediaMaxMb=${String(effectiveMediaMaxMb)}`,
  );

  try {
    if (useWebhook) {
      const { registerZaloWebhookTarget } = await import("./monitor.webhook.js");
      if (!webhookUrl || !webhookSecret) {
        throw new Error("Zalo webhookUrl and webhookSecret are required for webhook mode");
      }
      if (!webhookUrl.startsWith("https://")) {
        throw new Error("Zalo webhook URL must use HTTPS");
      }
      if (webhookSecret.length < 8 || webhookSecret.length > 256) {
        throw new Error("Zalo webhook secret must be 8-256 characters");
      }

      const path = resolveWebhookPath({ defaultPath: null, webhookPath, webhookUrl });
      if (!path) {
        throw new Error("Zalo webhookPath could not be derived");
      }

      runtime.log?.(
        `[${account.accountId}] Zalo configuring webhook path=${path} target=${describeWebhookTarget(webhookUrl)}`,
      );
      await setWebhook(token, { secret_token: webhookSecret, url: webhookUrl }, fetcher);
      let webhookCleanupPromise: Promise<void> | undefined;
      cleanupWebhook = async () => {
        if (!webhookCleanupPromise) {
          webhookCleanupPromise = (async () => {
            runtime.log?.(`[${account.accountId}] Zalo stopping; deleting webhook`);
            try {
              await deleteWebhook(token, fetcher, WEBHOOK_CLEANUP_TIMEOUT_MS);
              runtime.log?.(`[${account.accountId}] Zalo webhook deleted`);
            } catch (error) {
              const detail =
                error instanceof Error && error.name === "AbortError"
                  ? `timed out after ${String(WEBHOOK_CLEANUP_TIMEOUT_MS)}ms`
                  : formatZaloError(error);
              runtime.error?.(`[${account.accountId}] Zalo webhook delete failed: ${detail}`);
            }
          })();
        }
        await webhookCleanupPromise;
      };
      runtime.log?.(`[${account.accountId}] Zalo webhook registered path=${path}`);

      const unregister = registerZaloWebhookTarget(
        {
          account,
          config,
          core,
          fetcher,
          mediaMaxMb: effectiveMediaMaxMb,
          path,
          runtime,
          secret: webhookSecret,
          statusSink: (patch) => statusSink?.(patch),
          token,
        },
        {
          route: {
            accountId: account.accountId,
            auth: "plugin",
            handler: async (req, res) => {
              const handled = await handleZaloWebhookRequest(req, res);
              if (!handled && !res.headersSent) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Not Found");
              }
            },
            log: runtime.log,
            match: "exact",
            pluginId: "zalo",
            source: "zalo-webhook",
          },
        },
      );
      stopHandlers.push(unregister);
      await waitForAbortSignal(abortSignal);
      return;
    }

    runtime.log?.(`[${account.accountId}] Zalo polling mode: clearing webhook before startup`);
    try {
      try {
        const currentWebhookUrl = normalizeWebhookUrl(
          (await getWebhookInfo(token, fetcher)).result?.url,
        );
        if (!currentWebhookUrl) {
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (no webhook configured)`);
        } else {
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode disabling existing webhook ${describeWebhookTarget(currentWebhookUrl)}`,
          );
          await deleteWebhook(token, fetcher);
          runtime.log?.(`[${account.accountId}] Zalo polling mode ready (webhook disabled)`);
        }
      } catch (error) {
        if (error instanceof ZaloApiError && error.errorCode === 404) {
          // Some Zalo environments do not expose webhook inspection for polling bots.
          runtime.log?.(
            `[${account.accountId}] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup`,
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      runtime.error?.(
        `[${account.accountId}] Zalo polling startup could not clear webhook: ${formatZaloError(error)}`,
      );
    }

    startPollingLoop({
      abortSignal,
      account,
      config,
      core,
      fetcher,
      isStopped: () => stopped,
      mediaMaxMb: effectiveMediaMaxMb,
      runtime,
      statusSink,
      token,
    });

    await waitForAbortSignal(abortSignal);
  } catch (error) {
    runtime.error?.(
      `[${account.accountId}] Zalo provider startup failed mode=${mode}: ${formatZaloError(error)}`,
    );
    throw error;
  } finally {
    await cleanupWebhook?.();
    stop();
    runtime.log?.(`[${account.accountId}] Zalo provider stopped mode=${mode}`);
  }
}

export const __testing = {
  evaluateZaloGroupAccess,
  resolveZaloRuntimeGroupPolicy,
};
