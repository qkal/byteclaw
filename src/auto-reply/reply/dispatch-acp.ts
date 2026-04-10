import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../../acp/policy.js";
import { formatAcpRuntimeErrorText } from "../../acp/runtime/error-text.js";
import { toAcpRuntimeError } from "../../acp/runtime/errors.js";
import { resolveAcpThreadSessionDetailLines } from "../../acp/runtime/session-identifiers.js";
import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "../../acp/runtime/session-identity.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { generateSecureUuid } from "../../infra/secure-random.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { loadDispatchAcpMediaRuntime, resolveAcpAttachments } from "./dispatch-acp-attachments.js";
import {
  type AcpDispatchDeliveryCoordinator,
  createAcpDispatchDeliveryCoordinator,
} from "./dispatch-acp-delivery.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.js";

let dispatchAcpManagerRuntimePromise: Promise<
  typeof import("./dispatch-acp-manager.runtime.js")
> | null = null;
let dispatchAcpSessionRuntimePromise: Promise<
  typeof import("./dispatch-acp-session.runtime.js")
> | null = null;
let dispatchAcpTtsRuntimePromise: Promise<typeof import("./dispatch-acp-tts.runtime.js")> | null =
  null;

function loadDispatchAcpManagerRuntime() {
  dispatchAcpManagerRuntimePromise ??= import("./dispatch-acp-manager.runtime.js");
  return dispatchAcpManagerRuntimePromise;
}

function loadDispatchAcpSessionRuntime() {
  dispatchAcpSessionRuntimePromise ??= import("./dispatch-acp-session.runtime.js");
  return dispatchAcpSessionRuntimePromise;
}

function loadDispatchAcpTtsRuntime() {
  dispatchAcpTtsRuntimePromise ??= import("./dispatch-acp-tts.runtime.js");
  return dispatchAcpTtsRuntimePromise;
}

type DispatchProcessedRecorder = (
  outcome: "completed" | "skipped" | "error",
  opts?: {
    reason?: string;
    error?: string;
  },
) => void;

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: ("BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body")[],
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveAcpPromptText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, [
    "BodyForAgent",
    "BodyForCommands",
    "CommandBody",
    "RawBody",
    "Body",
  ]).trim();
}

function hasInboundMediaForAcp(ctx: FinalizedMsgContext): boolean {
  return Boolean(
    ctx.StickerMediaIncluded ||
    ctx.Sticker ||
    normalizeOptionalString(ctx.MediaPath) ||
    normalizeOptionalString(ctx.MediaUrl) ||
    ctx.MediaPaths?.some((value) => normalizeOptionalString(value)) ||
    ctx.MediaUrls?.some((value) => normalizeOptionalString(value)) ||
    ctx.MediaTypes?.length,
  );
}

function resolveAcpRequestId(ctx: FinalizedMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  if (typeof id === "string") {
    const normalizedId = normalizeOptionalString(id);
    if (normalizedId) {
      return normalizedId;
    }
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return generateSecureUuid();
}

async function hasBoundConversationForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  channelRaw: string | undefined;
  accountIdRaw: string | undefined;
}): Promise<boolean> {
  const channel = normalizeOptionalLowercaseString(params.channelRaw) ?? "";
  if (!channel) {
    return false;
  }
  const accountId = normalizeOptionalLowercaseString(params.accountIdRaw) ?? "";
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  const normalizedAccountId =
    accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
  const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
  const bindingService = getSessionBindingService();
  const bindings = bindingService.listBySession(params.sessionKey);
  return bindings.some((binding) => {
    const bindingChannel = normalizeOptionalLowercaseString(binding.conversation.channel) ?? "";
    const bindingAccountId = normalizeOptionalLowercaseString(binding.conversation.accountId) ?? "";
    const conversationId = normalizeOptionalString(binding.conversation.conversationId) ?? "";
    return (
      bindingChannel === channel &&
      (bindingAccountId || "default") === normalizedAccountId &&
      conversationId.length > 0
    );
  });
}

