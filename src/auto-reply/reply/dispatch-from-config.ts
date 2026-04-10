import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { isParentOwnedBackgroundAcpSession } from "../../acp/session-interaction-mode.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveConversationBindingRecord,
  touchConversationBindingRecord,
} from "../../bindings/records.js";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import type { OpenClawConfig } from "../../config/config.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
  toPluginInboundClaimContext,
  toPluginInboundClaimEvent,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import {
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingUnavailableText,
  hasShownPluginBindingFallbackNotice,
  isPluginOwnedSessionBindingRecord,
  markPluginBindingFallbackNoticeShown,
  toPluginConversationBinding,
} from "../../plugins/conversation-binding.js";
import { getGlobalHookRunner, getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeTtsAutoMode, resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import {
  type BlockReplyContext,
  type GetReplyOptions,
  type ReplyPayload,
  getReplyPayloadMetadata,
} from "../types.js";
import {
  createInternalHookEvent,
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  triggerInternalHook,
} from "./dispatch-from-config.runtime.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyRoutingDecision } from "./routing-policy.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;
let getReplyFromConfigRuntimePromise: Promise<
  typeof import("./get-reply-from-config.runtime.js")
> | null = null;
let abortRuntimePromise: Promise<typeof import("./abort.runtime.js")> | null = null;
let ttsRuntimePromise: Promise<typeof import("../../tts/tts.runtime.js")> | null = null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

function loadGetReplyFromConfigRuntime() {
  getReplyFromConfigRuntimePromise ??= import("./get-reply-from-config.runtime.js");
  return getReplyFromConfigRuntimePromise;
}

function loadAbortRuntime() {
  abortRuntimePromise ??= import("./abort.runtime.js");
  return abortRuntimePromise;
}

function loadTtsRuntime() {
  ttsRuntimePromise ??= import("../../tts/tts.runtime.js");
  return ttsRuntimePromise;
}

async function maybeApplyTtsToReplyPayload(
  params: Parameters<Awaited<ReturnType<typeof loadTtsRuntime>>["maybeApplyTtsToPayload"]>[0],
) {
  const { maybeApplyTtsToPayload } = await loadTtsRuntime();
  return maybeApplyTtsToPayload(params);
}

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value: string): string =>
  normalizeOptionalLowercaseString(value.split(";")[0]) ?? "";

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveSessionStoreLookup = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  storePath?: string;
  entry?: SessionEntry;
} => {
  const targetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ config: cfg, sessionKey });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      entry: resolveSessionStoreEntry({ sessionKey, store }).existing,
      sessionKey,
      storePath,
    };
  } catch {
    return {
      sessionKey,
      storePath,
    };
  }
};

const createShouldEmitVerboseProgress =
  (params: { sessionKey?: string; storePath?: string; fallbackLevel: string }) => () => {
    if (params.sessionKey && params.storePath) {
      try {
        const store = loadSessionStore(params.storePath);
        const entry = resolveSessionStoreEntry({ sessionKey: params.sessionKey, store }).existing;
        const currentLevel = normalizeVerboseLevel(String(entry?.verboseLevel ?? ""));
        if (currentLevel) {
          return currentLevel !== "off";
        }
      } catch {
        // Ignore transient store read failures and fall back to the current dispatch snapshot.
      }
    }
    return params.fallbackLevel !== "off";
  };

export interface DispatchFromConfigResult {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
}

