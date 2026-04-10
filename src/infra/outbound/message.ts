import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { OpenClawConfig } from "../../config/config.js";
import type { PollInput } from "../../polls.js";
import { normalizePollInput } from "../../polls.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import {
  type OutboundDeliveryResult,
  type OutboundSendDeps,
  deliverOutboundPayloads,
} from "./deliver.js";
import type { OutboundMirror } from "./mirror.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import { buildOutboundSessionContext } from "./session-context.js";
import { resolveOutboundTarget } from "./targets.js";

let messageConfigRuntimePromise: Promise<typeof import("./message.config.runtime.js")> | null =
  null;
let messageGatewayRuntimePromise: Promise<typeof import("./message.gateway.runtime.js")> | null =
  null;

function loadMessageConfigRuntime() {
  messageConfigRuntimePromise ??= import("./message.config.runtime.js");
  return messageConfigRuntimePromise;
}

function loadMessageGatewayRuntime() {
  messageGatewayRuntimePromise ??= import("./message.gateway.runtime.js");
  return messageGatewayRuntimePromise;
}

export interface MessageGatewayOptions {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  mode?: GatewayClientMode;
}

interface MessageSendParams {
  to: string;
  content: string;
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
  channel?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  forceDocument?: boolean;
  accountId?: string;
  replyToId?: string;
  threadId?: string | number;
  dryRun?: boolean;
  bestEffort?: boolean;
  deps?: OutboundSendDeps;
  cfg?: OpenClawConfig;
  gateway?: MessageGatewayOptions;
  idempotencyKey?: string;
  mirror?: OutboundMirror;
  abortSignal?: AbortSignal;
  silent?: boolean;
}

export interface MessageSendResult {
  channel: string;
  to: string;
  via: "direct" | "gateway";
  mediaUrl: string | null;
  mediaUrls?: string[];
  result?: OutboundDeliveryResult | { messageId: string };
  dryRun?: boolean;
}

interface MessagePollParams {
  to: string;
  question: string;
  options: string[];
  maxSelections?: number;
  durationSeconds?: number;
  durationHours?: number;
  channel?: string;
  accountId?: string;
  threadId?: string;
  silent?: boolean;
  isAnonymous?: boolean;
  dryRun?: boolean;
  cfg?: OpenClawConfig;
  gateway?: MessageGatewayOptions;
  idempotencyKey?: string;
}

export interface MessagePollResult {
  channel: string;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds: number | null;
  durationHours: number | null;
  via: "gateway";
  result?: {
    messageId: string;
    toJid?: string;
    channelId?: string;
    conversationId?: string;
    pollId?: string;
  };
  dryRun?: boolean;
}

function buildMessagePollResult(params: {
  channel: string;
  to: string;
  normalized: {
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number | null;
    durationHours?: number | null;
  };
  result?: MessagePollResult["result"];
  dryRun?: boolean;
}): MessagePollResult {
  return {
    channel: params.channel,
    durationHours: params.normalized.durationHours ?? null,
    durationSeconds: params.normalized.durationSeconds ?? null,
    maxSelections: params.normalized.maxSelections,
    options: params.normalized.options,
    question: params.normalized.question,
    to: params.to,
    via: "gateway",
    ...(params.dryRun ? { dryRun: true } : { result: params.result }),
  };
}

async function resolveRequiredChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): Promise<string> {
  return (
    await resolveMessageChannelSelection({
      cfg: params.cfg,
      channel: params.channel,
    })
  ).channel;
}

function resolveRequiredPlugin(channel: string, cfg: OpenClawConfig) {
  const plugin = resolveOutboundChannelPlugin({ cfg, channel });
  if (!plugin) {
    throw new Error(`Unknown channel: ${channel}`);
  }
  return plugin;
}

function resolveGatewayOptions(opts?: MessageGatewayOptions) {
  // Security: backend callers (tools/agents) must not accept user-controlled gateway URLs.
  // Use config-derived gateway target only.
  const url =
    opts?.mode === GATEWAY_CLIENT_MODES.BACKEND ||
    opts?.clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
      ? undefined
      : opts?.url;
  return {
    clientDisplayName: opts?.clientDisplayName,
    clientName: opts?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
    mode: opts?.mode ?? GATEWAY_CLIENT_MODES.CLI,
    timeoutMs:
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.floor(opts.timeoutMs))
        : 10_000,
    token: opts?.token,
    url,
  };
}

async function callMessageGateway<T>(params: {
  gateway?: MessageGatewayOptions;
  method: string;
  params: Record<string, unknown>;
}): Promise<T> {
  const { callGatewayLeastPrivilege } = await loadMessageGatewayRuntime();
  const gateway = resolveGatewayOptions(params.gateway);
  return await callGatewayLeastPrivilege<T>({
    clientDisplayName: gateway.clientDisplayName,
    clientName: gateway.clientName,
    method: params.method,
    mode: gateway.mode,
    params: params.params,
    timeoutMs: gateway.timeoutMs,
    token: gateway.token,
    url: gateway.url,
  });
}