export interface AcpDispatchAttemptResult {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
}

const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";

function isStaleSessionInitError(params: { code: string; message: string }): boolean {
  if (params.code !== "ACP_SESSION_INIT_FAILED") {
    return false;
  }
  return /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found)/i.test(
    params.message,
  );
}

async function maybeUnbindStaleBoundConversations(params: {
  targetSessionKey: string;
  error: { code: string; message: string };
}): Promise<void> {
  if (!isStaleSessionInitError(params.error)) {
    return;
  }
  try {
    const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
    const removed = await getSessionBindingService().unbind({
      reason: ACP_STALE_BINDING_UNBIND_REASON,
      targetSessionKey: params.targetSessionKey,
    });
    if (removed.length > 0) {
      logVerbose(
        `dispatch-acp: removed ${removed.length} stale bound conversation(s) for ${params.targetSessionKey} after ${params.error.code}: ${params.error.message}`,
      );
    }
  } catch (error) {
    logVerbose(
      `dispatch-acp: failed to unbind stale bound conversations for ${params.targetSessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

async function finalizeAcpTurnOutput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  delivery: AcpDispatchDeliveryCoordinator;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  shouldEmitResolvedIdentityNotice: boolean;
}): Promise<boolean> {
  await params.delivery.settleVisibleText();
  let queuedFinal =
    params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery();
  const ttsMode = resolveConfiguredTtsMode(params.cfg);
  const accumulatedBlockText = params.delivery.getAccumulatedBlockText();
  const hasAccumulatedBlockText = accumulatedBlockText.trim().length > 0;
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.sessionTtsAuto,
  });
  const canAttemptFinalTts =
    ttsStatus != null && !(ttsStatus.autoMode === "inbound" && !params.inboundAudio);

  let finalMediaDelivered = false;
  if (ttsMode === "final" && hasAccumulatedBlockText && canAttemptFinalTts) {
    try {
      const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
      const ttsSyntheticReply = await maybeApplyTtsToPayload({
        cfg: params.cfg,
        channel: params.ttsChannel,
        inboundAudio: params.inboundAudio,
        kind: "final",
        payload: { text: accumulatedBlockText },
        ttsAuto: params.sessionTtsAuto,
      });
      if (ttsSyntheticReply.mediaUrl) {
        const delivered = await params.delivery.deliver("final", {
          audioAsVoice: ttsSyntheticReply.audioAsVoice,
          mediaUrl: ttsSyntheticReply.mediaUrl,
        });
        queuedFinal = queuedFinal || delivered;
        finalMediaDelivered = delivered;
      }
    } catch (error) {
      logVerbose(`dispatch-acp: accumulated ACP block TTS failed: ${formatErrorMessage(error)}`);
    }
  }

  // Some ACP parent surfaces only expose terminal replies, so block routing alone is not enough
  // To prove the final result was visible to the user.
  const shouldDeliverTextFallback =
    ttsMode !== "all" &&
    hasAccumulatedBlockText &&
    !finalMediaDelivered &&
    !params.delivery.hasDeliveredFinalReply() &&
    (!params.delivery.hasDeliveredVisibleText() || params.delivery.hasFailedVisibleTextDelivery());
  if (shouldDeliverTextFallback) {
    const delivered = await params.delivery.deliver(
      "final",
      { text: accumulatedBlockText },
      { skipTts: true },
    );
    queuedFinal = queuedFinal || delivered;
  }

  if (params.shouldEmitResolvedIdentityNotice) {
    const { readAcpSessionEntry } = await loadDispatchAcpSessionRuntime();
    const currentMeta = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    })?.acp;
    const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
    if (!isSessionIdentityPending(identityAfterTurn)) {
      const resolvedDetails = resolveAcpThreadSessionDetailLines({
        meta: currentMeta,
        sessionKey: params.sessionKey,
      });
      if (resolvedDetails.length > 0) {
        const delivered = await params.delivery.deliver("final", {
          text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
        });
        queuedFinal = queuedFinal || delivered;
      }
    }
  }

  return queuedFinal;
}

export async function tryDispatchAcpReply(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  runId?: string;
  sessionKey?: string;
  abortSignal?: AbortSignal;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  suppressUserDelivery?: boolean;
  shouldRouteToOriginating: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  shouldSendToolSummaries: boolean;
  bypassForCommand: boolean;
  onReplyStart?: () => Promise<void> | void;
  recordProcessed: DispatchProcessedRecorder;
  markIdle: (reason: string) => void;
}): Promise<AcpDispatchAttemptResult | null> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey || params.bypassForCommand) {
    return null;
  }

  const { getAcpSessionManager } = await loadDispatchAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const acpResolution = acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey,
  });
  if (acpResolution.kind === "none") {
    return null;
  }
  const canonicalSessionKey = acpResolution.sessionKey;

  let queuedFinal = false;
  const delivery = createAcpDispatchDeliveryCoordinator({
    cfg: params.cfg,
    ctx: params.ctx,
    dispatcher: params.dispatcher,
    inboundAudio: params.inboundAudio,
    onReplyStart: params.onReplyStart,
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    sessionTtsAuto: params.sessionTtsAuto,
    shouldRouteToOriginating: params.shouldRouteToOriginating,
    suppressUserDelivery: params.suppressUserDelivery,
    ttsChannel: params.ttsChannel,
  });

  const identityPendingBeforeTurn = isSessionIdentityPending(
    resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : undefined),
  );
  const shouldEmitResolvedIdentityNotice =
    !params.suppressUserDelivery &&
    identityPendingBeforeTurn &&
    (Boolean(
      params.ctx.MessageThreadId != null &&
      (normalizeOptionalString(String(params.ctx.MessageThreadId)) ?? ""),
    ) ||
      (await hasBoundConversationForSession({
        accountIdRaw: params.ctx.AccountId,
        cfg: params.cfg,
        channelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
        sessionKey: canonicalSessionKey,
      })));

  const resolvedAcpAgent =
    acpResolution.kind === "ready"
      ? (normalizeOptionalString(acpResolution.meta.agent) ??
        normalizeOptionalString(params.cfg.acp?.defaultAgent) ??
        resolveAgentIdFromSessionKey(canonicalSessionKey))
      : resolveAgentIdFromSessionKey(canonicalSessionKey);
  const normalizedDispatchChannel = normalizeOptionalLowercaseString(
    params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
  );
  const explicitDispatchAccountId = normalizeOptionalString(params.ctx.AccountId);
  const dispatchChannels = params.cfg.channels as
    | Record<string, { defaultAccount?: unknown } | undefined>
    | undefined;
  const defaultDispatchAccount =
    normalizedDispatchChannel == null
      ? undefined
      : dispatchChannels?.[normalizedDispatchChannel]?.defaultAccount;
  const effectiveDispatchAccountId =
    explicitDispatchAccountId ?? normalizeOptionalString(defaultDispatchAccount);
  const projector = createAcpReplyProjector({
    accountId: effectiveDispatchAccountId,
    cfg: params.cfg,
    deliver: delivery.deliver,
    provider: params.ctx.Surface ?? params.ctx.Provider,
    shouldSendToolSummaries: params.shouldSendToolSummaries,
  });

  const acpDispatchStartedAt = Date.now();
  try {
    const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
    if (dispatchPolicyError) {
      throw dispatchPolicyError;
    }
    if (acpResolution.kind === "stale") {
      await maybeUnbindStaleBoundConversations({
        error: acpResolution.error,
        targetSessionKey: canonicalSessionKey,
      });
      const delivered = await delivery.deliver("final", {
        isError: true,
        text: formatAcpRuntimeErrorText(acpResolution.error),
      });
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
      logVerbose(
        `acp-dispatch: session=${sessionKey} outcome=error code=${acpResolution.error.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
      );
      params.recordProcessed("completed", {
        reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpResolution.error.code)}`,
      });
      params.markIdle("message_completed");
      return { counts, queuedFinal: delivered };
    }
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
    if (agentPolicyError) {
      throw agentPolicyError;
    }
    if (hasInboundMediaForAcp(params.ctx) && !params.ctx.MediaUnderstanding?.length) {
      try {
        const { applyMediaUnderstanding } = await loadDispatchAcpMediaRuntime();
        await applyMediaUnderstanding({
          cfg: params.cfg,
          ctx: params.ctx,
        });
      } catch (error) {
        logVerbose(
          `dispatch-acp: media understanding failed, proceeding with raw content: ${formatErrorMessage(error)}`,
        );
      }
    }

    const promptText = resolveAcpPromptText(params.ctx);
    const attachments = hasInboundMediaForAcp(params.ctx)
      ? await resolveAcpAttachments({ cfg: params.cfg, ctx: params.ctx })
      : [];
    if (!promptText && attachments.length === 0) {
      const counts = params.dispatcher.getQueuedCounts();
      delivery.applyRoutedCounts(counts);
      params.recordProcessed("completed", { reason: "acp_empty_prompt" });
      params.markIdle("message_completed");
      return { counts, queuedFinal: false };
    }

    try {
      await delivery.startReplyLifecycle();
    } catch (error) {
      logVerbose(`dispatch-acp: start reply lifecycle failed: ${formatErrorMessage(error)}`);
    }

    await acpManager.runTurn({
      cfg: params.cfg,
      sessionKey: canonicalSessionKey,
      text: promptText,
      attachments: attachments.length > 0 ? attachments : undefined,
      mode: "prompt",
      requestId: resolveAcpRequestId(params.ctx),
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      onEvent: async (event) => await projector.onEvent(event),
    });

    await projector.flush(true);
    queuedFinal =
      (await finalizeAcpTurnOutput({
        cfg: params.cfg,
        delivery,
        inboundAudio: params.inboundAudio,
        sessionKey: canonicalSessionKey,
        sessionTtsAuto: params.sessionTtsAuto,
        shouldEmitResolvedIdentityNotice,
        ttsChannel: params.ttsChannel,
      })) || queuedFinal;

    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    const runId = normalizeOptionalString(params.runId);
    if (runId) {
      emitAgentEvent({
        data: {
          endedAt: Date.now(),
          phase: "end",
          startedAt: acpDispatchStartedAt,
        },
        runId,
        sessionKey,
        stream: "lifecycle",
      });
    }
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=ok latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", { reason: "acp_dispatch" });
    params.markIdle("message_completed");
    return { counts, queuedFinal };
  } catch (error) {
    await projector.flush(true);
    const acpError = toAcpRuntimeError({
      error,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    await maybeUnbindStaleBoundConversations({
      error: acpError,
      targetSessionKey: canonicalSessionKey,
    });
    const delivered = await delivery.deliver("final", {
      isError: true,
      text: formatAcpRuntimeErrorText(acpError),
    });
    queuedFinal = queuedFinal || delivered;
    const counts = params.dispatcher.getQueuedCounts();
    delivery.applyRoutedCounts(counts);
    const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
    const runId = normalizeOptionalString(params.runId);
    if (runId) {
      emitAgentEvent({
        data: {
          endedAt: Date.now(),
          error: acpError.message,
          phase: "error",
          startedAt: acpDispatchStartedAt,
        },
        runId,
        sessionKey,
        stream: "lifecycle",
      });
    }
    logVerbose(
      `acp-dispatch: session=${sessionKey} outcome=error code=${acpError.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`,
    );
    params.recordProcessed("completed", {
      reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpError.code)}`,
    });
    params.markIdle("message_completed");
    return { counts, queuedFinal };
  }
}
