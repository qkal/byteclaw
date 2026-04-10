import type { IncomingMessage, ServerResponse } from "node:http";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  createChannelReplyPipeline,
  createWebhookInFlightLimiter,
  registerWebhookTargetWithPluginRoute,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveWebhookPath,
} from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  deleteGoogleChatMessage,
  downloadGoogleChatMedia,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
} from "./api.js";
import type { GoogleChatAudienceType } from "./auth.js";
import { applyGoogleChatInboundAccessPolicy, isSenderAllowed } from "./monitor-access.js";
import type {
  GoogleChatCoreRuntime,
  GoogleChatMonitorOptions,
  GoogleChatRuntimeEnv,
  WebhookTarget,
} from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatAttachment, GoogleChatEvent } from "./types.js";
export type { GoogleChatMonitorOptions, GoogleChatRuntimeEnv } from "./monitor-types.js";
export { isSenderAllowed };

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
  processEvent: async (event, target) => {
    await processGoogleChatEvent(event, target);
  },
  webhookInFlightLimiter,
  webhookTargets,
});

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

export function registerGoogleChatWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    route: {
      accountId: target.account.accountId,
      auth: "plugin",
      handler: async (req, res) => {
        const handled = await handleGoogleChatWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
      log: target.runtime.log,
      match: "exact",
      pluginId: "googlechat",
      source: "googlechat-webhook",
    },
    target,
    targetsByPath: webhookTargets,
  }).unregister;
}

function normalizeAudienceType(value?: string | null): GoogleChatAudienceType | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "app-url" || normalized === "app_url" || normalized === "app") {
    return "app-url";
  }
  if (
    normalized === "project-number" ||
    normalized === "project_number" ||
    normalized === "project"
  ) {
    return "project-number";
  }
  return undefined;
}

export async function handleGoogleChatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await googleChatWebhookRequestHandler(req, res);
}

async function processGoogleChatEvent(event: GoogleChatEvent, target: WebhookTarget) {
  const eventType = event.type ?? (event as { eventType?: string }).eventType;
  if (eventType !== "MESSAGE") {
    return;
  }
  if (!event.message || !event.space) {
    return;
  }

  await processMessageWithPipeline({
    account: target.account,
    config: target.config,
    core: target.core,
    event,
    mediaMaxMb: target.mediaMaxMb,
    runtime: target.runtime,
    statusSink: target.statusSink,
  });
}

/**
 * Resolve bot display name with fallback chain:
 * 1. Account config name
 * 2. Agent name from config
 * 3. "OpenClaw" as generic fallback
 */
function resolveBotDisplayName(params: {
  accountName?: string;
  agentId: string;
  config: OpenClawConfig;
}): string {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) {
    return accountName.trim();
  }
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (agent?.name?.trim()) {
    return agent.name.trim();
  }
  return "OpenClaw";
}

