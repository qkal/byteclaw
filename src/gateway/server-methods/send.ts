import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import { normalizeReplyPayloadsForDelivery } from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { normalizePollInput } from "../../polls.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

interface InflightResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: ReturnType<typeof errorShape>;
  meta?: Record<string, unknown>;
}

const inflightByContext = new WeakMap<
  GatewayRequestContext,
  Map<string, Promise<InflightResult>>
>();

const getInflightMap = (context: GatewayRequestContext) => {
  let inflight = inflightByContext.get(context);
  if (!inflight) {
    inflight = new Map();
    inflightByContext.set(context, inflight);
  }
  return inflight;
};

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: ReturnType<typeof loadConfig>;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeChannelId(channelInput) : null;
  if (channelInput && !normalizedChannel) {
    const normalizedInput = normalizeOptionalLowercaseString(channelInput) ?? "";
    if (params.rejectWebchatAsInternalOnly && normalizedInput === "webchat") {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
        ),
      };
    }
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const cfg = applyPluginAutoEnable({
    config: loadConfig(),
    env: process.env,
  }).config;
  let channel = normalizedChannel;
  if (!channel) {
    try {
      ({ channel } = (await resolveMessageChannelSelection({ cfg })));
    } catch (error) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(error)) };
    }
  }
  return { cfg, channel };
}

function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: ReturnType<typeof loadConfig>;
  accountId?: string;
}):
  | {
      ok: true;
      to: string;
    }
  | {
      ok: false;
      error: ReturnType<typeof errorShape>;
    } {
  const resolved = resolveOutboundTarget({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: params.channel,
    mode: "explicit",
    to: params.to,
  });
  if (!resolved.ok) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
      ok: false,
    };
  }
  return { ok: true, to: resolved.to };
}

function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    channel: params.channel,
    messageId: params.result.messageId,
    runId: params.runId,
  };
  if ("chatId" in params.result) {
    payload.chatId = params.result.chatId;
  }
  if ("channelId" in params.result) {
    payload.channelId = params.result.channelId;
  }
  if ("toJid" in params.result) {
    payload.toJid = params.result.toJid;
  }
  if ("conversationId" in params.result) {
    payload.conversationId = params.result.conversationId;
  }
  if ("pollId" in params.result) {
    payload.pollId = params.result.pollId;
  }
  return payload;
}

function cacheGatewayDedupeSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: Record<string, unknown>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ok: true,
    payload: params.payload,
    ts: Date.now(),
  });
}

function cacheGatewayDedupeFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  error: ReturnType<typeof errorShape>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    error: params.error,
    ok: false,
    ts: Date.now(),
  });
}