async function resolveMessageConfig(cfg?: OpenClawConfig): Promise<OpenClawConfig> {
  if (cfg) {
    return cfg;
  }
  const { loadConfig } = await loadMessageConfigRuntime();
  return loadConfig();
}

async function resolveGatewayIdempotencyKey(idempotencyKey?: string): Promise<string> {
  if (idempotencyKey) {
    return idempotencyKey;
  }
  const { randomIdempotencyKey } = await loadMessageGatewayRuntime();
  return randomIdempotencyKey();
}

export async function sendMessage(params: MessageSendParams): Promise<MessageSendResult> {
  const cfg = await resolveMessageConfig(params.cfg);
  const channel = await resolveRequiredChannel({ cfg, channel: params.channel });
  const plugin = resolveRequiredPlugin(channel, cfg);
  const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";
  const normalizedPayloads = normalizeReplyPayloadsForDelivery([
    {
      mediaUrl: params.mediaUrl,
      mediaUrls: params.mediaUrls,
      text: params.content,
    },
  ]);
  const mirrorText = normalizedPayloads
    .map((payload) => payload.text)
    .filter(Boolean)
    .join("\n");
  const mirrorMediaUrls = normalizedPayloads.flatMap(
    (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
  );
  const primaryMediaUrl = mirrorMediaUrls[0] ?? params.mediaUrl ?? null;

  if (params.dryRun) {
    return {
      channel,
      dryRun: true,
      mediaUrl: primaryMediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
      to: params.to,
      via: deliveryMode === "gateway" ? "gateway" : "direct",
    };
  }

  if (deliveryMode !== "gateway") {
    const outboundChannel = channel;
    const resolvedTarget = resolveOutboundTarget({
      accountId: params.accountId,
      cfg,
      channel: outboundChannel,
      mode: "explicit",
      to: params.to,
    });
    if (!resolvedTarget.ok) {
      throw resolvedTarget.error;
    }

    const outboundSession = buildOutboundSessionContext({
      agentId: params.agentId,
      cfg,
      sessionKey: params.mirror?.sessionKey,
    });
    const results = await deliverOutboundPayloads({
      abortSignal: params.abortSignal,
      accountId: params.accountId,
      bestEffort: params.bestEffort,
      cfg,
      channel: outboundChannel,
      deps: params.deps,
      forceDocument: params.forceDocument,
      gifPlayback: params.gifPlayback,
      mirror: params.mirror
        ? {
            ...params.mirror,
            idempotencyKey: params.mirror.idempotencyKey ?? params.idempotencyKey,
            mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
            text: mirrorText || params.content,
          }
        : undefined,
      payloads: normalizedPayloads,
      replyToId: params.replyToId,
      session: outboundSession,
      silent: params.silent,
      threadId: params.threadId,
      to: resolvedTarget.to,
    });

    return {
      channel,
      mediaUrl: primaryMediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
      result: results.at(-1),
      to: params.to,
      via: "direct",
    };
  }

  const result = await callMessageGateway<{ messageId: string }>({
    gateway: params.gateway,
    method: "send",
    params: {
      accountId: params.accountId,
      agentId: params.agentId,
      channel,
      gifPlayback: params.gifPlayback,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
      mediaUrl: params.mediaUrl,
      mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : params.mediaUrls,
      message: params.content,
      sessionKey: params.mirror?.sessionKey,
      to: params.to,
    },
  });

  return {
    channel,
    mediaUrl: primaryMediaUrl,
    mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
    result,
    to: params.to,
    via: "gateway",
  };
}

export async function sendPoll(params: MessagePollParams): Promise<MessagePollResult> {
  const cfg = await resolveMessageConfig(params.cfg);
  const channel = await resolveRequiredChannel({ cfg, channel: params.channel });

  const pollInput: PollInput = {
    durationHours: params.durationHours,
    durationSeconds: params.durationSeconds,
    maxSelections: params.maxSelections,
    options: params.options,
    question: params.question,
  };
  const plugin = resolveRequiredPlugin(channel, cfg);
  const outbound = plugin?.outbound;
  if (!outbound?.sendPoll) {
    throw new Error(`Unsupported poll channel: ${channel}`);
  }
  const normalized = outbound.pollMaxOptions
    ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions })
    : normalizePollInput(pollInput);

  if (params.dryRun) {
    return buildMessagePollResult({
      channel,
      dryRun: true,
      normalized,
      to: params.to,
    });
  }

  const result = await callMessageGateway<{
    messageId: string;
    toJid?: string;
    channelId?: string;
    conversationId?: string;
    pollId?: string;
  }>({
    gateway: params.gateway,
    method: "poll",
    params: {
      accountId: params.accountId,
      channel,
      durationHours: normalized.durationHours,
      durationSeconds: normalized.durationSeconds,
      idempotencyKey: await resolveGatewayIdempotencyKey(params.idempotencyKey),
      isAnonymous: params.isAnonymous,
      maxSelections: normalized.maxSelections,
      options: normalized.options,
      question: normalized.question,
      silent: params.silent,
      threadId: params.threadId,
      to: params.to,
    },
  });

  return buildMessagePollResult({
    channel,
    normalized,
    result,
    to: params.to,
  });
}