export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./get-reply-from-config.runtime.js").getReplyFromConfig;
  fastAbortResolver?: typeof import("./abort.runtime.js").tryFastAbortFromMessage;
  formatAbortReplyTextResolver?: typeof import("./abort.runtime.js").formatAbortReplyText;
  /** Optional config override passed to getReplyFromConfig (e.g. per-sender timezone). */
  configOverride?: OpenClawConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = normalizeLowercaseStringOrEmpty(String(ctx.Surface ?? ctx.Provider ?? "unknown"));
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      durationMs: Date.now() - startTime,
      error: opts?.error,
      messageId,
      outcome,
      reason: opts?.reason,
      sessionKey,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ channel, sessionKey, source: "dispatch" });
    logSessionStateChange({
      reason: "message_start",
      sessionKey,
      state: "processing",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      reason,
      sessionKey,
      state: "idle",
    });
  };

  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { counts: dispatcher.getQueuedCounts(), queuedFinal: false };
  }

  const sessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  const acpDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
  const sessionAgentId = resolveSessionAgentId({ config: cfg, sessionKey: acpDispatchSessionKey });
  const sessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);
  const shouldEmitVerboseProgress = createShouldEmitVerboseProgress({
    fallbackLevel:
      normalizeVerboseLevel(
        String(
          sessionStoreEntry.entry?.verboseLevel ??
            sessionAgentCfg?.verboseDefault ??
            cfg.agents?.defaults?.verboseDefault ??
            "",
        ),
      ) ?? "off",
    sessionKey: acpDispatchSessionKey,
    storePath: sessionStoreEntry.storePath,
  });
  // Restore route thread context only from the active turn or the thread-scoped session key.
  // Do not read thread ids from the normalised session store here: `origin.threadId` can be
  // Folded back into lastThreadId/deliveryContext during store normalisation and resurrect a
  // Stale route after thread delivery was intentionally cleared.
  const routeThreadId =
    ctx.MessageThreadId ?? parseSessionThreadInfo(acpDispatchSessionKey).threadId;
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
  const { isGroup, groupId } = hookContext;
  const inboundClaimContext = toPluginInboundClaimContext(hookContext);
  const inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
    commandAuthorized:
      typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
    wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
  });

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // By a shared session that's currently on Slack) while preserving normal dispatcher
  // Flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const suppressAcpChildUserDelivery = isParentOwnedBackgroundAcpSession(sessionStoreEntry.entry);
  const routeReplyRuntime = await loadRouteReplyRuntime();
  const { originatingChannel, currentSurface, shouldRouteToOriginating, shouldSuppressTyping } =
    resolveReplyRoutingDecision({
      explicitDeliverRoute: ctx.ExplicitDeliverRoute,
      isRoutableChannel: routeReplyRuntime.isRoutableChannel,
      originatingChannel: ctx.OriginatingChannel,
      originatingTo: ctx.OriginatingTo,
      provider: ctx.Provider,
      suppressDirectUserDelivery: suppressAcpChildUserDelivery,
      surface: ctx.Surface,
    });
  const originatingTo = ctx.OriginatingTo;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * originatingChannel and originatingTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // But they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReplyRuntime.routeReply({
      abortSignal,
      accountId: ctx.AccountId,
      cfg,
      channel: originatingChannel,
      groupId,
      isGroup,
      mirror,
      payload,
      sessionKey: ctx.SessionKey,
      threadId: routeThreadId,
      to: originatingTo,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    if (shouldRouteToOriginating && originatingChannel && originatingTo) {
      const result = await routeReplyRuntime.routeReply({
        accountId: ctx.AccountId,
        cfg,
        channel: originatingChannel,
        groupId,
        isGroup,
        payload,
        sessionKey: ctx.SessionKey,
        threadId: routeThreadId,
        to: originatingTo,
      });
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result.ok;
    }
    return mode === "additive"
      ? dispatcher.sendToolResult(payload)
      : dispatcher.sendFinalReply(payload);
  };

  const pluginOwnedBindingRecord =
    inboundClaimContext.conversationId && inboundClaimContext.channelId
      ? resolveConversationBindingRecord({
          accountId:
            inboundClaimContext.accountId ??
            ((
              cfg.channels as Record<string, { defaultAccount?: unknown } | undefined> | undefined
            )?.[inboundClaimContext.channelId]?.defaultAccount as string | undefined) ??
            "default",
          channel: inboundClaimContext.channelId,
          conversationId: inboundClaimContext.conversationId,
          parentConversationId: inboundClaimContext.parentConversationId,
        })
      : null;
  const pluginOwnedBinding = isPluginOwnedSessionBindingRecord(pluginOwnedBindingRecord)
    ? toPluginConversationBinding(pluginOwnedBindingRecord)
    : null;

  let pluginFallbackReason:
    | "plugin-bound-fallback-missing-plugin"
    | "plugin-bound-fallback-no-handler"
    | undefined;

  if (pluginOwnedBinding) {
    touchConversationBindingRecord(pluginOwnedBinding.bindingId);
    logVerbose(
      `plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`,
    );
    const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
      ? await hookRunner.runInboundClaimForPluginOutcome(
          pluginOwnedBinding.pluginId,
          inboundClaimEvent,
          inboundClaimContext,
        )
      : (() => {
          const pluginLoaded =
            getGlobalPluginRegistry()?.plugins.some(
              (plugin) => plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded",
            ) ?? false;
          return pluginLoaded
            ? ({ status: "no_handler" } as const)
            : ({ status: "missing_plugin" } as const);
        })();

    switch (targetedClaimOutcome.status) {
      case "handled": {
        markIdle("plugin_binding_dispatch");
        recordProcessed("completed", { reason: "plugin-bound-handled" });
        return { counts: dispatcher.getQueuedCounts(), queuedFinal: false };
      }
      case "missing_plugin":
      case "no_handler": {
        pluginFallbackReason =
          targetedClaimOutcome.status === "missing_plugin"
            ? "plugin-bound-fallback-missing-plugin"
            : "plugin-bound-fallback-no-handler";
        if (!hasShownPluginBindingFallbackNotice(pluginOwnedBinding.bindingId)) {
          const didSendNotice = await sendBindingNotice(
            { text: buildPluginBindingUnavailableText(pluginOwnedBinding) },
            "additive",
          );
          if (didSendNotice) {
            markPluginBindingFallbackNoticeShown(pluginOwnedBinding.bindingId);
          }
        }
        break;
      }
      case "declined": {
        await sendBindingNotice(
          { text: buildPluginBindingDeclinedText(pluginOwnedBinding) },
          "terminal",
        );
        markIdle("plugin_binding_declined");
        recordProcessed("completed", { reason: "plugin-bound-declined" });
        return { counts: dispatcher.getQueuedCounts(), queuedFinal: false };
      }
      case "error": {
        logVerbose(
          `plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`,
        );
        await sendBindingNotice(
          { text: buildPluginBindingErrorText(pluginOwnedBinding) },
          "terminal",
        );
        markIdle("plugin_binding_error");
        recordProcessed("completed", { reason: "plugin-bound-error" });
        return { counts: dispatcher.getQueuedCounts(), queuedFinal: false };
      }
    }
  }

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetHook(
      hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(hookContext),
        toPluginMessageContext(hookContext),
      ),
      "dispatch-from-config: message_received plugin hook failed",
    );
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, {
          ...toInternalMessageReceivedContext(hookContext),
          timestamp,
        }),
      ),
      "dispatch-from-config: message_received internal hook failed",
    );
  }

  markProcessing();

  try {
    const abortRuntime = params.fastAbortResolver ? null : await loadAbortRuntime();
    const fastAbortResolver = params.fastAbortResolver ?? abortRuntime?.tryFastAbortFromMessage;
    const formatAbortReplyTextResolver =
      params.formatAbortReplyTextResolver ?? abortRuntime?.formatAbortReplyText;
    if (!fastAbortResolver || !formatAbortReplyTextResolver) {
      throw new Error("abort runtime unavailable");
    }
    const fastAbort = await fastAbortResolver({ cfg, ctx });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyTextResolver(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReplyRuntime.routeReply({
          accountId: ctx.AccountId,
          cfg,
          channel: originatingChannel,
          groupId,
          isGroup,
          payload,
          sessionKey: ctx.SessionKey,
          threadId: routeThreadId,
          to: originatingTo,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { counts, queuedFinal };
    }

    const sendPolicy = resolveSendPolicy({
      cfg,
      channel:
        sessionStoreEntry.entry?.channel ??
        ctx.OriginatingChannel ??
        ctx.Surface ??
        ctx.Provider ??
        undefined,
      chatType: sessionStoreEntry.entry?.chatType,
      entry: sessionStoreEntry.entry,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
    });

    const shouldSendToolSummaries = ctx.ChatType !== "group" || ctx.IsForum === true;
    const shouldSendToolStartStatuses = ctx.ChatType !== "group" || ctx.IsForum === true;
    const sendFinalPayload = async (
      payload: ReplyPayload,
    ): Promise<{ queuedFinal: boolean; routedFinalCount: number }> => {
      const ttsPayload = await maybeApplyTtsToReplyPayload({
        cfg,
        channel: ttsChannel,
        inboundAudio,
        kind: "final",
        payload,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReplyRuntime.routeReply({
          accountId: ctx.AccountId,
          cfg,
          channel: originatingChannel,
          groupId,
          isGroup,
          payload: ttsPayload,
          sessionKey: ctx.SessionKey,
          threadId: routeThreadId,
          to: originatingTo,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        return {
          queuedFinal: result.ok,
          routedFinalCount: result.ok ? 1 : 0,
        };
      }
      return {
        queuedFinal: dispatcher.sendFinalReply(ttsPayload),
        routedFinalCount: 0,
      };
    };

    // Run before_dispatch hook — let plugins inspect or handle before model dispatch.
    if (hookRunner?.hasHooks("before_dispatch")) {
      const beforeDispatchResult = await hookRunner.runBeforeDispatch(
        {
          body: hookContext.bodyForAgent ?? hookContext.body,
          channel: hookContext.channelId,
          content: hookContext.content,
          isGroup: hookContext.isGroup,
          senderId: hookContext.senderId,
          sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
          timestamp: hookContext.timestamp,
        },
        {
          accountId: hookContext.accountId,
          channelId: hookContext.channelId,
          conversationId: inboundClaimContext.conversationId,
          senderId: hookContext.senderId,
          sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
        },
      );
      if (beforeDispatchResult?.handled) {
        const { text } = beforeDispatchResult;
        let queuedFinal = false;
        let routedFinalCount = 0;
        if (text) {
          const handledReply = await sendFinalPayload({ text });
          ({ queuedFinal } = handledReply);
          routedFinalCount += handledReply.routedFinalCount;
        }
        const counts = dispatcher.getQueuedCounts();
        counts.final += routedFinalCount;
        recordProcessed("completed", { reason: "before_dispatch_handled" });
        markIdle("message_completed");
        return { counts, queuedFinal };
      }
    }

    if (hookRunner?.hasHooks("reply_dispatch")) {
      const replyDispatchResult = await hookRunner.runReplyDispatch(
        {
          ctx,
          inboundAudio,
          originatingChannel,
          originatingTo,
          runId: params.replyOptions?.runId,
          sendPolicy,
          sessionKey: acpDispatchSessionKey,
          sessionTtsAuto,
          shouldRouteToOriginating,
          shouldSendToolSummaries,
          suppressUserDelivery: suppressAcpChildUserDelivery,
          ttsChannel,
        },
        {
          abortSignal: params.replyOptions?.abortSignal,
          cfg,
          dispatcher,
          markIdle,
          onReplyStart: params.replyOptions?.onReplyStart,
          recordProcessed,
        },
      );
      if (replyDispatchResult?.handled) {
        return {
          counts: replyDispatchResult.counts,
          queuedFinal: replyDispatchResult.queuedFinal,
        };
      }
    }

    if (sendPolicy === "deny") {
      logVerbose(
        `Send blocked by policy for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"}`,
      );
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "send_policy_deny" });
      markIdle("message_completed");
      return { counts, queuedFinal: false };
    }

    const toolStartStatusesSent = new Set<string>();
    let toolStartStatusCount = 0;
    const normalizeWorkingLabel = (label: string) => {
      const collapsed = label.replace(/\s+/g, " ").trim();
      if (collapsed.length <= 80) {
        return collapsed;
      }
      return `${collapsed.slice(0, 77).trimEnd()}...`;
    };
    const formatPlanUpdateText = (payload: { explanation?: string; steps?: string[] }) => {
      const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
      const steps = (payload.steps ?? [])
        .map((step) => step.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const parts: string[] = [];
      if (explanation) {
        parts.push(explanation);
      }
      if (steps.length > 0) {
        parts.push(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
      }
      return parts.join("\n\n").trim() || "Planning next steps.";
    };
    const maybeSendWorkingStatus = (label: string) => {
      const normalizedLabel = normalizeWorkingLabel(label);
      if (
        !shouldEmitVerboseProgress() ||
        !shouldSendToolStartStatuses ||
        !normalizedLabel ||
        toolStartStatusCount >= 2 ||
        toolStartStatusesSent.has(normalizedLabel)
      ) {
        return;
      }
      toolStartStatusesSent.add(normalizedLabel);
      toolStartStatusCount += 1;
      const payload: ReplyPayload = {
        text: `Working: ${normalizedLabel}`,
      };
      if (shouldRouteToOriginating) {
        return sendPayloadAsync(payload, undefined, false);
      }
      dispatcher.sendToolResult(payload);
    };
    const sendPlanUpdate = (payload: { explanation?: string; steps?: string[] }) => {
      if (!shouldEmitVerboseProgress()) {
        return;
      }
      const replyPayload: ReplyPayload = {
        text: formatPlanUpdateText(payload),
      };
      if (shouldRouteToOriginating) {
        return sendPayloadAsync(replyPayload, undefined, false);
      }
      dispatcher.sendToolResult(replyPayload);
    };
    const summarizeApprovalLabel = (payload: {
      status?: string;
      command?: string;
      message?: string;
    }) => {
      if (payload.status === "pending") {
        const command = normalizeOptionalString(payload.command);
        if (command) {
          return normalizeWorkingLabel(`awaiting approval: ${command}`);
        }
        return "awaiting approval";
      }
      if (payload.status === "unavailable") {
        const message = normalizeOptionalString(payload.message);
        if (message) {
          return normalizeWorkingLabel(message);
        }
        return "approval unavailable";
      }
      return "";
    };
    const summarizePatchLabel = (payload: { summary?: string; title?: string }) => {
      const summary = normalizeOptionalString(payload.summary);
      if (summary) {
        return normalizeWorkingLabel(summary);
      }
      const title = normalizeOptionalString(payload.title);
      if (title) {
        return normalizeWorkingLabel(title);
      }
      return "";
    };
    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (
        shouldSuppressLocalExecApprovalPrompt({
          accountId: ctx.AccountId,
          cfg,
          channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
          payload,
        })
      ) {
        return null;
      }
      if (shouldSendToolSummaries) {
        return payload;
      }
      const execApproval =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData)
          ? payload.channelData.execApproval
          : undefined;
      if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // Tool results (for example TTS audio) must still be delivered.
      const { hasMedia } = resolveSendableOutboundReplyParts(payload);
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    const typing = resolveRunTypingPolicy({
      originatingChannel,
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: params.replyOptions?.suppressTyping === true || shouldSuppressTyping,
      systemEvent: shouldRouteToOriginating,
    });

    const replyResolver =
      params.replyResolver ?? (await loadGetReplyFromConfigRuntime()).getReplyFromConfig;
    const replyResult = await replyResolver(
      ctx,
      {
        ...params.replyOptions,
        onApprovalEvent: ({ phase, status, command, message }) => {
          if (phase !== "requested") {
            return;
          }
          const label = summarizeApprovalLabel({ command, message, status });
          if (!label) {
            return;
          }
          return maybeSendWorkingStatus(label);
        },
        onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => {
          const run = async () => {
            // Suppress reasoning payloads — channels using this generic dispatch
            // Path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (payload.isReasoning === true) {
              return;
            }
            // Accumulate block text for TTS generation after streaming.
            // Exclude compaction status notices — they are informational UI
            // Signals and must not be synthesised into the spoken reply.
            if (payload.text && !payload.isCompactionNotice) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            // Channels that keep a live draft preview may need to rotate their
            // Preview state at the logical block boundary before queued block
            // Delivery drains asynchronously through the dispatcher.
            const payloadMetadata = getReplyPayloadMetadata(payload);
            const queuedContext =
              payloadMetadata?.assistantMessageIndex !== undefined
                ? {
                    ...context,
                    assistantMessageIndex: payloadMetadata.assistantMessageIndex,
                  }
                : context;
            await params.replyOptions?.onBlockReplyQueued?.(payload, queuedContext);
            const ttsPayload = await maybeApplyTtsToReplyPayload({
              cfg,
              channel: ttsChannel,
              inboundAudio,
              kind: "block",
              payload,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
        onPatchSummary: ({ phase, summary, title }) => {
          if (phase !== "end") {
            return;
          }
          const label = summarizePatchLabel({ summary, title });
          if (!label) {
            return;
          }
          return maybeSendWorkingStatus(label);
        },
        onPlanUpdate: ({ phase, explanation, steps }) => {
          if (phase !== "update") {
            return;
          }
          return sendPlanUpdate({ explanation, steps });
        },
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            const ttsPayload = await maybeApplyTtsToReplyPayload({
              cfg,
              channel: ttsChannel,
              inboundAudio,
              kind: "tool",
              payload,
              ttsAuto: sessionTtsAuto,
            });
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        suppressTyping: typing.suppressTyping,
        typingPolicy: typing.typingPolicy,
      },
      params.configOverride,
    );

    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      if (hookRunner?.hasHooks("reply_dispatch")) {
        const tailDispatchResult = await hookRunner.runReplyDispatch(
          {
            ctx,
            inboundAudio,
            isTailDispatch: true,
            originatingChannel,
            originatingTo,
            runId: params.replyOptions?.runId,
            sendPolicy: "allow",
            sessionKey: acpDispatchSessionKey,
            sessionTtsAuto,
            shouldRouteToOriginating,
            shouldSendToolSummaries,
            ttsChannel,
          },
          {
            abortSignal: params.replyOptions?.abortSignal,
            cfg,
            dispatcher,
            markIdle,
            onReplyStart: params.replyOptions?.onReplyStart,
            recordProcessed,
          },
        );
        if (tailDispatchResult?.handled) {
          return {
            counts: tailDispatchResult.counts,
            queuedFinal: tailDispatchResult.queuedFinal,
          };
        }
      }
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      // Suppress reasoning payloads from channel delivery — channels using this
      // Generic dispatch path do not have a dedicated reasoning lane.
      if (reply.isReasoning === true) {
        continue;
      }
      const finalReply = await sendFinalPayload(reply);
      queuedFinal = finalReply.queuedFinal || queuedFinal;
      routedFinalCount += finalReply.routedFinalCount;
    }

    const ttsMode = resolveConfiguredTtsMode(cfg);
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // But we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToReplyPayload({
          cfg,
          channel: ttsChannel,
          inboundAudio,
          kind: "final",
          payload: { text: accumulatedBlockText },
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
            mediaUrl: ttsSyntheticReply.mediaUrl,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReplyRuntime.routeReply({
              accountId: ctx.AccountId,
              cfg,
              channel: originatingChannel,
              groupId,
              isGroup,
              payload: ttsOnlyPayload,
              sessionKey: ctx.SessionKey,
              threadId: routeThreadId,
              to: originatingTo,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (error) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(error)}`,
        );
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed(
      "completed",
      pluginFallbackReason ? { reason: pluginFallbackReason } : undefined,
    );
    markIdle("message_completed");
    return { counts, queuedFinal };
  } catch (error) {
    recordProcessed("error", { error: String(error) });
    markIdle("message_error");
    throw error;
  }
}
