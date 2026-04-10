import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { resolveModelAuthMode } from "../../agents/model-auth.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import {
  type SessionEntry,
  loadSessionStore,
  resolveSessionPluginDebugLines,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import {
  buildFallbackClearedNotice,
  buildFallbackNotice,
  resolveFallbackTransition,
} from "../fallback-state.js";
import type { OriginatingChannelType, TemplateContext } from "../templating.js";
import { type VerboseLevel, resolveResponseUsageMode } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
  finalizeWithFollowup,
  isAudioPayload,
  signalTypingIfNeeded,
} from "./agent-runner-helpers.js";
import { runMemoryFlushIfNeeded, runPreflightCompactionIfNeeded } from "./agent-runner-memory.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import {
  appendUnscheduledReminderNote,
  hasSessionRelatedCronJobs,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-usage-line.js";
import { resolveQueuedReplyExecutionConfig } from "./agent-runner-utils.js";
import { createAudioAsVoiceBuffer, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { resolveEffectiveBlockStreamingConfig } from "./block-streaming.js";
import { createFollowupRunner } from "./followup-runner.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import {
  type FollowupRun,
  type QueueSettings,
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
} from "./queue.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";
import {
  type ReplyOperation,
  ReplyRunAlreadyActiveError,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { createReplyToModeFilterForChannel, resolveReplyToMode } from "./reply-threading.js";
import { incrementRunCompactionCount, persistRunSessionUsage } from "./session-run-accounting.js";
import { createTypingSignaler } from "./typing-mode.js";
import type { TypingController } from "./typing.js";

const BLOCK_REPLY_SEND_TIMEOUT_MS = 15_000;

function buildInlinePluginStatusPayload(entry: SessionEntry | undefined): ReplyPayload | undefined {
  const lines = resolveSessionPluginDebugLines(entry);
  if (lines.length === 0) {
    return undefined;
  }
  return { text: lines.join("\n") };
}

function refreshSessionEntryFromStore(params: {
  storePath?: string;
  sessionKey?: string;
  fallbackEntry?: SessionEntry;
  activeSessionStore?: Record<string, SessionEntry>;
}): SessionEntry | undefined {
  const { storePath, sessionKey, fallbackEntry, activeSessionStore } = params;
  if (!storePath || !sessionKey) {
    return fallbackEntry;
  }
  try {
    const latestStore = loadSessionStore(storePath, { skipCache: true });
    const latestEntry = latestStore?.[sessionKey];
    if (!latestEntry) {
      return fallbackEntry;
    }
    if (activeSessionStore) {
      activeSessionStore[sessionKey] = latestEntry;
    }
    return latestEntry;
  } catch {
    return fallbackEntry;
  }
}

export async function runReplyAgent(params: {
  commandBody: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isRunActive?: () => boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode;
  resetTriggered?: boolean;
  replyOperation?: ReplyOperation;
}): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    commandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens,
    resolvedVerboseLevel,
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
    resetTriggered,
    replyOperation: providedReplyOperation,
  } = params;

  let activeSessionEntry = sessionEntry;
  const activeSessionStore = sessionStore;
  let activeIsNewSession = isNewSession;

  const isHeartbeat = opts?.isHeartbeat === true;
  const typingSignals = createTypingSignaler({
    isHeartbeat,
    mode: typingMode,
    typing,
  });

  const shouldEmitToolResult = createShouldEmitToolResult({
    resolvedVerboseLevel,
    sessionKey,
    storePath,
  });
  const shouldEmitToolOutput = createShouldEmitToolOutput({
    resolvedVerboseLevel,
    sessionKey,
    storePath,
  });

  const pendingToolTasks = new Set<Promise<void>>();
  const blockReplyTimeoutMs = opts?.blockReplyTimeoutMs ?? BLOCK_REPLY_SEND_TIMEOUT_MS;
  const touchActiveSessionEntry = async () => {
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionStoreEntry({
        sessionKey,
        storePath,
        update: async () => ({ updatedAt }),
      });
    }
  };

  if (shouldSteer && isStreaming) {
    const steerSessionId =
      (sessionKey ? replyRunRegistry.resolveSessionId(sessionKey) : undefined) ??
      followupRun.run.sessionId;
    const steered = queueEmbeddedPiMessage(steerSessionId, followupRun.prompt);
    if (steered && !shouldFollowup) {
      await touchActiveSessionEntry();
      typing.cleanup();
      return undefined;
    }
  }

  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat,
    queueMode: resolvedQueue.mode,
    shouldFollowup,
  });

  const queuedRunFollowupTurn = createFollowupRunner({
    agentCfgContextTokens,
    defaultModel,
    opts,
    sessionEntry: activeSessionEntry,
    sessionKey,
    sessionStore: activeSessionStore,
    storePath,
    typing,
    typingMode,
  });

  if (activeRunQueueAction === "drop") {
    typing.cleanup();
    return undefined;
  }

  if (activeRunQueueAction === "enqueue-followup") {
    enqueueFollowupRun(
      queueKey,
      followupRun,
      resolvedQueue,
      "message-id",
      queuedRunFollowupTurn,
      false,
    );
    // Re-check liveness after enqueue so a stale active snapshot cannot leave
    // The followup queue idle if the original run already finished.
    if (!isRunActive?.()) {
      finalizeWithFollowup(undefined, queueKey, queuedRunFollowupTurn);
    }
    await touchActiveSessionEntry();
    typing.cleanup();
    return undefined;
  }

  followupRun.run.config = await resolveQueuedReplyExecutionConfig(followupRun.run.config);

  const replyToChannel = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Surface ?? sessionCtx.Provider,
  }) as OriginatingChannelType | undefined;
  const replyToMode = resolveReplyToMode(
    followupRun.run.config,
    replyToChannel,
    sessionCtx.AccountId,
    sessionCtx.ChatType,
  );
  const applyReplyToMode = createReplyToModeFilterForChannel(replyToMode, replyToChannel);
  const cfg = followupRun.run.config;
  const normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
    cfg,
    sessionKey,
    workspaceDir: followupRun.run.workspaceDir,
  });
  const blockReplyCoalescing =
    blockStreamingEnabled && opts?.onBlockReply
      ? resolveEffectiveBlockStreamingConfig({
          accountId: sessionCtx.AccountId,
          cfg,
          chunking: blockReplyChunking,
          provider: sessionCtx.Provider,
        }).coalescing
      : undefined;
  const blockReplyPipeline =
    blockStreamingEnabled && opts?.onBlockReply
      ? createBlockReplyPipeline({
          buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
          coalescing: blockReplyCoalescing,
          onBlockReply: opts.onBlockReply,
          timeoutMs: blockReplyTimeoutMs,
        })
      : null;

  const replySessionKey = sessionKey ?? followupRun.run.sessionKey;
  let replyOperation: ReplyOperation;
  try {
    replyOperation =
      providedReplyOperation ??
      createReplyOperation({
        resetTriggered: resetTriggered === true,
        sessionId: followupRun.run.sessionId,
        sessionKey: replySessionKey ?? "",
        upstreamAbortSignal: opts?.abortSignal,
      });
  } catch (error) {
    if (error instanceof ReplyRunAlreadyActiveError) {
      typing.cleanup();
      return {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      };
    }
    throw error;
  }
  let runFollowupTurn = queuedRunFollowupTurn;

  try {
    await typingSignals.signalRunStart();

    activeSessionEntry = await runPreflightCompactionIfNeeded({
      agentCfgContextTokens,
      cfg,
      defaultModel,
      followupRun,
      isHeartbeat,
      promptForEstimate: followupRun.prompt,
      replyOperation,
      sessionEntry: activeSessionEntry,
      sessionKey,
      sessionStore: activeSessionStore,
      storePath,
    });

    activeSessionEntry = await runMemoryFlushIfNeeded({
      agentCfgContextTokens,
      cfg,
      defaultModel,
      followupRun,
      isHeartbeat,
      opts,
      promptForEstimate: followupRun.prompt,
      replyOperation,
      resolvedVerboseLevel,
      sessionCtx,
      sessionEntry: activeSessionEntry,
      sessionKey,
      sessionStore: activeSessionStore,
      storePath,
    });

    runFollowupTurn = createFollowupRunner({
      agentCfgContextTokens,
      defaultModel,
      opts,
      sessionEntry: activeSessionEntry,
      sessionKey,
      sessionStore: activeSessionStore,
      storePath,
      typing,
      typingMode,
    });

    let responseUsageLine: string | undefined;
    interface SessionResetOptions {
      failureLabel: string;
      buildLogMessage: (nextSessionId: string) => string;
      cleanupTranscripts?: boolean;
    }
    const resetSession = async ({
      failureLabel,
      buildLogMessage,
      cleanupTranscripts,
    }: SessionResetOptions): Promise<boolean> =>
      await resetReplyRunSession({
        activeSessionEntry,
        activeSessionStore,
        followupRun,
        messageThreadId:
          typeof sessionCtx.MessageThreadId === "string" ? sessionCtx.MessageThreadId : undefined,
        onActiveSessionEntry: (nextEntry) => {
          activeSessionEntry = nextEntry;
        },
        onNewSession: () => {
          activeIsNewSession = true;
        },
        options: {
          buildLogMessage,
          cleanupTranscripts,
          failureLabel,
        },
        queueKey,
        sessionKey,
        storePath,
      });
    const resetSessionAfterCompactionFailure = async (reason: string): Promise<boolean> =>
      resetSession({
        buildLogMessage: (nextSessionId) =>
          `Auto-compaction failed (${reason}). Restarting session ${sessionKey} -> ${nextSessionId} and retrying.`,
        failureLabel: "compaction failure",
      });
    const resetSessionAfterRoleOrderingConflict = async (reason: string): Promise<boolean> =>
      resetSession({
        buildLogMessage: (nextSessionId) =>
          `Role ordering conflict (${reason}). Restarting session ${sessionKey} -> ${nextSessionId}.`,
        cleanupTranscripts: true,
        failureLabel: "role ordering conflict",
      });

    replyOperation.setPhase("running");
    const runStartedAt = Date.now();
    const runOutcome = await runAgentTurnWithFallback({
      activeSessionStore,
      applyReplyToMode,
      blockReplyChunking,
      blockReplyPipeline,
      blockStreamingEnabled,
      commandBody,
      followupRun,
      getActiveSessionEntry: () => activeSessionEntry,
      isHeartbeat,
      opts,
      pendingToolTasks,
      replyOperation,
      resetSessionAfterCompactionFailure,
      resetSessionAfterRoleOrderingConflict,
      resolvedBlockStreamingBreak,
      resolvedVerboseLevel,
      sessionCtx,
      sessionKey,
      shouldEmitToolOutput,
      shouldEmitToolResult,
      storePath,
      typingSignals,
    });

    if (runOutcome.kind === "final") {
      if (!replyOperation.result) {
        replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
      }
      return finalizeWithFollowup(runOutcome.payload, queueKey, runFollowupTurn);
    }

    const {
      runId,
      runResult,
      fallbackProvider,
      fallbackModel,
      fallbackAttempts,
      directlySentBlockKeys,
    } = runOutcome;
    let { didLogHeartbeatStrip, autoCompactionCount } = runOutcome;

    if (
      shouldInjectGroupIntro &&
      activeSessionEntry &&
      activeSessionStore &&
      sessionKey &&
      activeSessionEntry.groupActivationNeedsSystemIntro
    ) {
      const updatedAt = Date.now();
      activeSessionEntry.groupActivationNeedsSystemIntro = false;
      activeSessionEntry.updatedAt = updatedAt;
      activeSessionStore[sessionKey] = activeSessionEntry;
      if (storePath) {
        await updateSessionStoreEntry({
          sessionKey,
          storePath,
          update: async () => ({
            groupActivationNeedsSystemIntro: false,
            updatedAt,
          }),
        });
      }
    }

    const payloadArray = runResult.payloads ?? [];

    if (blockReplyPipeline) {
      await blockReplyPipeline.flush({ force: true });
      blockReplyPipeline.stop();
    }
    if (pendingToolTasks.size > 0) {
      await Promise.allSettled(pendingToolTasks);
    }

    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? defaultModel;
    const providerUsed =
      runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? followupRun.run.provider;
    const verboseEnabled = resolvedVerboseLevel !== "off";
    const selectedProvider = followupRun.run.provider;
    const selectedModel = followupRun.run.model;
    const fallbackStateEntry =
      activeSessionEntry ?? (sessionKey ? activeSessionStore?.[sessionKey] : undefined);
    const fallbackTransition = resolveFallbackTransition({
      activeModel: modelUsed,
      activeProvider: providerUsed,
      attempts: fallbackAttempts,
      selectedModel,
      selectedProvider,
      state: fallbackStateEntry,
    });
    if (fallbackTransition.stateChanged) {
      if (fallbackStateEntry) {
        fallbackStateEntry.fallbackNoticeSelectedModel = fallbackTransition.nextState.selectedModel;
        fallbackStateEntry.fallbackNoticeActiveModel = fallbackTransition.nextState.activeModel;
        fallbackStateEntry.fallbackNoticeReason = fallbackTransition.nextState.reason;
        fallbackStateEntry.updatedAt = Date.now();
        activeSessionEntry = fallbackStateEntry;
      }
      if (sessionKey && fallbackStateEntry && activeSessionStore) {
        activeSessionStore[sessionKey] = fallbackStateEntry;
      }
      if (sessionKey && storePath) {
        await updateSessionStoreEntry({
          sessionKey,
          storePath,
          update: async () => ({
            fallbackNoticeActiveModel: fallbackTransition.nextState.activeModel,
            fallbackNoticeReason: fallbackTransition.nextState.reason,
            fallbackNoticeSelectedModel: fallbackTransition.nextState.selectedModel,
          }),
        });
      }
    }
    const cliSessionId = isCliProvider(providerUsed, cfg)
      ? normalizeOptionalString(runResult.meta?.agentMeta?.sessionId)
      : undefined;
    const cliSessionBinding = isCliProvider(providerUsed, cfg)
      ? runResult.meta?.agentMeta?.cliSessionBinding
      : undefined;
    const contextTokensUsed =
      resolveContextTokensForModel({
        allowAsyncLoad: false,
        cfg,
        contextTokensOverride: agentCfgContextTokens,
        fallbackContextTokens: activeSessionEntry?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        model: modelUsed,
        provider: providerUsed,
      }) ?? DEFAULT_CONTEXT_TOKENS;

    await persistRunSessionUsage({
      cfg,
      cliSessionBinding,
      cliSessionId,
      contextTokensUsed,
      lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
      modelUsed,
      promptTokens,
      providerUsed,
      sessionKey,
      storePath,
      systemPromptReport: runResult.meta?.systemPromptReport,
      usage,
      usageIsContextSnapshot: isCliProvider(providerUsed, cfg),
    });

    // Drain any late tool/block deliveries before deciding there's "nothing to send".
    // Otherwise, a late typing trigger (e.g. from a tool callback) can outlive the run and
    // Keep the typing indicator stuck.
    if (payloadArray.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const payloadResult = await buildReplyPayloads({
      accountId: sessionCtx.AccountId,
      blockReplyPipeline,
      blockStreamingEnabled,
      currentMessageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
      didLogHeartbeatStrip,
      directlySentBlockKeys,
      isHeartbeat,
      messageProvider: followupRun.run.messageProvider,
      messagingToolSentMediaUrls: runResult.messagingToolSentMediaUrls,
      messagingToolSentTargets: runResult.messagingToolSentTargets,
      messagingToolSentTexts: runResult.messagingToolSentTexts,
      normalizeMediaPaths: normalizeReplyMediaPaths,
      originatingChannel: sessionCtx.OriginatingChannel,
      originatingTo: resolveOriginMessageTo({
        originatingTo: sessionCtx.OriginatingTo,
        to: sessionCtx.To,
      }),
      payloads: payloadArray,
      replyThreading: sessionCtx.ReplyThreading,
      replyToChannel,
      replyToMode,
      silentExpected: followupRun.run.silentExpected,
    });
    const { replyPayloads } = payloadResult;
    ({ didLogHeartbeatStrip } = payloadResult);

    if (replyPayloads.length === 0) {
      return finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    }

    const successfulCronAdds = runResult.successfulCronAdds ?? 0;
    const hasReminderCommitment = replyPayloads.some(
      (payload) =>
        !payload.isError &&
        typeof payload.text === "string" &&
        hasUnbackedReminderCommitment(payload.text),
    );
    // Suppress the guard note when an existing cron job (created in a prior
    // Turn) already covers the commitment — avoids false positives (#32228).
    const coveredByExistingCron =
      hasReminderCommitment && successfulCronAdds === 0
        ? await hasSessionRelatedCronJobs({
            cronStorePath: cfg.cron?.store,
            sessionKey,
          })
        : false;
    const guardedReplyPayloads =
      hasReminderCommitment && successfulCronAdds === 0 && !coveredByExistingCron
        ? appendUnscheduledReminderNote(replyPayloads)
        : replyPayloads;

    await signalTypingIfNeeded(guardedReplyPayloads, typingSignals);

    if (isDiagnosticsEnabled(cfg) && hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const promptTokens = input + cacheRead + cacheWrite;
      const totalTokens = usage.total ?? promptTokens + output;
      const costConfig = resolveModelCostConfig({
        config: cfg,
        model: modelUsed,
        provider: providerUsed,
      });
      const costUsd = estimateUsageCost({ cost: costConfig, usage });
      emitDiagnosticEvent({
        channel: replyToChannel,
        context: {
          limit: contextTokensUsed,
          used: totalTokens,
        },
        costUsd,
        durationMs: Date.now() - runStartedAt,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        model: modelUsed,
        provider: providerUsed,
        sessionId: followupRun.run.sessionId,
        sessionKey,
        type: "model.usage",
        usage: {
          cacheRead,
          cacheWrite,
          input,
          output,
          promptTokens,
          total: totalTokens,
        },
      });
    }

    const responseUsageRaw =
      activeSessionEntry?.responseUsage ??
      (sessionKey ? activeSessionStore?.[sessionKey]?.responseUsage : undefined);
    const responseUsageMode = resolveResponseUsageMode(responseUsageRaw);
    if (responseUsageMode !== "off" && hasNonzeroUsage(usage)) {
      const authMode = resolveModelAuthMode(providerUsed, cfg);
      const showCost = authMode === "api-key";
      const costConfig = showCost
        ? resolveModelCostConfig({
            config: cfg,
            model: modelUsed,
            provider: providerUsed,
          })
        : undefined;
      let formatted = formatResponseUsageLine({
        costConfig,
        showCost,
        usage,
      });
      if (formatted && responseUsageMode === "full" && sessionKey) {
        formatted = `${formatted} · session \`${sessionKey}\``;
      }
      if (formatted) {
        responseUsageLine = formatted;
      }
    }

    if (verboseEnabled) {
      activeSessionEntry = refreshSessionEntryFromStore({
        activeSessionStore,
        fallbackEntry: activeSessionEntry,
        sessionKey,
        storePath,
      });
    }

    // If verbose is enabled, prepend operational run notices.
    let finalPayloads = guardedReplyPayloads;
    const verboseNotices: ReplyPayload[] = [];

    if (verboseEnabled && activeIsNewSession) {
      verboseNotices.push({ text: `🧭 New session: ${followupRun.run.sessionId}` });
    }

    if (fallbackTransition.fallbackTransitioned) {
      emitAgentEvent({
        data: {
          activeModel: modelUsed,
          activeProvider: providerUsed,
          attemptSummaries: fallbackTransition.attemptSummaries,
          attempts: fallbackAttempts,
          phase: "fallback",
          reasonSummary: fallbackTransition.reasonSummary,
          selectedModel,
          selectedProvider,
        },
        runId,
        sessionKey,
        stream: "lifecycle",
      });
      if (verboseEnabled) {
        const fallbackNotice = buildFallbackNotice({
          activeModel: modelUsed,
          activeProvider: providerUsed,
          attempts: fallbackAttempts,
          selectedModel,
          selectedProvider,
        });
        if (fallbackNotice) {
          verboseNotices.push({ text: fallbackNotice });
        }
      }
    }
    if (fallbackTransition.fallbackCleared) {
      emitAgentEvent({
        data: {
          activeModel: modelUsed,
          activeProvider: providerUsed,
          phase: "fallback_cleared",
          previousActiveModel: fallbackTransition.previousState.activeModel,
          selectedModel,
          selectedProvider,
        },
        runId,
        sessionKey,
        stream: "lifecycle",
      });
      if (verboseEnabled) {
        verboseNotices.push({
          text: buildFallbackClearedNotice({
            previousActiveModel: fallbackTransition.previousState.activeModel,
            selectedModel,
            selectedProvider,
          }),
        });
      }
    }

    if (autoCompactionCount > 0) {
      const previousSessionId = activeSessionEntry?.sessionId ?? followupRun.run.sessionId;
      const count = await incrementRunCompactionCount({
        amount: autoCompactionCount,
        cfg,
        contextTokensUsed,
        lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
        newSessionId: runResult.meta?.agentMeta?.sessionId,
        sessionEntry: activeSessionEntry,
        sessionKey,
        sessionStore: activeSessionStore,
        storePath,
      });
      const refreshedSessionEntry =
        sessionKey && activeSessionStore ? activeSessionStore[sessionKey] : undefined;
      if (refreshedSessionEntry) {
        activeSessionEntry = refreshedSessionEntry;
        refreshQueuedFollowupSession({
          key: queueKey,
          nextSessionFile: refreshedSessionEntry.sessionFile,
          nextSessionId: refreshedSessionEntry.sessionId,
          previousSessionId,
        });
      }

      // Inject post-compaction workspace context for the next agent turn
      if (sessionKey) {
        const workspaceDir = process.cwd();
        readPostCompactionContext(workspaceDir, cfg)
          .then((contextContent) => {
            if (contextContent) {
              enqueueSystemEvent(contextContent, { sessionKey });
            }
          })
          .catch(() => {
            // Silent failure — post-compaction context is best-effort
          });
      }

      if (verboseEnabled) {
        const suffix = typeof count === "number" ? ` (count ${count})` : "";
        verboseNotices.push({ text: `🧹 Auto-compaction complete${suffix}.` });
      }
    }
    const prefixPayloads = [...verboseNotices];
    if (verboseEnabled) {
      const pluginStatusPayload = buildInlinePluginStatusPayload(activeSessionEntry);
      if (pluginStatusPayload) {
        prefixPayloads.push(pluginStatusPayload);
      }
    }
    if (prefixPayloads.length > 0) {
      finalPayloads = [...prefixPayloads, ...finalPayloads];
    }
    if (responseUsageLine) {
      finalPayloads = appendUsageLine(finalPayloads, responseUsageLine);
    }

    return finalizeWithFollowup(
      finalPayloads.length === 1 ? finalPayloads[0] : finalPayloads,
      queueKey,
      runFollowupTurn,
    );
  } catch (error) {
    if (
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart"
    ) {
      return finalizeWithFollowup(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        queueKey,
        runFollowupTurn,
      );
    }
    if (replyOperation.result?.kind === "aborted") {
      return finalizeWithFollowup({ text: SILENT_REPLY_TOKEN }, queueKey, runFollowupTurn);
    }
    if (error instanceof GatewayDrainingError) {
      replyOperation.fail("gateway_draining", error);
      return finalizeWithFollowup(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        queueKey,
        runFollowupTurn,
      );
    }
    if (error instanceof CommandLaneClearedError) {
      replyOperation.fail("command_lane_cleared", error);
      return finalizeWithFollowup(
        { text: "⚠️ Gateway is restarting. Please wait a few seconds and try again." },
        queueKey,
        runFollowupTurn,
      );
    }
    replyOperation.fail("run_failed", error);
    // Keep the followup queue moving even when an unexpected exception escapes
    // The run path; the caller still receives the original error.
    finalizeWithFollowup(undefined, queueKey, runFollowupTurn);
    throw error;
  } finally {
    replyOperation.complete();
    blockReplyPipeline?.stop();
    typing.markRunComplete();
    // Safety net: the dispatcher's onIdle callback normally fires
    // MarkDispatchIdle(), but if the dispatcher exits early, errors,
    // Or the reply path doesn't go through it cleanly, the second
    // Signal never fires and the typing keepalive loop runs forever.
    // Calling this twice is harmless — cleanup() is guarded by the
    // `active` flag.  Same pattern as the followup runner fix (#26881).
    typing.markDispatchIdle();
  }
}
