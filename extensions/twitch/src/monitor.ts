/**
 * Twitch message monitor - processes incoming messages and routes to agents.
 *
 * This monitor connects to the Twitch client manager, processes incoming messages,
 * resolves agent routes, and handles replies.
 */

import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { checkTwitchAccessControl } from "./access-control.js";
import { getOrCreateClientManager } from "./client-manager-registry.js";
import { getTwitchRuntime } from "./runtime.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";

export interface TwitchRuntimeEnv {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface TwitchMonitorOptions {
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown; // OpenClawConfig
  runtime: TwitchRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}

export interface TwitchMonitorResult {
  stop: () => void;
}

type TwitchCoreRuntime = ReturnType<typeof getTwitchRuntime>;

/**
 * Process an incoming Twitch message and dispatch to agent.
 */
async function processTwitchMessage(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown;
  runtime: TwitchRuntimeEnv;
  core: TwitchCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, accountId, config, runtime, core, statusSink } = params;
  const cfg = config as OpenClawConfig;

  const route = core.channel.routing.resolveAgentRoute({
    accountId,
    cfg,
    channel: "twitch",
    peer: {
      kind: "group", // Twitch chat is always group-like
      id: message.channel,
    },
  });

  const rawBody = message.message;
  const body = core.channel.reply.formatAgentEnvelope({
    body: rawBody,
    channel: "Twitch",
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
    from: message.displayName ?? message.username,
    timestamp: message.timestamp?.getTime(),
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    AccountId: route.accountId,
    Body: body,
    BodyForAgent: rawBody,
    ChatType: "group",
    CommandBody: rawBody,
    ConversationLabel: message.channel,
    From: `twitch:user:${message.userId}`,
    MessageSid: message.id,
    OriginatingChannel: "twitch",
    OriginatingTo: `twitch:channel:${message.channel}`,
    Provider: "twitch",
    RawBody: rawBody,
    SenderId: message.userId,
    SenderName: message.displayName ?? message.username,
    SenderUsername: message.username,
    SessionKey: route.sessionKey,
    Surface: "twitch",
    To: `twitch:channel:${message.channel}`,
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`Failed updating session meta: ${String(err)}`);
    },
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    storePath,
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    accountId,
    cfg,
    channel: "twitch",
  });
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId,
    agentId: route.agentId,
    cfg,
    channel: "twitch",
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    cfg,
    ctx: ctxPayload,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload) => {
        await deliverTwitchReply({
          account,
          accountId,
          channel: message.channel,
          config,
          payload,
          runtime,
          statusSink,
          tableMode,
        });
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

/**
 * Deliver a reply to Twitch chat.
 */
async function deliverTwitchReply(params: {
  payload: ReplyPayload;
  channel: string;
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown;
  tableMode: MarkdownTableMode;
  runtime: TwitchRuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, channel, account, accountId, config, runtime, statusSink } = params;

  try {
    const clientManager = getOrCreateClientManager(accountId, {
      debug: (msg) => runtime.log?.(msg),
      error: (msg) => runtime.error?.(msg),
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
    });

    const client = await clientManager.getClient(
      account,
      config as Parameters<typeof clientManager.getClient>[1],
      accountId,
    );
    if (!client) {
      runtime.error?.(`No client available for sending reply`);
      return;
    }

    // Send the reply
    if (!payload.text) {
      runtime.error?.(`No text to send in reply payload`);
      return;
    }

    const textToSend = stripMarkdownForTwitch(payload.text);

    await client.say(channel, textToSend);
    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (error) {
    runtime.error?.(`Failed to send reply: ${String(error)}`);
  }
}

/**
 * Main monitor provider for Twitch.
 *
 * Sets up message handlers and processes incoming messages.
 */
export async function monitorTwitchProvider(
  options: TwitchMonitorOptions,
): Promise<TwitchMonitorResult> {
  const { account, accountId, config, runtime, abortSignal, statusSink } = options;

  const core = getTwitchRuntime();
  let stopped = false;

  const coreLogger = core.logging.getChildLogger({ module: "twitch" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    coreLogger.debug?.(message);
  };
  const logger = {
    debug: logVerboseMessage,
    error: (msg: string) => coreLogger.error(msg),
    info: (msg: string) => coreLogger.info(msg),
    warn: (msg: string) => coreLogger.warn(msg),
  };

  const clientManager = getOrCreateClientManager(accountId, logger);

  try {
    await clientManager.getClient(
      account,
      config as Parameters<typeof clientManager.getClient>[1],
      accountId,
    );
  } catch (error) {
    const errorMsg = formatErrorMessage(error);
    runtime.error?.(`Failed to connect: ${errorMsg}`);
    throw error;
  }

  const unregisterHandler = clientManager.onMessage(account, (message) => {
    if (stopped) {
      return;
    }

    // Access control check
    const botUsername = normalizeLowercaseStringOrEmpty(account.username);
    if (normalizeLowercaseStringOrEmpty(message.username) === botUsername) {
      return; // Ignore own messages
    }

    const access = checkTwitchAccessControl({
      account,
      botUsername,
      message,
    });

    if (!access.allowed) {
      return;
    }

    statusSink?.({ lastInboundAt: Date.now() });

    // Fire-and-forget: process message without blocking
    void processTwitchMessage({
      account,
      accountId,
      config,
      core,
      message,
      runtime,
      statusSink,
    }).catch((error) => {
      runtime.error?.(`Message processing failed: ${String(error)}`);
    });
  });

  const stop = () => {
    stopped = true;
    unregisterHandler();
  };

  abortSignal.addEventListener("abort", stop, { once: true });

  return { stop };
}