async function processMessageWithPipeline(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink, mediaMaxMb } = params;
  const {space} = event;
  const {message} = event;
  if (!space || !message) {
    return;
  }

  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const spaceType = (space.type ?? "").toUpperCase();
  const isGroup = spaceType !== "DM";
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email ?? undefined;

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (sender?.type?.toUpperCase() === "BOT") {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId === "users/app") {
      logVerbose(core, runtime, "skip app-authored message");
      return;
    }
  }

  const messageText = (message.argumentText ?? message.text ?? "").trim();
  const attachments = message.attachment ?? [];
  const hasMedia = attachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const access = await applyGoogleChatInboundAccessPolicy({
    account,
    config,
    core,
    isGroup,
    logVerbose: (message) => logVerbose(core, runtime, message),
    message,
    rawBody,
    senderEmail,
    senderId,
    senderName,
    space,
    statusSink,
  });
  if (!access.ok) {
    return;
  }
  const { commandAuthorized, effectiveWasMentioned, groupSystemPrompt } = access;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    accountId: account.accountId,
    cfg: config,
    channel: "googlechat",
    peer: {
      id: spaceId,
      kind: isGroup ? ("group" as const) : ("direct" as const),
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (attachments.length > 0) {
    const first = attachments[0];
    const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
    if (attachmentData) {
      mediaPath = attachmentData.path;
      mediaType = attachmentData.contentType;
    }
  }

  const fromLabel = isGroup
    ? space.displayName || `space:${spaceId}`
    : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    body: rawBody,
    channel: "Google Chat",
    from: fromLabel,
    timestamp: event.eventTime ? Date.parse(event.eventTime) : undefined,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: body,
    BodyForAgent: rawBody,
    ChatType: isGroup ? "channel" : "direct",
    CommandAuthorized: commandAuthorized,
    CommandBody: rawBody,
    ConversationLabel: fromLabel,
    From: `googlechat:${senderId}`,
    GroupSpace: isGroup ? (space.displayName ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    MessageSid: message.name,
    MessageSidFull: message.name,
    OriginatingChannel: "googlechat",
    OriginatingTo: `googlechat:${spaceId}`,
    Provider: "googlechat",
    RawBody: rawBody,
    ReplyToId: message.thread?.name,
    ReplyToIdFull: message.thread?.name,
    SenderId: senderId,
    SenderName: senderName || undefined,
    SenderUsername: senderEmail,
    SessionKey: route.sessionKey,
    Surface: "googlechat",
    To: `googlechat:${spaceId}`,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      ctx: ctxPayload,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      storePath,
    })
    .catch((error) => {
      runtime.error?.(`googlechat: failed updating session meta: ${String(error)}`);
    });

  // Typing indicator setup
  // Note: Reaction mode requires user OAuth, not available with service account auth.
  // If reaction is configured, we fall back to message mode with a warning.
  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`,
    );
    typingIndicator = "message";
  }
  let typingMessageName: string | undefined;

  // Start typing indicator (message mode only, reaction mode not supported with app auth)
  if (typingIndicator === "message") {
    try {
      const botName = resolveBotDisplayName({
        accountName: account.config.name,
        agentId: route.agentId,
        config,
      });
      const result = await sendGoogleChatMessage({
        account,
        space: spaceId,
        text: `_${botName} is typing..._`,
        thread: message.thread?.name,
      });
      typingMessageName = result?.messageName;
    } catch (error) {
      runtime.error?.(`Failed sending typing message: ${String(error)}`);
    }
  }

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: route.accountId,
    agentId: route.agentId,
    cfg: config,
    channel: "googlechat",
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    cfg: config,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        await deliverGoogleChatReply({
          account,
          config,
          core,
          payload,
          runtime,
          spaceId,
          statusSink,
          typingMessageName,
        });
        // Only use typing message for first delivery
        typingMessageName = undefined;
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function downloadAttachment(
  attachment: GoogleChatAttachment,
  account: ResolvedGoogleChatAccount,
  mediaMaxMb: number,
  core: GoogleChatCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, maxBytes, resourceName });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName,
  );
  return { contentType: saved.contentType, path: saved.path };
}

async function deliverGoogleChatReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessageName?: string;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink, typingMessageName } =
    params;
  const reply = resolveSendableOutboundReplyParts(payload);
  const {mediaCount} = reply;
  const {hasMedia} = reply;
  const {text} = reply;
  let firstTextChunk = true;
  let suppressCaption = false;

  if (hasMedia) {
    if (typingMessageName) {
      try {
        await deleteGoogleChatMessage({
          account,
          messageName: typingMessageName,
        });
      } catch (error) {
        runtime.error?.(`Google Chat typing cleanup failed: ${String(error)}`);
        const fallbackText = reply.hasText
          ? text
          : (mediaCount > 1
            ? "Sent attachments."
            : "Sent attachment.");
        try {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: fallbackText,
          });
          suppressCaption = Boolean(text.trim());
        } catch (error) {
          runtime.error?.(`Google Chat typing update failed: ${String(error)}`);
        }
      }
    }
  }

  const chunkLimit = account.config.textChunkLimit ?? 4000;
  const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
  await deliverTextOrMediaReply({
    chunkText: (value) => core.channel.text.chunkMarkdownTextWithMode(value, chunkLimit, chunkMode),
    payload,
    sendMedia: async ({ mediaUrl, caption }) => {
      try {
        const loaded = await core.channel.media.fetchRemoteMedia({
          maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
          url: mediaUrl,
        });
        const upload = await uploadAttachmentForReply({
          account,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
          filename: loaded.fileName ?? "attachment",
          spaceId,
        });
        if (!upload.attachmentUploadToken) {
          throw new Error("missing attachment upload token");
        }
        await sendGoogleChatMessage({
          account,
          attachments: [
            { attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName },
          ],
          space: spaceId,
          text: caption,
          thread: payload.replyToId,
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (error) {
        runtime.error?.(`Google Chat attachment send failed: ${String(error)}`);
      }
    },
    sendText: async (chunk) => {
      try {
        if (firstTextChunk && typingMessageName) {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: chunk,
          });
        } else {
          await sendGoogleChatMessage({
            account,
            space: spaceId,
            text: chunk,
            thread: payload.replyToId,
          });
        }
        firstTextChunk = false;
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (error) {
        runtime.error?.(`Google Chat message send failed: ${String(error)}`);
      }
    },
    text: suppressCaption ? "" : reply.text,
  });
}

async function uploadAttachmentForReply(params: {
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  buffer: Buffer;
  contentType?: string;
  filename: string;
}) {
  const { account, spaceId, buffer, contentType, filename } = params;
  const { uploadGoogleChatAttachment } = await import("./api.js");
  return await uploadGoogleChatAttachment({
    account,
    buffer,
    contentType,
    filename,
    space: spaceId,
  });
}

export function monitorGoogleChatProvider(options: GoogleChatMonitorOptions): () => void {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveWebhookPath({
    defaultPath: "/googlechat",
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const audienceType = normalizeAudienceType(options.account.config.audienceType);
  const audience = options.account.config.audience?.trim();
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  const unregisterTarget = registerGoogleChatWebhookTarget({
    account: options.account,
    audience,
    audienceType,
    config: options.config,
    core,
    mediaMaxMb,
    path: webhookPath,
    runtime: options.runtime,
    statusSink: options.statusSink,
  });

  return () => {
    unregisterTarget();
  };
}

export async function startGoogleChatMonitor(
  params: GoogleChatMonitorOptions,
): Promise<() => void> {
  return monitorGoogleChatProvider(params);
}

export function resolveGoogleChatWebhookPath(params: {
  account: ResolvedGoogleChatAccount;
}): string {
  return (
    resolveWebhookPath({
      defaultPath: "/googlechat",
      webhookPath: params.account.config.webhookPath,
      webhookUrl: params.account.config.webhookUrl,
    }) ?? "/googlechat"
  );
}

export function computeGoogleChatMediaMaxMb(params: { account: ResolvedGoogleChatAccount }) {
  return params.account.config.mediaMaxMb ?? 20;
}
