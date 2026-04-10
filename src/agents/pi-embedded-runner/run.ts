import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import {
  ensureContextEnginesInitialized,
  resolveContextEngine,
} from "../../context-engine/index.js";
import { emitAgentPlanEvent } from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { hasConfiguredModelFallbacks } from "../agent-scope.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markAuthProfileGood,
  markAuthProfileUsed,
  resolveAuthProfileEligibility,
} from "../auth-profiles.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../command/session.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverStatus,
} from "../failover-error.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { clearLiveModelSwitchPending, shouldSwitchToLiveModel } from "../live-model-switch.js";
import {
  type ResolvedProviderAuth,
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { disposeSessionMcpRuntime } from "../pi-bundle-mcp-tools.js";
import {
  type FailoverReason,
  classifyFailoverReason,
  extractObservedOverflowTokenCount,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isLikelyContextOverflowError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../pi-embedded-helpers.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { type UsageLike, derivePromptTokens, normalizeUsage } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runPostCompactionSideEffects } from "./compact.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModelAsync } from "./model.js";
import { handleAssistantFailover } from "./run/assistant-failover.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { createEmbeddedRunAuthController } from "./run/auth-controller.js";
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./run/failover-policy.js";
import {
  type RuntimeAuthState,
  buildErrorAgentMeta,
  buildUsageAgentMetaFields,
  createCompactionDiagId,
  resolveActiveErrorContext,
  resolveFinalAssistantVisibleText,
  resolveMaxRunRetryIterations,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  scrubAnthropicRefusalMagic,
} from "./run/helpers.js";
import {
  extractPlanningOnlyPlanDetails,
  resolveAckExecutionFastPathInstruction,
  resolveIncompleteTurnPayloadText,
  resolvePlanningOnlyRetryInstruction,
} from "./run/incomplete-turn.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import { resolveEffectiveRuntimeModel, resolveHookModelSelection } from "./run/setup.js";
import {
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "./usage-accumulator.js";

type ApiKeyInfo = ResolvedProviderAuth;

const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;

/**
 * Best-effort backfill of sessionKey from sessionId when not explicitly provided.
 * The return value is normalized: whitespace-only inputs collapse to undefined, and
 * successful resolution returns a trimmed session key. This is a read-only lookup
 * with no side effects.
 * See: https://github.com/openclaw/openclaw/issues/60552
 */
function backfillSessionKey(params: {
  config: RunEmbeddedPiAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          agentId: params.agentId,
          cfg: params.config,
          sessionId: params.sessionId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (error) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // Receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    agentId: params.agentId,
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  if (effectiveSessionKey !== params.sessionKey) {
    params = { ...params, sessionKey: effectiveSessionKey };
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  const throwIfAborted = () => {
    if (!params.abortSignal?.aborted) {
      return;
    }
    const { reason } = params.abortSignal;
    if (reason instanceof Error) {
      throw reason;
    }
    const abortErr =
      reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  };

  throwIfAborted();

  return enqueueSession(() => {
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      const started = Date.now();
      const workspaceResolution = resolveRunWorkspaceDir({
        agentId: params.agentId,
        config: params.config,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      ensureRuntimePluginsLoaded({
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
        config: params.config,
        workspaceDir: resolvedWorkspace,
      });

      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
      const normalizedSessionKey = params.sessionKey?.trim();
      const fallbackConfigured = hasConfiguredModelFallbacks({
        agentId: params.agentId,
        cfg: params.config,
        sessionKey: normalizedSessionKey,
      });
      await ensureOpenClawModelsJson(params.config, agentDir);
      const resolvedSessionKey = normalizedSessionKey;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        agentId: workspaceResolution.agentId,
        channelId: params.messageChannel ?? params.messageProvider ?? undefined,
        messageProvider: params.messageProvider ?? undefined,
        modelId,
        modelProviderId: provider,
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: resolvedSessionKey,
        trigger: params.trigger,
        workspaceDir: resolvedWorkspace,
      };

      const hookSelection = await resolveHookModelSelection({
        hookContext: hookCtx,
        hookRunner,
        modelId,
        prompt: params.prompt,
        provider,
      });
      ({ provider } = hookSelection);
      ({ modelId } = hookSelection);
      const { legacyBeforeAgentStartResult } = hookSelection;

      const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          model: modelId,
          provider,
          reason: "model_not_found",
        });
      }
      let runtimeModel = model;

      const resolvedRuntimeModel = resolveEffectiveRuntimeModel({
        cfg: params.config,
        modelId,
        provider,
        runtimeModel,
      });
      const { ctxInfo } = resolvedRuntimeModel;
      let { effectiveModel } = resolvedRuntimeModel;

      const authStore = ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
      });
      const preferredProfileId = params.authProfileId?.trim();
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      if (lockedProfileId) {
        const eligibility = resolveAuthProfileEligibility({
          cfg: params.config,
          profileId: lockedProfileId,
          provider,
          store: authStore,
        });
        if (!eligibility.eligible) {
          throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
        }
      }
      const profileOrder = shouldPreferExplicitConfigApiKeyAuth(params.config, provider)
        ? []
        : resolveAuthProfileOrder({
            cfg: params.config,
            preferredProfile: preferredProfileId,
            provider,
            store: authStore,
          });
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined];
      let profileIndex = 0;

      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;
      let runtimeAuthState: RuntimeAuthState | null = null;
      let runtimeAuthRefreshCancelled = false;
      const {
        advanceAuthProfile,
        initializeAuthProfile,
        maybeRefreshRuntimeAuthForAuthError,
        stopRuntimeAuthRefreshTimer,
      } = createEmbeddedRunAuthController({
        agentDir,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
        attemptedThinking,
        authStorage,
        authStore,
        config: params.config,
        fallbackConfigured,
        getApiKeyInfo: () => apiKeyInfo,
        getEffectiveModel: () => effectiveModel,
        getLastProfileId: () => lastProfileId,
        getModelId: () => modelId,
        getProfileIndex: () => profileIndex,
        getProvider: () => provider,
        getRuntimeAuthRefreshCancelled: () => runtimeAuthRefreshCancelled,
        getRuntimeAuthState: () => runtimeAuthState,
        getRuntimeModel: () => runtimeModel,
        initialThinkLevel,
        lockedProfileId,
        log,
        profileCandidates,
        setApiKeyInfo: (next) => {
          apiKeyInfo = next;
        },
        setEffectiveModel: (next) => {
          effectiveModel = next;
        },
        setLastProfileId: (next) => {
          lastProfileId = next;
        },
        setProfileIndex: (next) => {
          profileIndex = next;
        },
        setRuntimeAuthRefreshCancelled: (next) => {
          runtimeAuthRefreshCancelled = next;
        },
        setRuntimeAuthState: (next) => {
          runtimeAuthState = next;
        },
        setRuntimeModel: (next) => {
          runtimeModel = next;
        },
        setThinkLevel: (next) => {
          thinkLevel = next;
        },
        workspaceDir: resolvedWorkspace,
      });

      await initializeAuthProfile();

      const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);
      let overflowCompactionAttempts = 0;
      let toolResultTruncationAttempted = false;
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0;
      let runLoopIterations = 0;
      let overloadProfileRotations = 0;
      let planningOnlyRetryAttempts = 0;
      let sameModelIdleTimeoutRetries = 0;
      let lastRetryFailoverReason: FailoverReason | null = null;
      let planningOnlyRetryInstruction: string | null = null;
      const ackExecutionFastPathInstruction = resolveAckExecutionFastPathInstruction({
        modelId,
        prompt: params.prompt,
        provider,
      });
      let rateLimitProfileRotations = 0;
      let timeoutCompactionAttempts = 0;
      const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs(params.config);
      const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit(params.config);
      const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit(params.config);
      const maybeEscalateRateLimitProfileFallback = (params: {
        failoverProvider: string;
        failoverModel: string;
        logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
      }) => {
        rateLimitProfileRotations += 1;
        if (rateLimitProfileRotations <= rateLimitProfileRotationLimit || !fallbackConfigured) {
          return;
        }
        const status = resolveFailoverStatus("rate_limit");
        log.warn(
          `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
        params.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            model: params.failoverModel,
            profileId: lastProfileId,
            provider: params.failoverProvider,
            reason: "rate_limit",
            status,
          },
        );
      };
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
        modelId?: string;
      }) => {
        const { profileId, reason } = failure;
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          agentDir,
          cfg: params.config,
          modelId: failure.modelId,
          profileId,
          reason,
          runId: params.runId,
          store: authStore,
        });
      };
      const resolveAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
      ): AuthProfileFailureReason | null => {
        // Timeouts are transport/model-path failures, not auth health signals,
        // So they should not persist auth-profile failure state.
        if (!failoverReason || failoverReason === "timeout") {
          return null;
        }
        return failoverReason;
      };
      const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
        if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) {
          return;
        }
        log.warn(
          `overload backoff before failover for ${provider}/${modelId}: delayMs=${overloadFailoverBackoffMs}`,
        );
        try {
          await sleepWithAbort(overloadFailoverBackoffMs, params.abortSignal);
        } catch (error) {
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: error });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw error;
        }
      };
      // Resolve the context engine once and reuse across retries to avoid
      // Repeated initialization/connection overhead per attempt.
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      try {
        // When the engine owns compaction, compactEmbeddedPiSessionDirect is
        // Bypassed. Fire lifecycle hooks here so recovery paths still notify
        // Subscribers like memory extensions and usage trackers.
        const runOwnsCompactionBeforeHook = async (reason: string) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !hookRunner?.hasHooks("before_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runBeforeCompaction(
              { messageCount: -1, sessionFile: params.sessionFile },
              hookCtx,
            );
          } catch (error) {
            log.warn(`before_compaction hook failed during ${reason}: ${String(error)}`);
          }
        };
        const runOwnsCompactionAfterHook = async (
          reason: string,
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
        ) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !compactResult.ok ||
            !compactResult.compacted ||
            !hookRunner?.hasHooks("after_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runAfterCompaction(
              {
                compactedCount: -1,
                messageCount: -1,
                sessionFile: params.sessionFile,
                tokenCount: compactResult.result?.tokensAfter,
              },
              hookCtx,
            );
          } catch (error) {
            log.warn(`after_compaction hook failed during ${reason}: ${String(error)}`);
          }
        };
        let authRetryPending = false;
        // Hoisted so the retry-limit error path can use the most recent API total.
        let lastTurnTotal: number | undefined;
        while (true) {
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            const retryLimitDecision = resolveRunFailoverDecision({
              failoverReason: lastRetryFailoverReason,
              fallbackConfigured,
              stage: "retry_limit",
            });
            return handleRetryLimitExhaustion({
              agentMeta: buildErrorAgentMeta({
                lastRunPromptUsage,
                lastTurnTotal,
                model: model.id,
                provider,
                sessionId: params.sessionId,
                usageAccumulator,
              }),
              decision: retryLimitDecision,
              durationMs: Date.now() - started,
              message,
              model: modelId,
              profileId: lastProfileId,
              provider,
            });
          }
          runLoopIterations += 1;
          const runtimeAuthRetry = authRetryPending;
          authRetryPending = false;
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });

          const basePrompt =
            provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt;
          const promptAdditions = [
            ackExecutionFastPathInstruction,
            planningOnlyRetryInstruction,
          ].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          const prompt =
            promptAdditions.length > 0
              ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}`
              : basePrompt;
          let resolvedStreamApiKey: string | undefined;
          if (!runtimeAuthState && apiKeyInfo) {
            resolvedStreamApiKey = (apiKeyInfo as ApiKeyInfo).apiKey;
          }

          const attempt = await runEmbeddedAttempt({
            abortSignal: params.abortSignal,
            agentAccountId: params.agentAccountId,
            agentDir,
            agentId: workspaceResolution.agentId,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            authStorage,
            bashElevated: params.bashElevated,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            bootstrapContextMode: params.bootstrapContextMode,
            bootstrapContextRunKind: params.bootstrapContextRunKind,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
            bootstrapPromptWarningSignaturesSeen,
            clientTools: params.clientTools,
            config: params.config,
            contextEngine,
            contextTokenBudget: ctxInfo.tokens,
            currentChannelId: params.currentChannelId,
            currentMessageId: params.currentMessageId,
            currentThreadTs: params.currentThreadTs,
            disableTools: params.disableTools,
            enforceFinalTag: params.enforceFinalTag,
            execOverrides: params.execOverrides,
            extraSystemPrompt: params.extraSystemPrompt,
            fastMode: params.fastMode,
            groupChannel: params.groupChannel,
            groupId: params.groupId,
            groupSpace: params.groupSpace,
            hasRepliedRef: params.hasRepliedRef,
            imageOrder: params.imageOrder,
            images: params.images,
            inputProvenance: params.inputProvenance,
            legacyBeforeAgentStartResult,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            messageThreadId: params.messageThreadId,
            messageTo: params.messageTo,
            model: applyAuthHeaderOverride(
              applyLocalNoAuthHeaderOverride(effectiveModel, apiKeyInfo),
              // When runtime auth exchange produced a different credential
              // (runtimeAuthState is set), the exchanged token lives in
              // AuthStorage and the SDK will pick it up automatically.
              // Skip header injection to avoid leaking the pre-exchange key.
              runtimeAuthState ? null : apiKeyInfo,
              params.config,
            ),
            modelId,
            modelRegistry,
            onAgentEvent: params.onAgentEvent,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            onPartialReply: params.onPartialReply,
            onReasoningEnd: params.onReasoningEnd,
            onReasoningStream: params.onReasoningStream,
            onToolResult: params.onToolResult,
            ownerNumbers: params.ownerNumbers,
            prompt,
            provider,
            reasoningLevel: params.reasoningLevel,
            replyOperation: params.replyOperation,
            replyToMode: params.replyToMode,
            resolvedApiKey: resolvedStreamApiKey,
            runId: params.runId,
            senderE164: params.senderE164,
            senderId: params.senderId,
            senderIsOwner: params.senderIsOwner,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            sessionKey: resolvedSessionKey,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            shouldEmitToolResult: params.shouldEmitToolResult,
            silentExpected: params.silentExpected,
            skillsSnapshot: params.skillsSnapshot,
            spawnedBy: params.spawnedBy,
            streamParams: params.streamParams,
            thinkLevel,
            timeoutMs: params.timeoutMs,
            toolResultFormat: resolvedToolResultFormat,
            trigger: params.trigger,
            verboseLevel: params.verboseLevel,
            workspaceDir: resolvedWorkspace,
          });

          const {
            aborted,
            promptError,
            promptErrorSource,
            preflightRecovery,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            sessionIdUsed,
            lastAssistant,
          } = attempt;
          bootstrapPromptWarningSignaturesSeen =
            attempt.bootstrapPromptWarningSignaturesSeen ??
            (attempt.bootstrapPromptWarningSignature
              ? [
                  ...new Set([
                    ...bootstrapPromptWarningSignaturesSeen,
                    attempt.bootstrapPromptWarningSignature,
                  ]),
                ]
              : bootstrapPromptWarningSignaturesSeen);
          const lastAssistantUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // Keep prompt size from the latest model call so session totalTokens
          // Reflects current context usage, not accumulated tool-loop usage.
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          const activeErrorContext = resolveActiveErrorContext({
            lastAssistant,
            model: modelId,
            provider,
          });
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                model: activeErrorContext.model,
                provider: activeErrorContext.provider,
                sessionKey: resolvedSessionKey ?? params.sessionId,
              })
            : undefined;
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;
          const canRestartForLiveSwitch =
            !attempt.didSendViaMessagingTool &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            attempt.toolMetas.length === 0 &&
            attempt.assistantTexts.length === 0;
          if (preflightRecovery?.handled) {
            log.info(
              `[context-overflow-precheck] early recovery route=${preflightRecovery.route} ` +
                `completed for ${provider}/${modelId}; retrying prompt`,
            );
            continue;
          }
          const requestedSelection = shouldSwitchToLiveModel({
            agentId: params.agentId,
            cfg: params.config,
            currentAuthProfileId: preferredProfileId,
            currentAuthProfileIdSource: params.authProfileIdSource,
            currentModel: modelId,
            currentProvider: provider,
            defaultModel: DEFAULT_MODEL,
            defaultProvider: DEFAULT_PROVIDER,
            sessionKey: resolvedSessionKey,
          });
          if (requestedSelection && canRestartForLiveSwitch) {
            await clearLiveModelSwitchPending({
              agentId: params.agentId,
              cfg: params.config,
              sessionKey: resolvedSessionKey,
            });
            log.info(
              `live session model switch requested during active attempt for ${params.sessionId}: ${provider}/${modelId} -> ${requestedSelection.provider}/${requestedSelection.model}`,
            );
            throw new LiveSessionModelSwitchError(requestedSelection);
          }
          // ── Timeout-triggered compaction ──────────────────────────────────
          // When the LLM times out with high context usage, compact before
          // Retrying to break the death spiral of repeated timeouts.
          if (timedOut && !timedOutDuringCompaction) {
            // Only consider prompt-side tokens here. API totals include output
            // Tokens, which can make a long generation look like high context
            // Pressure even when the prompt itself was small.
            const lastTurnPromptTokens = derivePromptTokens(lastRunPromptUsage);
            const tokenUsedRatio =
              lastTurnPromptTokens != null && ctxInfo.tokens > 0
                ? lastTurnPromptTokens / ctxInfo.tokens
                : 0;
            if (timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
              log.warn(
                `[timeout-compaction] already attempted timeout compaction ${timeoutCompactionAttempts} time(s); falling through to failover rotation`,
              );
            } else if (tokenUsedRatio > 0.65) {
              const timeoutDiagId = createCompactionDiagId();
              timeoutCompactionAttempts++;
              log.warn(
                `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
                  `attempting compaction before retry (attempt ${timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
              );
              let timeoutCompactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("timeout recovery");
              try {
                const timeoutCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    agentAccountId: params.agentAccountId,
                    agentDir,
                    authProfileId: lastProfileId,
                    bashElevated: params.bashElevated,
                    config: params.config,
                    currentChannelId: params.currentChannelId,
                    currentMessageId: params.currentMessageId,
                    currentThreadTs: params.currentThreadTs,
                    extraSystemPrompt: params.extraSystemPrompt,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    modelId,
                    ownerNumbers: params.ownerNumbers,
                    provider,
                    reasoningLevel: params.reasoningLevel,
                    senderId: params.senderId,
                    senderIsOwner: params.senderIsOwner,
                    sessionKey: params.sessionKey,
                    skillsSnapshot: params.skillsSnapshot,
                    thinkLevel,
                    workspaceDir: resolvedWorkspace,
                  }),
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  attempt: timeoutCompactionAttempts,
                  diagId: timeoutDiagId,
                  maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
                  runId: params.runId,
                  trigger: "timeout_recovery",
                };
                timeoutCompactResult = await contextEngine.compact({
                  compactionTarget: "budget",
                  force: true,
                  runtimeContext: timeoutCompactionRuntimeContext,
                  sessionFile: params.sessionFile,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  tokenBudget: ctxInfo.tokens,
                });
              } catch (error) {
                log.warn(
                  `[timeout-compaction] contextEngine.compact() threw during timeout recovery for ${provider}/${modelId}: ${String(error)}`,
                );
                timeoutCompactResult = {
                  compacted: false,
                  ok: false,
                  reason: String(error),
                };
              }
              await runOwnsCompactionAfterHook("timeout recovery", timeoutCompactResult);
              if (timeoutCompactResult.compacted) {
                autoCompactionCount += 1;
                if (contextEngine.info.ownsCompaction === true) {
                  await runPostCompactionSideEffects({
                    config: params.config,
                    sessionFile: params.sessionFile,
                    sessionKey: params.sessionKey,
                  });
                }
                log.info(
                  `[timeout-compaction] compaction succeeded for ${provider}/${modelId}; retrying prompt`,
                );
                continue;
              } else {
                log.warn(
                  `[timeout-compaction] compaction did not reduce context for ${provider}/${modelId}; falling through to normal handling`,
                );
              }
            }
          }

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = formatErrorMessage(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { source: "promptError" as const, text: errorText };
                  }
                  // Prompt submission failed with a non-overflow error. Do not
                  // Inspect prior assistant errors from history for this attempt.
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return {
                    source: "assistantError" as const,
                    text: assistantErrorText,
                  };
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${params.sessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
                `error=${errorText.slice(0, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;
            // If this attempt already compacted (SDK auto-compaction), avoid immediately
            // Running another explicit compaction for the same overflow trigger.
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              continue;
            }
            // Attempt explicit overflow compaction only when this attempt did not
            // Already auto-compact.
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("overflow recovery");
              try {
                const overflowCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    agentAccountId: params.agentAccountId,
                    agentDir,
                    authProfileId: lastProfileId,
                    bashElevated: params.bashElevated,
                    config: params.config,
                    currentChannelId: params.currentChannelId,
                    currentMessageId: params.currentMessageId,
                    currentThreadTs: params.currentThreadTs,
                    extraSystemPrompt: params.extraSystemPrompt,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    modelId,
                    ownerNumbers: params.ownerNumbers,
                    provider,
                    reasoningLevel: params.reasoningLevel,
                    senderId: params.senderId,
                    senderIsOwner: params.senderIsOwner,
                    sessionKey: params.sessionKey,
                    skillsSnapshot: params.skillsSnapshot,
                    thinkLevel,
                    workspaceDir: resolvedWorkspace,
                  }),
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "overflow",
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  diagId: overflowDiagId,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                };
                compactResult = await contextEngine.compact({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  sessionFile: params.sessionFile,
                  tokenBudget: ctxInfo.tokens,
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  force: true,
                  compactionTarget: "budget",
                  runtimeContext: overflowCompactionRuntimeContext,
                });
                if (compactResult.ok && compactResult.compacted) {
                  await runContextEngineMaintenance({
                    contextEngine,
                    reason: "compaction",
                    runtimeContext: overflowCompactionRuntimeContext,
                    sessionFile: params.sessionFile,
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                  });
                }
              } catch (error) {
                log.warn(
                  `contextEngine.compact() threw during overflow recovery for ${provider}/${modelId}: ${String(error)}`,
                );
                compactResult = {
                  compacted: false,
                  ok: false,
                  reason: String(error),
                };
              }
              await runOwnsCompactionAfterHook("overflow recovery", compactResult);
              if (compactResult.compacted) {
                if (preflightRecovery?.route === "compact_then_truncate") {
                  const truncResult = await truncateOversizedToolResultsInSession({
                    contextWindowTokens: ctxInfo.tokens,
                    sessionFile: params.sessionFile,
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                  });
                  if (truncResult.truncated) {
                    log.info(
                      `[context-overflow-precheck] post-compaction tool-result truncation succeeded for ` +
                        `${provider}/${modelId}; truncated ${truncResult.truncatedCount} tool result(s)`,
                    );
                  } else {
                    log.warn(
                      `[context-overflow-precheck] post-compaction tool-result truncation did not help for ` +
                        `${provider}/${modelId}: ${truncResult.reason ?? "unknown"}`,
                    );
                  }
                }
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    contextWindowTokens,
                    messages: attempt.messagesSnapshot,
                  })
                : false;

              if (hasOversized) {
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  contextWindowTokens,
                  sessionFile: params.sessionFile,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              }
            }
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            return {
              meta: {
                agentMeta: buildErrorAgentMeta({
                  lastAssistant,
                  lastRunPromptUsage,
                  lastTurnTotal,
                  model: model.id,
                  provider,
                  sessionId: sessionIdUsed,
                  usageAccumulator,
                }),
                durationMs: Date.now() - started,
                error: { kind, message: errorText },
                systemPromptReport: attempt.systemPromptReport,
              },
              payloads: [
                {
                  isError: true,
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                },
              ],
            };
          }

          if (promptError && !aborted && promptErrorSource !== "compaction") {
            // Normalize wrapped errors (e.g. abort-wrapped RESOURCE_EXHAUSTED) into
            // FailoverError so rate-limit classification works even for nested shapes.
            //
            // PromptErrorSource === "compaction" means the model call already completed and the
            // Abort happened only while waiting for compaction/retry cleanup. Retrying from here
            // Would replay that completed tool turn as a fresh prompt attempt.
            const normalizedPromptFailover = coerceToFailoverError(promptError, {
              model: activeErrorContext.model,
              profileId: lastProfileId,
              provider: activeErrorContext.provider,
            });
            const promptErrorDetails = normalizedPromptFailover
              ? describeFailoverError(normalizedPromptFailover)
              : describeFailoverError(promptError);
            const errorText = promptErrorDetails.message || formatErrorMessage(promptError);
            if (await maybeRefreshRuntimeAuthForAuthError(errorText, runtimeAuthRetry)) {
              authRetryPending = true;
              continue;
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                meta: {
                  agentMeta: buildErrorAgentMeta({
                    lastAssistant,
                    lastRunPromptUsage,
                    lastTurnTotal,
                    model: model.id,
                    provider,
                    sessionId: sessionIdUsed,
                    usageAccumulator,
                  }),
                  durationMs: Date.now() - started,
                  error: { kind: "role_ordering", message: errorText },
                  systemPromptReport: attempt.systemPromptReport,
                },
                payloads: [
                  {
                    isError: true,
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                  },
                ],
              };
            }
            // Handle image size errors with a user-friendly message (no retry needed)
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const { maxMb } = imageSizeError;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                meta: {
                  agentMeta: buildErrorAgentMeta({
                    lastAssistant,
                    lastRunPromptUsage,
                    lastTurnTotal,
                    model: model.id,
                    provider,
                    sessionId: sessionIdUsed,
                    usageAccumulator,
                  }),
                  durationMs: Date.now() - started,
                  error: { kind: "image_size", message: errorText },
                  systemPromptReport: attempt.systemPromptReport,
                },
                payloads: [
                  {
                    isError: true,
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                  },
                ],
              };
            }
            const promptFailoverReason =
              promptErrorDetails.reason ?? classifyFailoverReason(errorText, { provider });
            const promptProfileFailureReason =
              resolveAuthProfileFailureReason(promptFailoverReason);
            await maybeMarkAuthProfileFailure({
              modelId,
              profileId: lastProfileId,
              reason: promptProfileFailureReason,
            });
            const promptFailoverFailure =
              promptFailoverReason !== null || isFailoverErrorMessage(errorText, { provider });
            // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
            const failedPromptProfileId = lastProfileId;
            const logPromptFailoverDecision = createFailoverDecisionLogger({
              aborted,
              failoverReason: promptFailoverReason,
              fallbackConfigured,
              model: modelId,
              profileFailureReason: promptProfileFailureReason,
              profileId: failedPromptProfileId,
              provider,
              rawError: errorText,
              runId: params.runId,
              stage: "prompt",
            });
            if (promptFailoverReason === "rate_limit") {
              maybeEscalateRateLimitProfileFallback({
                failoverModel: modelId,
                failoverProvider: provider,
                logFallbackDecision: logPromptFailoverDecision,
              });
            }
            let promptFailoverDecision = resolveRunFailoverDecision({
              aborted,
              failoverFailure: promptFailoverFailure,
              failoverReason: promptFailoverReason,
              fallbackConfigured,
              profileRotated: false,
              stage: "prompt",
            });
            if (
              promptFailoverDecision.action === "rotate_profile" &&
              (await advanceAuthProfile())
            ) {
              lastRetryFailoverReason = mergeRetryFailoverReason({
                failoverReason: promptFailoverReason,
                previous: lastRetryFailoverReason,
              });
              logPromptFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }
            if (promptFailoverDecision.action === "rotate_profile") {
              promptFailoverDecision = resolveRunFailoverDecision({
                aborted,
                failoverFailure: promptFailoverFailure,
                failoverReason: promptFailoverReason,
                fallbackConfigured,
                profileRotated: true,
                stage: "prompt",
              });
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              attempted: attemptedThinking,
              message: errorText,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // Throw FailoverError for prompt-side failover reasons when fallbacks
            // Are configured so outer model fallback can continue on overload,
            // Rate-limit, auth, or billing failures.
            if (promptFailoverDecision.action === "fallback_model") {
              const fallbackReason = promptFailoverDecision.reason ?? "unknown";
              const status = resolveFailoverStatus(fallbackReason);
              logPromptFailoverDecision("fallback_model", { status });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw (
                normalizedPromptFailover ??
                new FailoverError(errorText, {
                  model: modelId,
                  profileId: lastProfileId,
                  provider,
                  reason: fallbackReason,
                  status,
                })
              );
            }
            if (promptFailoverDecision.action === "surface_error") {
              logPromptFailoverDecision("surface_error");
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            attempted: attemptedThinking,
            message: lastAssistant?.errorMessage,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const billingFailure = isBillingAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(
            lastAssistant?.errorMessage ?? "",
            {
              provider: lastAssistant?.provider,
            },
          );
          const assistantProfileFailureReason =
            resolveAuthProfileFailureReason(assistantFailoverReason);
          const { cloudCodeAssistFormatError } = attempt;
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");
          // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
          const failedAssistantProfileId = lastProfileId;
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            aborted,
            failoverReason: assistantFailoverReason,
            fallbackConfigured,
            model: activeErrorContext.model,
            profileFailureReason: assistantProfileFailureReason,
            profileId: failedAssistantProfileId,
            provider: activeErrorContext.provider,
            rawError: lastAssistant?.errorMessage?.trim(),
            runId: params.runId,
            stage: "assistant",
            timedOut,
          });

          if (
            authFailure &&
            (await maybeRefreshRuntimeAuthForAuthError(
              lastAssistant?.errorMessage ?? "",
              runtimeAuthRetry,
            ))
          ) {
            authRetryPending = true;
            continue;
          }
          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          const assistantFailoverDecision = resolveRunFailoverDecision({
            aborted,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            fallbackConfigured,
            profileRotated: false,
            stage: "assistant",
            timedOut,
            timedOutDuringCompaction,
          });
          const assistantFailoverOutcome = await handleAssistantFailover({
            aborted,
            activeErrorContext,
            advanceAuthProfile,
            allowSameModelIdleTimeoutRetry:
              timedOut &&
              idleTimedOut &&
              !timedOutDuringCompaction &&
              !fallbackConfigured &&
              canRestartForLiveSwitch &&
              sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES,
            assistantProfileFailureReason,
            authFailure,
            billingFailure,
            cloudCodeAssistFormatError,
            config: params.config,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            fallbackConfigured,
            idleTimedOut,
            initialDecision: assistantFailoverDecision,
            isProbeSession,
            lastAssistant,
            lastProfileId,
            logAssistantFailoverDecision,
            maybeBackoffBeforeOverloadFailover,
            maybeEscalateRateLimitProfileFallback,
            maybeMarkAuthProfileFailure,
            modelId,
            overloadProfileRotationLimit,
            overloadProfileRotations,
            previousRetryFailoverReason: lastRetryFailoverReason,
            provider,
            rateLimitFailure,
            sessionKey: params.sessionKey ?? params.sessionId,
            timedOut,
            timedOutDuringCompaction,
            warn: (message) => log.warn(message),
          });
          ({ overloadProfileRotations } = assistantFailoverOutcome);
          if (assistantFailoverOutcome.action === "retry") {
            if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") {
              sameModelIdleTimeoutRetries += 1;
            }
            ({ lastRetryFailoverReason } = assistantFailoverOutcome);
            continue;
          }
          if (assistantFailoverOutcome.action === "throw") {
            throw assistantFailoverOutcome.error;
          }
          const usageMeta = buildUsageAgentMetaFields({
            lastAssistantUsage: lastAssistant?.usage as UsageLike | undefined,
            lastRunPromptUsage,
            lastTurnTotal,
            usageAccumulator,
          });
          const agentMeta: EmbeddedPiAgentMeta = {
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
            lastCallUsage: usageMeta.lastCallUsage,
            model: lastAssistant?.model ?? model.id,
            promptTokens: usageMeta.promptTokens,
            provider: lastAssistant?.provider ?? provider,
            sessionId: sessionIdUsed,
            usage: usageMeta.usage,
          };
          const finalAssistantVisibleText = resolveFinalAssistantVisibleText(lastAssistant);

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            config: params.config,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            inlineToolResultsAllowed: false,
            isCronTrigger: params.trigger === "cron",
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            model: activeErrorContext.model,
            provider: activeErrorContext.provider,
            reasoningLevel: params.reasoningLevel,
            sessionKey: params.sessionKey ?? params.sessionId,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            toolMetas: attempt.toolMetas,
            toolResultFormat: resolvedToolResultFormat,
            verboseLevel: params.verboseLevel,
          });

          // Timeout aborts can leave the run without any assistant payloads.
          // Emit an explicit timeout error instead of silently completing, so
          // Callers do not lose the turn as an orphaned user message.
          if (timedOut && !timedOutDuringCompaction && payloads.length === 0) {
            const timeoutText = idleTimedOut
              ? "The model did not produce a response before the LLM idle timeout. " +
                "Please try again, or increase `agents.defaults.llm.idleTimeoutSeconds` in your config (set to 0 to disable)."
              : "Request timed out before a response was generated. " +
                "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
            return {
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              meta: {
                aborted,
                agentMeta,
                durationMs: Date.now() - started,
                finalAssistantVisibleText,
                systemPromptReport: attempt.systemPromptReport,
              },
              payloads: [
                {
                  isError: true,
                  text: timeoutText,
                },
              ],
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          // Detect incomplete turns where prompt() resolved prematurely and the
          // Runner would otherwise drop an empty reply.
          const incompleteTurnText = resolveIncompleteTurnPayloadText({
            aborted,
            attempt,
            payloadCount: payloads.length,
            timedOut,
          });
          const nextPlanningOnlyRetryInstruction = resolvePlanningOnlyRetryInstruction({
            aborted,
            attempt,
            modelId,
            provider,
            timedOut,
          });
          if (
            !incompleteTurnText &&
            nextPlanningOnlyRetryInstruction &&
            planningOnlyRetryAttempts < 1
          ) {
            const planningOnlyText = attempt.assistantTexts.join("\n\n").trim();
            const planDetails = extractPlanningOnlyPlanDetails(planningOnlyText);
            if (planDetails) {
              emitAgentPlanEvent({
                runId: params.runId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                data: {
                  explanation: planDetails.explanation,
                  phase: "update",
                  source: "planning_only_retry",
                  steps: planDetails.steps,
                  title: "Assistant proposed a plan",
                },
              });
              void params.onAgentEvent?.({
                data: {
                  explanation: planDetails.explanation,
                  phase: "update",
                  source: "planning_only_retry",
                  steps: planDetails.steps,
                  title: "Assistant proposed a plan",
                },
                stream: "plan",
              });
            }
            planningOnlyRetryAttempts += 1;
            planningOnlyRetryInstruction = nextPlanningOnlyRetryInstruction;
            log.warn(
              `planning-only turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${provider}/${modelId} — retrying once with act-now steer`,
            );
            continue;
          }
          if (incompleteTurnText) {
            const incompleteStopReason = attempt.lastAssistant?.stopReason;
            log.warn(
              `incomplete turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `stopReason=${incompleteStopReason} payloads=0 — surfacing error to user`,
            );

            // Mark the failing profile for cooldown so multi-profile setups
            // Rotate away from the exhausted credential on the next turn.
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: resolveAuthProfileFailureReason(assistantFailoverReason),
              });
            }

            return {
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              meta: {
                aborted,
                agentMeta,
                durationMs: Date.now() - started,
                finalAssistantVisibleText,
                systemPromptReport: attempt.systemPromptReport,
              },
              payloads: [
                {
                  isError: true,
                  text: incompleteTurnText,
                },
              ],
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileGood({
              agentDir: params.agentDir,
              profileId: lastProfileId,
              provider,
              store: authStore,
            });
            await markAuthProfileUsed({
              agentDir: params.agentDir,
              profileId: lastProfileId,
              store: authStore,
            });
          }
          return {
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              finalAssistantVisibleText,
              // Handle client tool calls (OpenResponses hosted tools)
              // Propagate the LLM stop reason so callers (lifecycle events,
              // ACP bridge) can distinguish end_turn from max_tokens.
              stopReason: attempt.clientToolCall
                ? "tool_calls"
                : attempt.yieldDetected
                  ? "end_turn"
                  : (lastAssistant?.stopReason as string | undefined),
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                    },
                  ]
                : undefined,
            },
            payloads: payloads.length ? payloads : undefined,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        await contextEngine.dispose?.();
        stopRuntimeAuthRefreshTimer();
        if (params.cleanupBundleMcpOnRunEnd === true) {
          await disposeSessionMcpRuntime(params.sessionId).catch((error) => {
            log.warn(
              `bundle-mcp cleanup failed after run for ${params.sessionId}: ${formatErrorMessage(error)}`,
            );
          });
        }
      }
    });
  });
}