export const sendHandlers: GatewayRequestHandlers = {
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`poll:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const to = request.to.trim();
    const resolvedChannel = await resolveRequestedChannel({
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const plugin = resolveOutboundChannelPlugin({ cfg, channel });
    const outbound = plugin?.outbound;
    if (
      typeof request.durationSeconds === "number" &&
      outbound?.supportsPollDurationSeconds !== true
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `durationSeconds is not supported for ${channel} polls`,
        ),
      );
      return;
    }
    if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `isAnonymous is not supported for ${channel} polls`),
      );
      return;
    }
    const poll = {
      durationHours: request.durationHours,
      durationSeconds: request.durationSeconds,
      maxSelections: request.maxSelections,
      options: request.options,
      question: request.question,
    };
    const threadId = normalizeOptionalString(request.threadId);
    const accountId = normalizeOptionalString(request.accountId);
    try {
      if (!outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
        );
        return;
      }
      const resolvedTarget = resolveGatewayOutboundTarget({
        channel,
        to,
        cfg,
        accountId,
      });
      if (!resolvedTarget.ok) {
        respond(false, undefined, resolvedTarget.error);
        return;
      }
      const normalized = outbound.pollMaxOptions
        ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
        : normalizePollInput(poll);
      const result = await outbound.sendPoll({
        accountId,
        cfg,
        gatewayClientScopes: client?.connect?.scopes ?? [],
        isAnonymous: request.isAnonymous,
        poll: normalized,
        silent: request.silent,
        threadId,
        to: resolvedTarget.to,
      });
      const payload = buildGatewayDeliveryPayload({ channel, result, runId: idem });
      cacheGatewayDedupeSuccess({
        context,
        dedupeKey: `poll:${idem}`,
        payload,
      });
      respond(true, payload, undefined, { channel });
    } catch (error) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(error));
      cacheGatewayDedupeFailure({
        context,
        dedupeKey: `poll:${idem}`,
        error,
      });
      respond(false, undefined, error, {
        channel,
        error: formatForLog(error),
      });
    }
  },
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      threadId?: string;
      sessionKey?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const dedupeKey = `send:${idem}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const inflightMap = getInflightMap(context);
    const inflight = inflightMap.get(dedupeKey);
    if (inflight) {
      const result = await inflight;
      const meta = result.meta ? { ...result.meta, cached: true } : { cached: true };
      respond(result.ok, result.payload, result.error, meta);
      return;
    }
    const to = normalizeOptionalString(request.to) ?? "";
    const message = normalizeOptionalString(request.message) ?? "";
    const mediaUrl = normalizeOptionalString(request.mediaUrl);
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    const resolvedChannel = await resolveRequestedChannel({
      rejectWebchatAsInternalOnly: true,
      requestChannel: request.channel,
      unsupportedMessage: (input) => `unsupported channel: ${input}`,
    });
    if ("error" in resolvedChannel) {
      respond(false, undefined, resolvedChannel.error);
      return;
    }
    const { cfg, channel } = resolvedChannel;
    const accountId = normalizeOptionalString(request.accountId);
    const threadId = normalizeOptionalString(request.threadId);
    const outboundChannel = channel;
    const plugin = resolveOutboundChannelPlugin({ cfg, channel });
    if (!plugin) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
      );
      return;
    }

    const work = (async (): Promise<InflightResult> => {
      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          accountId,
          cfg,
          channel: outboundChannel,
          to,
        });
        if (!resolvedTarget.ok) {
          return {
            error: resolvedTarget.error,
            meta: { channel },
            ok: false,
          };
        }
        const idLikeTarget = await maybeResolveIdLikeTarget({
          accountId,
          cfg,
          channel,
          input: resolvedTarget.to,
        });
        const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const mirrorPayloads = normalizeReplyPayloadsForDelivery([
          { mediaUrl, mediaUrls, text: message },
        ]);
        const mirrorText = mirrorPayloads
          .map((payload) => payload.text)
          .filter(Boolean)
          .join("\n");
        const mirrorMediaUrls = mirrorPayloads.flatMap(
          (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
        );
        const providedSessionKey = normalizeOptionalLowercaseString(request.sessionKey);
        const explicitAgentId = normalizeOptionalString(request.agentId);
        const sessionAgentId = providedSessionKey
          ? resolveSessionAgentId({ config: cfg, sessionKey: providedSessionKey })
          : undefined;
        const defaultAgentId = resolveSessionAgentId({ config: cfg });
        const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
        const derivedRoute = await resolveOutboundSessionRoute({
          accountId,
          agentId: effectiveAgentId,
          cfg,
          channel,
          currentSessionKey: providedSessionKey,
          resolvedTarget: idLikeTarget,
          target: deliveryTarget,
          threadId,
        });
        const outboundRoute = derivedRoute
          ? (providedSessionKey
            ? {
                ...derivedRoute,
                sessionKey: providedSessionKey,
                baseSessionKey: providedSessionKey,
              }
            : derivedRoute)
          : null;
        if (outboundRoute) {
          await ensureOutboundSessionEntry({
            accountId,
            cfg,
            channel,
            route: outboundRoute,
          });
        }
        const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
        const outboundSession = buildOutboundSessionContext({
          agentId: effectiveAgentId,
          cfg,
          sessionKey: outboundSessionKey,
        });
        const results = await deliverOutboundPayloads({
          accountId,
          cfg,
          channel: outboundChannel,
          deps: outboundDeps,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          gifPlayback: request.gifPlayback,
          mirror: outboundSessionKey
            ? {
                sessionKey: outboundSessionKey,
                agentId: effectiveAgentId,
                text: mirrorText || message,
                mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                idempotencyKey: idem,
              }
            : undefined,
          payloads: [{ text: message, mediaUrl, mediaUrls }],
          session: outboundSession,
          threadId: threadId ?? null,
          to: deliveryTarget,
        });

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        const payload = buildGatewayDeliveryPayload({ channel, result, runId: idem });
        cacheGatewayDedupeSuccess({ context, dedupeKey, payload });
        return {
          meta: { channel },
          ok: true,
          payload,
        };
      } catch (error) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(error));
        cacheGatewayDedupeFailure({ context, dedupeKey, error });
        return { ok: false, error, meta: { channel, error: formatForLog(error) } };
      }
    })();

    inflightMap.set(dedupeKey, work);
    try {
      const result = await work;
      respond(result.ok, result.payload, result.error, result.meta);
    } finally {
      inflightMap.delete(dedupeKey);
    }
  },
};
