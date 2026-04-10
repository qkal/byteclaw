import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { filterHeartbeatPairs } from "../../../auto-reply/heartbeat-filter.js";
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import {
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
} from "../../../infra/net/undici-global-dispatcher.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js";
import {
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "../../../plugin-sdk/ollama-runtime.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import { resolveProviderSystemPromptContribution } from "../../../plugins/provider-runtime.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { buildTtsSystemPromptHint } from "../../../tts/tts.js";
import { resolveUserPath } from "../../../utils.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  prependBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolCapabilities,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../channel-tools.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { buildModelAliasLines } from "../../model-alias-lines.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { releaseWsSession } from "../../openai-ws-stream.js";
import { resolveOwnerDisplaySetting } from "../../owner-display.js";
import { createBundleLspToolRuntime } from "../../pi-bundle-lsp-runtime.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../pi-bundle-mcp-tools.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import { createPreparedEmbeddedPiSettingsManager } from "../../pi-project-settings.js";
import { applyPiAutoCompactionGuard } from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools, resolveToolLoopDetectionConfig } from "../../pi-tools.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { resolveSystemPromptOverride } from "../../system-prompt-override.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../../tool-call-id.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { type NormalizedUsage, type UsageLike, normalizeUsage } from "../../usage.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { applyExtraParamsToAgent, resolveAgentTransportOverride } from "../extra-params.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "../message-action-discovery-input.js";
import {
  type PromptCacheChange,
  beginPromptCacheObservation,
  collectPromptCacheToolNames,
  completePromptCacheObservation,
} from "../prompt-cache-observability.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import { sanitizeSessionHistory, validateReplayTurns } from "../replay-history.js";
import {
  type EmbeddedPiQueueHandle,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveEmbeddedRunSkillEntries } from "../skills-runtime.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { dropThinkingBlocks } from "../thinking.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import { installToolResultContextGuard } from "../tool-result-context-guard.js";
import { truncateOversizedToolResultsInSessionManager } from "../tool-result-truncation.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "../tool-schema-runtime.js";
import { splitSdkTools } from "../tool-split.js";
import { mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import {
  assembleAttemptContextEngine,
  buildContextEnginePromptCacheInfo,
  finalizeAttemptContextEngineTurn,
  findCurrentAttemptAssistantMessage,
  resolveAttemptBootstrapContext,
  runAttemptContextEngineBootstrap,
} from "./attempt.context-engine-helpers.js";
import {
  buildAfterTurnRuntimeContext,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptPrependSystemContext,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldInjectHeartbeatPrompt,
  shouldWarnOnOrphanedUserRepair,
} from "./attempt.prompt-helpers.js";
import {
  createYieldAbortedResponse,
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";
import {
  buildEmbeddedSubscriptionParams,
  cleanupEmbeddedAttemptResources,
} from "./attempt.subscription-cleanup.js";
import {
  appendAttemptCacheTtlIfNeeded,
  composeSystemPromptWithHookContext,
  resolveAttemptSpawnWorkspaceDir,
  shouldUseOpenAIWebSocketTransport,
} from "./attempt.thread-helpers.js";
import {
  shouldRepairMalformedAnthropicToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import { buildAttemptReplayMetadata } from "./incomplete-turn.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export {
  appendAttemptCacheTtlIfNeeded,
  composeSystemPromptWithHookContext,
  resolveAttemptSpawnWorkspaceDir,
} from "./attempt.thread-helpers.js";
export {
  buildAfterTurnRuntimeContext,
  prependSystemPromptAddition,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptPrependSystemContext,
  resolvePromptBuildHookResult,
  resolvePromptModeForSession,
  shouldWarnOnOrphanedUserRepair,
  shouldInjectHeartbeatPrompt,
} from "./attempt.prompt-helpers.js";
export {
  buildSessionsYieldContextMessage,
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  stripSessionsYieldArtifacts,
} from "./attempt.sessions-yield.js";
export {
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "../../../plugin-sdk/ollama-runtime.js";

export {
  decodeHtmlEntitiesInObject,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
export {
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
export {
  resetEmbeddedAgentBaseStreamFnCacheForTest,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
};

const MAX_BTW_SNAPSHOT_MESSAGES = 100;

function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const { content } = msg as { content?: unknown };
  if (typeof content === "string") {
    return { imageBlocks: 0, textChars: content.length };
  }
  if (!Array.isArray(content)) {
    return { imageBlocks: 0, textChars: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { imageBlocks, textChars };
}

function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    maxMessageTextChars,
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalImageBlocks,
    totalTextChars,
  };
}

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const runAbortController = new AbortController();
  // Proxy bootstrap must happen before timeout tuning so the timeouts wrap the
  // Active EnvHttpProxyAgent instead of being replaced by a bare proxy dispatcher.
  ensureGlobalUndiciEnvProxyDispatcher();
  ensureGlobalUndiciStreamTimeouts();

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  const { sessionAgentId } = resolveSessionAgentIds({
    agentId: params.agentId,
    config: params.config,
    sessionKey: params.sessionKey,
  });

  let restoreSkillEnv: (() => void) | undefined;
  try {
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      agentId: sessionAgentId,
      config: params.config,
      skillsSnapshot: params.skillsSnapshot,
      workspaceDir: effectiveWorkspace,
    });
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          config: params.config,
          snapshot: params.skillsSnapshot,
        })
      : applySkillEnvOverrides({
          config: params.config,
          skills: skillEntries ?? [],
        });

    const skillsPrompt = resolveSkillsPromptForRun({
      agentId: sessionAgentId,
      config: params.config,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsSnapshot: params.skillsSnapshot,
      workspaceDir: effectiveWorkspace,
    });

    const sessionLock = await acquireSessionWriteLock({
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: resolveRunTimeoutWithCompactionGraceMs({
          compactionTimeoutMs: resolveCompactionTimeoutMs(params.config),
          runTimeoutMs: params.timeoutMs,
        }),
      }),
      sessionFile: params.sessionFile,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const contextInjectionMode = resolveContextInjectionMode(params.config);
    const {
      bootstrapFiles: hookAdjustedBootstrapFiles,
      contextFiles,
      shouldRecordCompletedBootstrapTurn,
    } = await resolveAttemptBootstrapContext({
      bootstrapContextMode: params.bootstrapContextMode,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      contextInjectionMode,
      hasCompletedBootstrapTurn,
      resolveBootstrapContextForRun: async () =>
        await resolveBootstrapContextForRun({
          config: params.config,
          contextMode: params.bootstrapContextMode,
          runKind: params.bootstrapContextRunKind,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
          workspaceDir: effectiveWorkspace,
        }),
      sessionFile: params.sessionFile,
    });
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
    const bootstrapAnalysis = analyzeBootstrapBudget({
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      files: buildBootstrapInjectionStats({
        bootstrapFiles: hookAdjustedBootstrapFiles,
        injectedFiles: contextFiles,
      }),
    });
    const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
    const bootstrapPromptWarning = buildBootstrapPromptWarning({
      analysis: bootstrapAnalysis,
      mode: bootstrapPromptWarningMode,
      previousSignature: params.bootstrapPromptWarningSignature,
      seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    });
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

    const { defaultAgentId } = resolveSessionAgentIds({
      agentId: params.agentId,
      config: params.config,
      sessionKey: params.sessionKey,
    });
    const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
      config: params.config,
      sessionAgentId,
    });
    // Track sessions_yield tool invocation (callback pattern, like clientToolCallDetected)
    let yieldDetected = false;
    let yieldMessage: string | null = null;
    // Late-binding reference so onYield can abort the session (declared after tool creation)
    let abortSessionForYield: (() => void) | null = null;
    let queueYieldInterruptForSession: (() => void) | null = null;
    let yieldAbortSettled: Promise<void> | null = null;
    // Check if the model supports native image input
    const modelHasVision = params.model.input?.includes("image") ?? false;
    const toolsRaw = params.disableTools
      ? []
      : (() => {
          const allTools = createOpenClawCodingTools({
            agentId: sessionAgentId,
            ...buildEmbeddedAttemptToolRunContext(params),
            exec: {
              ...params.execOverrides,
              elevated: params.bashElevated,
            },
            sandbox,
            messageProvider: params.messageChannel ?? params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            senderIsOwner: params.senderIsOwner,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            sessionKey: sandboxSessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            agentDir,
            workspaceDir: effectiveWorkspace,
            // When sandboxing uses a copied workspace (`ro` or `none`), effectiveWorkspace points
            // At the sandbox copy. Spawned subagents should inherit the real workspace instead.
            spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
              resolvedWorkspace,
              sandbox,
            }),
            config: params.config,
            abortSignal: runAbortController.signal,
            modelProvider: params.model.provider,
            modelId: params.modelId,
            modelCompat: params.model.compat,
            modelApi: params.model.api,
            modelContextWindowTokens: params.model.contextWindow,
            modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            modelHasVision,
            requireExplicitMessageTarget:
              params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
            disableMessageTool: params.disableMessageTool,
            onYield: (message) => {
              yieldDetected = true;
              yieldMessage = message;
              queueYieldInterruptForSession?.();
              runAbortController.abort("sessions_yield");
              abortSessionForYield?.();
            },
          });
          if (params.toolsAllow && params.toolsAllow.length > 0) {
            const allowSet = new Set(params.toolsAllow);
            return allTools.filter((tool) => allowSet.has(tool.name));
          }
          return allTools;
        })();
    const toolsEnabled = supportsModelTools(params.model);
    const tools = normalizeProviderToolSchemas({
      config: params.config,
      env: process.env,
      model: params.model,
      modelApi: params.model.api,
      modelId: params.modelId,
      provider: params.provider,
      tools: toolsEnabled ? toolsRaw : [],
      workspaceDir: effectiveWorkspace,
    });
    const clientTools = toolsEnabled ? params.clientTools : undefined;
    const bundleMcpSessionRuntime = toolsEnabled
      ? await getOrCreateSessionMcpRuntime({
          cfg: params.config,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: effectiveWorkspace,
        })
      : undefined;
    const bundleMcpRuntime = bundleMcpSessionRuntime
      ? await materializeBundleMcpToolsForRun({
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
          ],
          runtime: bundleMcpSessionRuntime,
        })
      : undefined;
    const bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
          workspaceDir: effectiveWorkspace,
        })
      : undefined;
    const effectiveTools = [
      ...tools,
      ...(bundleMcpRuntime?.tools ?? []),
      ...(bundleLspRuntime?.tools ?? []),
    ];
    const allowedToolNames = collectAllowedToolNames({
      clientTools,
      tools: effectiveTools,
    });
    logProviderToolSchemaDiagnostics({
      config: params.config,
      env: process.env,
      model: params.model,
      modelApi: params.model.api,
      modelId: params.modelId,
      provider: params.provider,
      tools: effectiveTools,
      workspaceDir: effectiveWorkspace,
    });

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          accountId: params.agentAccountId,
          cfg: params.config,
          channel: runtimeChannel,
        }) ?? [])
      : undefined;
    const promptCapabilities =
      runtimeChannel && params.config
        ? resolveChannelMessageToolCapabilities({
            accountId: params.agentAccountId,
            cfg: params.config,
            channel: runtimeChannel,
          })
        : [];
    if (promptCapabilities.length > 0) {
      runtimeCapabilities ??= [];
      const seenCapabilities = new Set(
        runtimeCapabilities
          .map((cap) => normalizeOptionalLowercaseString(String(cap)))
          .filter(Boolean),
      );
      for (const capability of promptCapabilities) {
        const normalizedCapability = normalizeOptionalLowercaseString(capability);
        if (!normalizedCapability || seenCapabilities.has(normalizedCapability)) {
          continue;
        }
        seenCapabilities.add(normalizedCapability);
        runtimeCapabilities.push(capability);
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? resolveChannelReactionGuidance({
            accountId: params.agentAccountId,
            cfg: params.config,
            channel: runtimeChannel,
          })
        : undefined;
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider, {
      config: params.config,
      env: process.env,
      model: params.model,
      modelApi: params.model.api,
      modelId: params.modelId,
      workspaceDir: effectiveWorkspace,
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            accountId: params.agentAccountId,
            agentId: sessionAgentId,
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentMessageId: params.currentMessageId,
            currentThreadTs: params.currentThreadTs,
            senderId: params.senderId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          }),
        )
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          accountId: params.agentAccountId,
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;

    const defaultModelRef = resolveDefaultModelForAgent({
      agentId: sessionAgentId,
      cfg: params.config ?? {},
    });
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      agentId: sessionAgentId,
      config: params.config,
      cwd: effectiveWorkspace,
      runtime: {
        arch: os.arch(),
        capabilities: runtimeCapabilities,
        channel: runtimeChannel,
        channelActions,
        defaultModel: defaultModelLabel,
        host: machineName,
        model: `${params.provider}/${params.modelId}`,
        node: process.version,
        os: `${os.type()} ${os.release()}`,
        shell: detectRuntimeShell(),
      },
      workspaceDir: effectiveWorkspace,
    });
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    const promptMode = resolvePromptModeForSession(params.sessionKey);

    // When toolsAllow is set, use minimal prompt and strip skills catalog
    const effectivePromptMode = params.toolsAllow?.length ? ("minimal" as const) : promptMode;
    const effectiveSkillsPrompt = params.toolsAllow?.length ? undefined : skillsPrompt;
    const docsPath = await resolveOpenClawDocsPath({
      argv1: process.argv[1],
      cwd: effectiveWorkspace,
      moduleUrl: import.meta.url,
      workspaceDir: effectiveWorkspace,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);
    const heartbeatPrompt = shouldInjectHeartbeatPrompt({
      agentId: sessionAgentId,
      config: params.config,
      defaultAgentId,
      isDefaultAgent,
      trigger: params.trigger,
    })
      ? resolveHeartbeatPromptForSystemPrompt({
          agentId: sessionAgentId,
          config: params.config,
          defaultAgentId,
        })
      : undefined;
    const promptContribution = resolveProviderSystemPromptContribution({
      config: params.config,
      context: {
        agentDir: params.agentDir,
        agentId: sessionAgentId,
        config: params.config,
        modelId: params.modelId,
        promptMode: effectivePromptMode,
        provider: params.provider,
        runtimeCapabilities,
        runtimeChannel,
        workspaceDir: effectiveWorkspace,
      },
      provider: params.provider,
      workspaceDir: effectiveWorkspace,
    });

    const appendPrompt =
      resolveSystemPromptOverride({
        agentId: sessionAgentId,
        config: params.config,
      }) ??
      buildEmbeddedSystemPrompt({
        acpEnabled: params.config?.acp?.enabled !== false,
        contextFiles,
        defaultThinkLevel: params.thinkLevel,
        docsPath: docsPath ?? undefined,
        extraSystemPrompt: params.extraSystemPrompt,
        heartbeatPrompt,
        includeMemorySection: !params.contextEngine || params.contextEngine.info.id === "legacy",
        memoryCitationsMode: params.config?.memory?.citations,
        messageToolHints,
        modelAliasLines: buildModelAliasLines(params.config),
        ownerDisplay: ownerDisplay.ownerDisplay,
        ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
        ownerNumbers: params.ownerNumbers,
        promptContribution,
        promptMode: effectivePromptMode,
        reactionGuidance,
        reasoningLevel: params.reasoningLevel ?? "off",
        reasoningTagHint,
        runtimeInfo,
        sandboxInfo,
        skillsPrompt: effectiveSkillsPrompt,
        tools: effectiveTools,
        ttsHint,
        userTime,
        userTimeFormat,
        userTimezone,
        workspaceDir: effectiveWorkspace,
        workspaceNotes,
      });
    const systemPromptReport = buildSystemPromptReport({
      bootstrapFiles: hookAdjustedBootstrapFiles,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warning: bootstrapPromptWarning,
        warningMode: bootstrapPromptWarningMode,
      }),
      generatedAt: Date.now(),
      injectedFiles: contextFiles,
      model: params.modelId,
      provider: params.provider,
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: sandboxSessionKey,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      skillsPrompt,
      source: "run",
      systemPrompt: appendPrompt,
      tools: effectiveTools,
      workspaceDir: effectiveWorkspace,
    });
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    let systemPromptText = systemPromptOverride();

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      const transcriptPolicy = resolveTranscriptPolicy({
        config: params.config,
        env: process.env,
        model: params.model,
        modelApi: params.model?.api,
        modelId: params.modelId,
        provider: params.provider,
        workspaceDir: effectiveWorkspace,
      });

      await prewarmSessionFile(params.sessionFile);
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        allowedToolNames,
        inputProvenance: params.inputProvenance,
        sessionKey: params.sessionKey,
      });
      trackSessionManagerAccess(params.sessionFile);

      await runAttemptContextEngineBootstrap({
        contextEngine: params.contextEngine,
        hadSessionFile,
        runMaintenance: async (contextParams) =>
          await runContextEngineMaintenance({
            contextEngine: contextParams.contextEngine as never,
            reason: contextParams.reason,
            runtimeContext: contextParams.runtimeContext,
            sessionFile: contextParams.sessionFile,
            sessionId: contextParams.sessionId,
            sessionKey: contextParams.sessionKey,
            sessionManager: contextParams.sessionManager as never,
          }),
        runtimeContext: buildAfterTurnRuntimeContext({
          agentDir,
          attempt: params,
          workspaceDir: effectiveWorkspace,
        }),
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionManager,
        warn: (message) => log.warn(message),
      });

      await prepareSessionManagerForRun({
        cwd: effectiveWorkspace,
        hadSessionFile,
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        sessionManager,
      });

      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        agentDir,
        cfg: params.config,
        cwd: effectiveWorkspace,
      });
      applyPiAutoCompactionGuard({
        contextEngineInfo: params.contextEngine?.info,
        settingsManager,
      });

      // Sets compaction/pruning runtime state and returns extension factories
      // That must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        model: params.model,
        modelId: params.modelId,
        provider: params.provider,
        sessionManager,
      });
      // Only create an explicit resource loader when there are extension factories
      // To register; otherwise let createAgentSession use its built-in default.
      let resourceLoader: DefaultResourceLoader | undefined;
      if (extensionFactories.length > 0) {
        resourceLoader = new DefaultResourceLoader({
          agentDir,
          cwd: resolvedWorkspace,
          extensionFactories,
          settingsManager,
        });
        await resourceLoader.reload();
      }

      // Get hook runner early so it's available when creating tools
      const hookRunner = getGlobalHookRunner();

      const { builtInTools, customTools } = splitSdkTools({
        sandboxEnabled: Boolean(sandbox?.enabled),
        tools: effectiveTools,
      });

      // Add client tools (OpenResponses hosted tools) to customTools
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      const clientToolLoopDetection = resolveToolLoopDetectionConfig({
        agentId: sessionAgentId,
        cfg: params.config,
      });
      const clientToolDefs = clientTools
        ? toClientToolDefinitions(
            clientTools,
            (toolName, toolParams) => {
              clientToolCallDetected = { name: toolName, params: toolParams };
            },
            {
              agentId: sessionAgentId,
              loopDetection: clientToolLoopDetection,
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: sandboxSessionKey,
            },
          )
        : [];

      const allCustomTools = [...customTools, ...clientToolDefs];

      ({ session } = await createAgentSession({
        agentDir,
        authStorage: params.authStorage,
        customTools: allCustomTools,
        cwd: resolvedWorkspace,
        model: params.model,
        modelRegistry: params.modelRegistry,
        resourceLoader,
        sessionManager,
        settingsManager,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
      }));
      applySystemPromptOverrideToSession(session, systemPromptText);
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;
      abortSessionForYield = () => {
        yieldAbortSettled = Promise.resolve(activeSession.abort());
      };
      queueYieldInterruptForSession = () => {
        queueSessionsYieldInterruptMessage(activeSession);
      };
      removeToolResultContextGuard = installToolResultContextGuard({
        agent: activeSession.agent,
        contextWindowTokens: Math.max(
          1,
          Math.floor(
            params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
          ),
        ),
      });
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        modelApi: params.model.api,
        modelId: params.modelId,
        provider: params.provider,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        modelApi: params.model.api,
        modelId: params.modelId,
        provider: params.provider,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      });

      // Rebuild each turn from the session's original stream base so prior-turn
      // Wrappers do not pin us to stale provider/API transport behavior.
      const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
        session: activeSession,
      });
      const providerStreamFn = registerProviderStreamForModel({
        agentDir,
        cfg: params.config,
        model: params.model,
        workspaceDir: effectiveWorkspace,
      });
      const shouldUseWebSocketTransport = shouldUseOpenAIWebSocketTransport({
        modelApi: params.model.api,
        provider: params.provider,
      });
      const wsApiKey = shouldUseWebSocketTransport
        ? await resolveEmbeddedAgentApiKey({
            authStorage: params.authStorage,
            provider: params.provider,
            resolvedApiKey: params.resolvedApiKey,
          })
        : undefined;
      if (shouldUseWebSocketTransport && !wsApiKey) {
        log.warn(
          `[ws-stream] no API key for provider=${params.provider}; keeping session-managed HTTP transport`,
        );
      }
      const streamStrategy = describeEmbeddedAgentStreamStrategy({
        currentStreamFn: defaultSessionStreamFn,
        model: params.model,
        providerStreamFn,
        shouldUseWebSocketTransport,
        wsApiKey,
      });
      activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
        authStorage: params.authStorage,
        currentStreamFn: defaultSessionStreamFn,
        model: params.model,
        providerStreamFn,
        resolvedApiKey: params.resolvedApiKey,
        sessionId: params.sessionId,
        shouldUseWebSocketTransport,
        signal: runAbortController.signal,
        wsApiKey,
      });

      const { effectiveExtraParams } = applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        {
          ...params.streamParams,
          fastMode: params.fastMode,
        },
        params.thinkLevel,
        sessionAgentId,
        effectiveWorkspace,
        params.model,
        agentDir,
      );
      const effectivePromptCacheRetention = resolveCacheRetention(
        effectiveExtraParams,
        params.provider,
        params.model.api,
        params.modelId,
      );
      const agentTransportOverride = resolveAgentTransportOverride({
        effectiveExtraParams,
        settingsManager,
      });
      const effectiveAgentTransport = agentTransportOverride ?? activeSession.agent.transport;
      if (agentTransportOverride && activeSession.agent.transport !== agentTransportOverride) {
        const previousTransport = activeSession.agent.transport;
        log.debug(
          `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
            `(${params.provider}/${params.modelId})`,
        );
      }

      const cacheObservabilityEnabled = Boolean(cacheTrace) || log.isEnabled("debug");
      const promptCacheToolNames = collectPromptCacheToolNames([
        ...builtInTools,
        ...allCustomTools,
      ] as { name?: string }[]);
      let promptCacheChangesForTurn: PromptCacheChange[] | null = null;

      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          note: "after session create",
          system: systemPromptText,
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }

      // Anthropic Claude endpoints can reject replayed `thinking` blocks
      // (e.g. thinkingSignature:"reasoning_text") on any follow-up provider
      // Call, including tool continuations. Wrap the stream function so every
      // Outbound request sees sanitized messages.
      if (transcriptPolicy.dropThinkingBlocks) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = dropThinkingBlocks(messages as unknown as AgentMessage[]) as unknown;
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      // Mistral (and other strict providers) reject tool call IDs that don't match their
      // Format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
      // Historical messages at attempt start, but the agent loop's internal tool call →
      // Tool result cycles bypass that path. Wrap streamFn so every outbound request
      // Sees sanitized tool call IDs.
      if (transcriptPolicy.sanitizeToolCallIds && transcriptPolicy.toolCallIdMode) {
        const inner = activeSession.agent.streamFn;
        const mode = transcriptPolicy.toolCallIdMode;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = sanitizeToolCallIdsForCloudCodeAssist(
            messages as AgentMessage[],
            mode,
            {
              preserveNativeAnthropicToolUseIds: transcriptPolicy.preserveNativeAnthropicToolUseIds,
            },
          );
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      if (
        params.model.api === "openai-responses" ||
        params.model.api === "azure-openai-responses" ||
        params.model.api === "openai-codex-responses"
      ) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = downgradeOpenAIFunctionCallReasoningPairs(messages as AgentMessage[]);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      const innerStreamFn = activeSession.agent.streamFn;
      activeSession.agent.streamFn = (model, context, options) => {
        const signal = runAbortController.signal as AbortSignal & { reason?: unknown };
        if (yieldDetected && signal.aborted && signal.reason === "sessions_yield") {
          return createYieldAbortedResponse(model) as unknown as Awaited<
            ReturnType<typeof innerStreamFn>
          >;
        }
        return innerStreamFn(model, context, options);
      };

      // Some models emit tool names with surrounding whitespace (e.g. " read ").
      // Pi-agent-core dispatches tool calls with exact string matching, so normalize
      // Names on the live response stream before tool execution.
      activeSession.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
        activeSession.agent.streamFn,
        allowedToolNames,
        transcriptPolicy,
      );
      activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
        activeSession.agent.streamFn,
        allowedToolNames,
      );

      if (
        params.model.api === "anthropic-messages" &&
        shouldRepairMalformedAnthropicToolCallArguments(params.provider)
      ) {
        activeSession.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (resolveToolCallArgumentsEncoding(params.model) === "html-entities") {
        activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }
      // Anthropic-compatible providers can add new stop reasons before pi-ai maps them.
      // Recover the known "sensitive" stop reason here so a model refusal does not
      // Bubble out as an uncaught runner error and stall channel polling.
      activeSession.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(
        activeSession.agent.streamFn,
      );

      let idleTimeoutTrigger: ((error: Error) => void) | undefined;

      // Wrap stream with idle timeout detection
      const idleTimeoutMs = resolveLlmIdleTimeoutMs({
        cfg: params.config,
        trigger: params.trigger,
      });
      if (idleTimeoutMs > 0) {
        activeSession.agent.streamFn = streamWithIdleTimeout(
          activeSession.agent.streamFn,
          idleTimeoutMs,
          (error) => idleTimeoutTrigger?.(error),
        );
      }

      try {
        const prior = await sanitizeSessionHistory({
          allowedToolNames,
          config: params.config,
          env: process.env,
          messages: activeSession.messages,
          model: params.model,
          modelApi: params.model.api,
          modelId: params.modelId,
          policy: transcriptPolicy,
          provider: params.provider,
          sessionId: params.sessionId,
          sessionManager,
          workspaceDir: effectiveWorkspace,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validated = await validateReplayTurns({
          config: params.config,
          env: process.env,
          messages: prior,
          model: params.model,
          modelApi: params.model.api,
          modelId: params.modelId,
          policy: transcriptPolicy,
          provider: params.provider,
          sessionId: params.sessionId,
          workspaceDir: effectiveWorkspace,
        });
        const heartbeatSummary =
          params.config && sessionAgentId
            ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
            : undefined;
        const heartbeatFiltered = filterHeartbeatPairs(
          validated,
          heartbeatSummary?.ackMaxChars,
          heartbeatSummary?.prompt,
        );
        const truncated = limitHistoryTurns(
          heartbeatFiltered,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        // Re-run tool_use/tool_result pairing repair after truncation, since
        // LimitHistoryTurns can orphan tool_result blocks by removing the
        // Assistant message that contained the matching tool_use.
        const limited = transcriptPolicy.repairToolUseResultPairing
          ? sanitizeToolUseResultPairing(truncated, {
              erroredAssistantResultPolicy: "drop",
            })
          : truncated;
        cacheTrace?.recordStage("session:limited", { messages: limited });
        if (limited.length > 0) {
          activeSession.agent.state.messages = limited;
        }

        if (params.contextEngine) {
          try {
            const assembled = await assembleAttemptContextEngine({
              availableTools: new Set(effectiveTools.map((tool) => tool.name)),
              citationsMode: params.config?.memory?.citations,
              contextEngine: params.contextEngine,
              messages: activeSession.messages,
              modelId: params.modelId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              tokenBudget: params.contextTokenBudget,
              ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
            });
            if (!assembled) {
              throw new Error("context engine assemble returned no result");
            }
            if (assembled.messages !== activeSession.messages) {
              activeSession.agent.state.messages = assembled.messages;
            }
            if (assembled.systemPromptAddition) {
              systemPromptText = prependSystemPromptAddition({
                systemPrompt: systemPromptText,
                systemPromptAddition: assembled.systemPromptAddition,
              });
              applySystemPromptOverrideToSession(activeSession, systemPromptText);
              log.debug(
                `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
              );
            }
          } catch (error) {
            log.warn(`context engine assemble failed, using pipeline messages: ${String(error)}`);
          }
        }
      } catch (error) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          clearPendingOnTimeout: true,
          sessionManager,
        });
        activeSession.dispose();
        throw error;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let yieldAborted = false;
      let timedOut = false;
      let idleTimedOut = false;
      let timedOutDuringCompaction = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        // If the reason is already an Error, preserve it to keep the original message
        // (e.g., "LLM idle timeout (60s): no response from model" instead of "aborted")
        if (reason instanceof Error) {
          const err = new Error(reason.message, { cause: reason });
          err.name = "AbortError";
          return err;
        }
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortCompaction = () => {
        if (!activeSession.isCompacting) {
          return;
        }
        try {
          activeSession.abortCompaction();
        } catch (error) {
          if (!isProbeSession) {
            log.warn(
              `embedded run abortCompaction failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(error)}`,
            );
          }
        }
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        abortCompaction();
        void activeSession.abort();
      };
      idleTimeoutTrigger = (error) => {
        idleTimedOut = true;
        abortRun(true, error);
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const { signal } = runAbortController;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession(
        buildEmbeddedSubscriptionParams({
          agentId: sessionAgentId,
          blockReplyBreak: params.blockReplyBreak,
          blockReplyChunking: params.blockReplyChunking,
          config: params.config,
          enforceFinalTag: params.enforceFinalTag,
          hookRunner: getGlobalHookRunner() ?? undefined,
          internalEvents: params.internalEvents,
          onAgentEvent: params.onAgentEvent,
          onAssistantMessageStart: params.onAssistantMessageStart,
          onBlockReply: params.onBlockReply,
          onBlockReplyFlush: params.onBlockReplyFlush,
          onPartialReply: params.onPartialReply,
          onReasoningEnd: params.onReasoningEnd,
          onReasoningStream: params.onReasoningStream,
          onToolResult: params.onToolResult,
          reasoningMode: params.reasoningLevel ?? "off",
          runId: params.runId,
          session: activeSession,
          sessionId: params.sessionId,
          sessionKey: sandboxSessionKey,
          shouldEmitToolOutput: params.shouldEmitToolOutput,
          shouldEmitToolResult: params.shouldEmitToolResult,
          silentExpected: params.silentExpected,
          toolResultFormat: params.toolResultFormat,
          verboseLevel: params.verboseLevel,
        }),
      );

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        isCompactionInFlight,
        getItemLifecycle,
        getMessagingToolSentTexts,
        getMessagingToolSentMediaUrls,
        getMessagingToolSentTargets,
        getSuccessfulCronAdds,
        didSendViaMessagingTool,
        getLastToolError,
        getUsageTotals,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle & {
        kind: "embedded";
        cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
      } = {
        abort: abortRun,
        cancel: () => {
          abortRun();
        },
        isCompacting: () => subscription.isCompacting(),
        isStreaming: () => activeSession.isStreaming,
        kind: "embedded",
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
      };
      let lastAssistant: AgentMessage | undefined;
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: ReturnType<typeof completePromptCacheObservation> = null;
      let promptCache: EmbeddedRunAttemptResult["promptCache"];
      if (params.replyOperation) {
        params.replyOperation.attachBackend(queueHandle);
      }
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
      let abortTimer: NodeJS.Timeout | undefined;
      let compactionGraceUsed = false;
      const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
        abortTimer = setTimeout(
          () => {
            const timeoutAction = resolveRunTimeoutDuringCompaction({
              graceAlreadyUsed: compactionGraceUsed,
              isCompactionInFlight: activeSession.isCompacting,
              isCompactionPendingOrRetrying: subscription.isCompacting(),
            });
            if (timeoutAction === "extend") {
              compactionGraceUsed = true;
              if (!isProbeSession) {
                log.warn(
                  `embedded run timeout reached during compaction; extending deadline: ` +
                    `runId=${params.runId} sessionId=${params.sessionId} extraMs=${compactionTimeoutMs}`,
                );
              }
              scheduleAbortTimer(compactionTimeoutMs, "compaction-grace");
              return;
            }

            if (!isProbeSession) {
              log.warn(
                reason === "compaction-grace"
                  ? `embedded run timeout after compaction grace: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs} compactionGraceMs=${compactionTimeoutMs}`
                  : `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
              );
            }
            if (
              shouldFlagCompactionTimeout({
                isCompactionInFlight: activeSession.isCompacting,
                isCompactionPendingOrRetrying: subscription.isCompacting(),
                isTimeout: true,
              })
            ) {
              timedOutDuringCompaction = true;
            }
            abortRun(true);
            if (!abortWarnTimer) {
              abortWarnTimer = setTimeout(() => {
                if (!activeSession.isStreaming) {
                  return;
                }
                if (!isProbeSession) {
                  log.warn(
                    `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                }
              }, 10_000);
            }
          },
          Math.max(1, delayMs),
        );
      };
      scheduleAbortTimer(params.timeoutMs, "initial");

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        if (
          shouldFlagCompactionTimeout({
            isCompactionInFlight: activeSession.isCompacting,
            isCompactionPendingOrRetrying: subscription.isCompacting(),
            isTimeout: timeout,
          })
        ) {
          timedOutDuringCompaction = true;
        }
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // Hook runner was already obtained earlier before tool creation
      const hookAgentId = sessionAgentId;

      let promptError: unknown = null;
      let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
      let promptErrorSource: "prompt" | "compaction" | "precheck" | null = null;
      let prePromptMessageCount = activeSession.messages.length;
      let skipPromptSubmission = false;
      try {
        const promptStartedAt = Date.now();

        // Run before_prompt_build hooks to allow plugins to inject prompt context.
        // Legacy compatibility: before_agent_start is also checked for context fields.
        let effectivePrompt = prependBootstrapPromptWarning(
          params.prompt,
          bootstrapPromptWarning.lines,
          {
            preserveExactPrompt: heartbeatPrompt,
          },
        );
        const hookCtx = {
          agentId: hookAgentId,
          channelId: params.messageChannel ?? params.messageProvider ?? undefined,
          messageProvider: params.messageProvider ?? undefined,
          modelId: params.model.id,
          modelProviderId: params.model.provider,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          trigger: params.trigger,
          workspaceDir: params.workspaceDir,
        };
        const hookResult = await resolvePromptBuildHookResult({
          hookCtx,
          hookRunner,
          legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
          messages: activeSession.messages,
          prompt: params.prompt,
        });
        {
          if (hookResult?.prependContext) {
            effectivePrompt = `${hookResult.prependContext}\n\n${effectivePrompt}`;
            log.debug(
              `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
            );
          }
          const legacySystemPrompt = normalizeOptionalString(hookResult?.systemPrompt) ?? "";
          if (legacySystemPrompt) {
            applySystemPromptOverrideToSession(activeSession, legacySystemPrompt);
            systemPromptText = legacySystemPrompt;
            log.debug(`hooks: applied systemPrompt override (${legacySystemPrompt.length} chars)`);
          }
          const prependedOrAppendedSystemPrompt = composeSystemPromptWithHookContext({
            appendSystemContext: hookResult?.appendSystemContext,
            baseSystemPrompt: systemPromptText,
            prependSystemContext: resolveAttemptPrependSystemContext({
              hookPrependSystemContext: hookResult?.prependSystemContext,
              sessionKey: params.sessionKey,
              trigger: params.trigger,
            }),
          });
          if (prependedOrAppendedSystemPrompt) {
            const prependSystemLen = hookResult?.prependSystemContext?.trim().length ?? 0;
            const appendSystemLen = hookResult?.appendSystemContext?.trim().length ?? 0;
            applySystemPromptOverrideToSession(activeSession, prependedOrAppendedSystemPrompt);
            systemPromptText = prependedOrAppendedSystemPrompt;
            log.debug(
              `hooks: applied prependSystemContext/appendSystemContext (${prependSystemLen}+${appendSystemLen} chars)`,
            );
          }
        }

        if (cacheObservabilityEnabled) {
          const cacheObservation = beginPromptCacheObservation({
            cacheRetention: effectivePromptCacheRetention,
            modelApi: params.model.api,
            modelId: params.modelId,
            provider: params.provider,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            streamStrategy,
            systemPrompt: systemPromptText,
            toolNames: promptCacheToolNames,
            transport: effectiveAgentTransport,
          });
          promptCacheChangesForTurn = cacheObservation.changes;
          cacheTrace?.recordStage("cache:state", {
            options: {
              changes:
                cacheObservation.changes?.map((change) => ({
                  code: change.code,
                  detail: change.detail,
                })) ?? undefined,
              previousCacheRead: cacheObservation.previousCacheRead ?? undefined,
              snapshot: cacheObservation.snapshot,
            },
          });
        }

        const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
          apiKey: await resolveEmbeddedAgentApiKey({
            authStorage: params.authStorage,
            provider: params.provider,
            resolvedApiKey: params.resolvedApiKey,
          }),
          extraParams: effectiveExtraParams,
          model: params.model,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          signal: runAbortController.signal,
          streamFn: activeSession.agent.streamFn,
          systemPrompt: systemPromptText,
        });
        if (googlePromptCacheStreamFn) {
          activeSession.agent.streamFn = googlePromptCacheStreamFn;
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          messages: activeSession.messages,
          prompt: effectivePrompt,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const sessionContext = sessionManager.buildSessionContext();
          activeSession.agent.state.messages = sessionContext.messages;
          const orphanRepairMessage =
            `Removed orphaned user message to prevent consecutive user turns. ` +
            `runId=${params.runId} sessionId=${params.sessionId} trigger=${params.trigger}`;
          if (shouldWarnOnOrphanedUserRepair(params.trigger)) {
            log.warn(orphanRepairMessage);
          } else {
            log.debug(orphanRepairMessage);
          }
        }
        const transcriptLeafId =
          (sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;
        const heartbeatSummary =
          params.config && sessionAgentId
            ? resolveHeartbeatSummaryForAgent(params.config, sessionAgentId)
            : undefined;

        try {
          // Idempotent cleanup: prune old image blocks to limit context
          // Growth. Only mutates turns older than a few assistant replies;
          // The delay also reduces prompt-cache churn.
          const didPruneImages = pruneProcessedHistoryImages(activeSession.messages);
          if (didPruneImages) {
            activeSession.agent.state.messages = activeSession.messages;
          }

          const filteredMessages = filterHeartbeatPairs(
            activeSession.messages,
            heartbeatSummary?.ackMaxChars,
            heartbeatSummary?.prompt,
          );
          if (filteredMessages.length < activeSession.messages.length) {
            activeSession.agent.state.messages = filteredMessages;
          }
          prePromptMessageCount = activeSession.messages.length;

          // Detect and load images referenced in the prompt for vision-capable models.
          // Images are prompt-local only (pi-like behavior).
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            imageOrder: params.imageOrder,
            maxBytes: MAX_IMAGE_BYTES,
            maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
            workspaceOnly: effectiveFsWorkspaceOnly,
            // Enforce sandbox path restrictions when sandbox is enabled
            sandbox:
              sandbox?.enabled && sandbox?.fsBridge
                ? { bridge: sandbox.fsBridge, root: sandbox.workspaceDir }
                : undefined,
          });

          cacheTrace?.recordStage("prompt:images", {
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length}`,
            prompt: effectivePrompt,
          });

          // Diagnostic: log context sizes before prompt to help debug early overflow errors.
          if (log.isEnabled("debug")) {
            const msgCount = activeSession.messages.length;
            const systemLen = systemPromptText?.length ?? 0;
            const promptLen = effectivePrompt.length;
            const sessionSummary = summarizeSessionContext(activeSession.messages);
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  historyMessages: activeSession.messages,
                  imagesCount: imageResult.images.length,
                  model: params.modelId,
                  prompt: effectivePrompt,
                  provider: params.provider,
                  runId: params.runId,
                  sessionId: params.sessionId,
                  systemPrompt: systemPromptText,
                },
                {
                  agentId: hookAgentId,
                  channelId: params.messageChannel ?? params.messageProvider ?? undefined,
                  messageProvider: params.messageProvider ?? undefined,
                  runId: params.runId,
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  trigger: params.trigger,
                  workspaceDir: params.workspaceDir,
                },
              )
              .catch((error) => {
                log.warn(`llm_input hook failed: ${String(error)}`);
              });
          }

          const reserveTokens = settingsManager.getCompactionReserveTokens();
          const contextTokenBudget = params.contextTokenBudget ?? DEFAULT_CONTEXT_TOKENS;
          const preemptiveCompaction = shouldPreemptivelyCompactBeforePrompt({
            contextTokenBudget,
            messages: activeSession.messages,
            prompt: effectivePrompt,
            reserveTokens,
            systemPrompt: systemPromptText,
          });
          if (preemptiveCompaction.route === "truncate_tool_results_only") {
            const truncationResult = truncateOversizedToolResultsInSessionManager({
              contextWindowTokens: contextTokenBudget,
              sessionFile: params.sessionFile,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              sessionManager,
            });
            if (truncationResult.truncated) {
              preflightRecovery = {
                handled: true,
                route: "truncate_tool_results_only",
                truncatedCount: truncationResult.truncatedCount,
              };
              log.info(
                `[context-overflow-precheck] early tool-result truncation succeeded for ` +
                  `${params.provider}/${params.modelId} route=${preemptiveCompaction.route} ` +
                  `truncatedCount=${truncationResult.truncatedCount} ` +
                  `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
                  `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve} ` +
                  `overflowTokens=${preemptiveCompaction.overflowTokens} ` +
                  `toolResultReducibleChars=${preemptiveCompaction.toolResultReducibleChars} ` +
                  `sessionFile=${params.sessionFile}`,
              );
              skipPromptSubmission = true;
            }
            if (!skipPromptSubmission) {
              log.warn(
                `[context-overflow-precheck] early tool-result truncation did not help for ` +
                  `${params.provider}/${params.modelId}; falling back to compaction ` +
                  `reason=${truncationResult.reason ?? "unknown"} sessionFile=${params.sessionFile}`,
              );
              preflightRecovery = { route: "compact_only" };
              promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
              promptErrorSource = "precheck";
              skipPromptSubmission = true;
            }
          }
          if (preemptiveCompaction.shouldCompact) {
            preflightRecovery =
              preemptiveCompaction.route === "compact_then_truncate"
                ? { route: "compact_then_truncate" }
                : { route: "compact_only" };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            log.warn(
              `[context-overflow-precheck] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${params.provider}/${params.modelId} ` +
                `route=${preemptiveCompaction.route} ` +
                `estimatedPromptTokens=${preemptiveCompaction.estimatedPromptTokens} ` +
                `promptBudgetBeforeReserve=${preemptiveCompaction.promptBudgetBeforeReserve} ` +
                `overflowTokens=${preemptiveCompaction.overflowTokens} ` +
                `toolResultReducibleChars=${preemptiveCompaction.toolResultReducibleChars} ` +
                `reserveTokens=${reserveTokens} sessionFile=${params.sessionFile}`,
            );
            skipPromptSubmission = true;
          }

          if (!skipPromptSubmission) {
            const btwSnapshotMessages = activeSession.messages.slice(-MAX_BTW_SNAPSHOT_MESSAGES);
            updateActiveEmbeddedRunSnapshot(params.sessionId, {
              inFlightPrompt: effectivePrompt,
              messages: btwSnapshotMessages,
              transcriptLeafId,
            });

            // Only pass images option if there are actually images to pass
            // This avoids potential issues with models that don't expect the images parameter
            if (imageResult.images.length > 0) {
              await abortable(
                activeSession.prompt(effectivePrompt, { images: imageResult.images }),
              );
            } else {
              await abortable(activeSession.prompt(effectivePrompt));
            }
          }
        } catch (error) {
          // Yield-triggered abort is intentional — treat as clean stop, not error.
          // Check the abort reason to distinguish from external aborts (timeout, user cancel)
          // That may race after yieldDetected is set.
          yieldAborted =
            yieldDetected &&
            isRunnerAbortError(error) &&
            error instanceof Error &&
            error.cause === "sessions_yield";
          if (yieldAborted) {
            aborted = false;
            // Ensure the session abort has mostly settled before proceeding, but
            // Don't deadlock the whole run if the underlying session abort hangs.
            await waitForSessionsYieldAbortSettle({
              runId: params.runId,
              sessionId: params.sessionId,
              settlePromise: yieldAbortSettled,
            });
            stripSessionsYieldArtifacts(activeSession);
            if (yieldMessage) {
              await persistSessionsYieldContextMessage(activeSession, yieldMessage);
            }
          } else {
            promptError = error;
            promptErrorSource = "prompt";
          }
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        // Capture snapshot before compaction wait so we have complete messages if timeout occurs
        // Check compaction state before and after to avoid race condition where compaction starts during capture
        // Use session state (not subscription) for snapshot decisions - need instantaneous compaction status
        const wasCompactingBefore = activeSession.isCompacting;
        const snapshot = [...activeSession.messages];
        const wasCompactingAfter = activeSession.isCompacting;
        // Only trust snapshot if compaction wasn't running before or after capture
        const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
        const preCompactionSessionId = activeSession.sessionId;
        const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;

        try {
          // Flush buffered block replies before waiting for compaction so the
          // User receives the assistant response immediately.  Without this,
          // Coalesced/buffered blocks stay in the pipeline until compaction
          // Finishes — which can take minutes on large contexts (#35074).
          if (params.onBlockReplyFlush) {
            await params.onBlockReplyFlush();
          }

          // Skip compaction wait when yield aborted the run — the signal is
          // Already tripped and abortable() would immediately reject.
          const compactionRetryWait = yieldAborted
            ? { timedOut: false }
            : await waitForCompactionRetryWithAggregateTimeout({
                abortable,
                aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
                isCompactionStillInFlight: isCompactionInFlight,
                waitForCompactionRetry,
              });
          if (compactionRetryWait.timedOut) {
            timedOutDuringCompaction = true;
            if (!isProbeSession) {
              log.warn(
                `compaction retry aggregate timeout (${COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS}ms): ` +
                  `proceeding with pre-compaction state runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }
        } catch (error) {
          if (isRunnerAbortError(error)) {
            if (!promptError) {
              promptError = error;
              promptErrorSource = "compaction";
            }
            if (!isProbeSession) {
              log.debug(
                `compaction wait aborted: runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          } else {
            throw error;
          }
        }

        // Check if ANY compaction occurred during the entire attempt (prompt + retry).
        // Using a cumulative count (> 0) instead of a delta check avoids missing
        // Compactions that complete during activeSession.prompt() before the delta
        // Baseline is sampled.
        const compactionOccurredThisAttempt = getCompactionCount() > 0;
        // Append cache-TTL timestamp AFTER prompt + compaction retry completes.
        // Previously this was before the prompt, which caused a custom entry to be
        // Inserted between compaction and the next prompt — breaking the
        // PrepareCompaction() guard that checks the last entry type, leading to
        // Double-compaction. See: https://github.com/openclaw/openclaw/issues/9282
        // Skip when timed out during compaction — session state may be inconsistent.
        // Also skip when compaction ran this attempt — appending a custom entry
        // After compaction would break the guard again. See: #28491
        appendAttemptCacheTtlIfNeeded({
          compactionOccurredThisAttempt,
          config: params.config,
          isCacheTtlEligibleProvider,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          sessionManager,
          timedOutDuringCompaction,
        });

        // If timeout occurred during compaction, use pre-compaction snapshot when available
        // (compaction restructures messages but does not add user/assistant turns).
        const snapshotSelection = selectCompactionTimeoutSnapshot({
          currentSessionId: activeSession.sessionId,
          currentSnapshot: [...activeSession.messages],
          preCompactionSessionId,
          preCompactionSnapshot,
          timedOutDuringCompaction,
        });
        if (timedOutDuringCompaction) {
          if (!isProbeSession) {
            log.warn(
              `using ${snapshotSelection.source} snapshot: timed out during compaction runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }
        ({ messagesSnapshot } = snapshotSelection);
        ({ sessionIdUsed } = snapshotSelection);

        lastAssistant = [...messagesSnapshot].toReversed().find((m) => m.role === "assistant");
        const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
          messagesSnapshot,
          prePromptMessageCount,
        });
        attemptUsage = getUsageTotals();
        cacheBreak = cacheObservabilityEnabled
          ? completePromptCacheObservation({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              usage: attemptUsage,
            })
          : null;
        const lastCallUsage = normalizeUsage(
          (currentAttemptAssistant as { usage?: UsageLike } | undefined)?.usage,
        );
        const promptCacheObservation =
          cacheObservabilityEnabled &&
          (cacheBreak || promptCacheChangesForTurn || typeof attemptUsage?.cacheRead === "number")
            ? {
                broke: Boolean(cacheBreak),
                ...(typeof cacheBreak?.previousCacheRead === "number"
                  ? { previousCacheRead: cacheBreak.previousCacheRead }
                  : {}),
                ...(typeof cacheBreak?.cacheRead === "number"
                  ? { cacheRead: cacheBreak.cacheRead }
                  : typeof attemptUsage?.cacheRead === "number"
                    ? { cacheRead: attemptUsage.cacheRead }
                    : {}),
                changes: cacheBreak?.changes ?? promptCacheChangesForTurn,
              }
            : undefined;
        promptCache = buildContextEnginePromptCacheInfo({
          lastCacheTouchAt: readLastCacheTtlTimestamp(sessionManager, {
            modelId: params.modelId,
            provider: params.provider,
          }),
          lastCallUsage,
          observation: promptCacheObservation,
          retention: effectivePromptCacheRetention,
        });

        if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
          try {
            sessionManager.appendCustomEntry("openclaw:prompt-error", {
              api: params.model.api,
              error: formatErrorMessage(promptError),
              model: params.modelId,
              provider: params.provider,
              runId: params.runId,
              sessionId: params.sessionId,
              timestamp: Date.now(),
            });
          } catch (error) {
            log.warn(`failed to persist prompt error entry: ${String(error)}`);
          }
        }

        // Let the active context engine run its post-turn lifecycle.
        if (params.contextEngine) {
          const afterTurnRuntimeContext = buildAfterTurnRuntimeContext({
            agentDir,
            attempt: params,
            promptCache,
            workspaceDir: effectiveWorkspace,
          });
          await finalizeAttemptContextEngineTurn({
            aborted,
            contextEngine: params.contextEngine,
            messagesSnapshot,
            prePromptMessageCount,
            promptError: Boolean(promptError),
            runMaintenance: async (contextParams) =>
              await runContextEngineMaintenance({
                contextEngine: contextParams.contextEngine as never,
                reason: contextParams.reason,
                runtimeContext: contextParams.runtimeContext,
                sessionFile: contextParams.sessionFile,
                sessionId: contextParams.sessionId,
                sessionKey: contextParams.sessionKey,
                sessionManager: contextParams.sessionManager as never,
              }),
            runtimeContext: afterTurnRuntimeContext,
            sessionFile: params.sessionFile,
            sessionIdUsed,
            sessionKey: params.sessionKey,
            sessionManager,
            tokenBudget: params.contextTokenBudget,
            warn: (message) => log.warn(message),
            yieldAborted,
          });
        }

        if (
          shouldRecordCompletedBootstrapTurn &&
          !promptError &&
          !aborted &&
          !yieldAborted &&
          !timedOutDuringCompaction &&
          !compactionOccurredThisAttempt
        ) {
          try {
            sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
              runId: params.runId,
              sessionId: params.sessionId,
              timestamp: Date.now(),
            });
          } catch (error) {
            log.warn(`failed to persist bootstrap completion entry: ${String(error)}`);
          }
        }

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        // Run even on compaction timeout so plugins can log/cleanup
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                durationMs: Date.now() - promptStartedAt,
                error: promptError ? formatErrorMessage(promptError) : undefined,
                messages: messagesSnapshot,
                success: !aborted && !promptError,
              },
              {
                agentId: hookAgentId,
                channelId: params.messageChannel ?? params.messageProvider ?? undefined,
                messageProvider: params.messageProvider ?? undefined,
                runId: params.runId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                trigger: params.trigger,
                workspaceDir: params.workspaceDir,
              },
            )
            .catch((error) => {
              log.warn(`agent_end hook failed: ${error}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (error) {
          // Unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // As it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(error)}`,
          );
        }
        if (params.replyOperation) {
          params.replyOperation.detachBackend(queueHandle);
        }
        clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ meta: entry.meta, toolName: entry.toolName }));
      if (cacheObservabilityEnabled) {
        if (cacheBreak) {
          const changeSummary =
            cacheBreak.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
            "no tracked cache input change";
          log.warn(
            `[prompt-cache] cache read dropped ${cacheBreak.previousCacheRead} -> ${cacheBreak.cacheRead} ` +
              `for ${params.provider}/${params.modelId} via ${streamStrategy}; ${changeSummary}`,
          );
          cacheTrace?.recordStage("cache:result", {
            options: {
              cacheRead: cacheBreak.cacheRead,
              changes:
                cacheBreak.changes?.map((change) => ({
                  code: change.code,
                  detail: change.detail,
                })) ?? undefined,
              previousCacheRead: cacheBreak.previousCacheRead,
            },
          });
        } else if (cacheTrace && promptCacheChangesForTurn) {
          cacheTrace.recordStage("cache:result", {
            note: "state changed without a cache-read break",
            options: {
              cacheRead: attemptUsage?.cacheRead ?? 0,
              changes: promptCacheChangesForTurn.map((change) => ({
                code: change.code,
                detail: change.detail,
              })),
            },
          });
        } else if (cacheTrace) {
          cacheTrace.recordStage("cache:result", {
            note: "stable cache inputs",
            options: {
              cacheRead: attemptUsage?.cacheRead ?? 0,
            },
          });
        }
      }

      if (hookRunner?.hasHooks("llm_output")) {
        hookRunner
          .runLlmOutput(
            {
              assistantTexts,
              lastAssistant,
              model: params.modelId,
              provider: params.provider,
              runId: params.runId,
              sessionId: params.sessionId,
              usage: attemptUsage,
            },
            {
              agentId: hookAgentId,
              channelId: params.messageChannel ?? params.messageProvider ?? undefined,
              messageProvider: params.messageProvider ?? undefined,
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              trigger: params.trigger,
              workspaceDir: params.workspaceDir,
            },
          )
          .catch((error) => {
            log.warn(`llm_output hook failed: ${String(error)}`);
          });
      }

      return {
        replayMetadata: buildAttemptReplayMetadata({
          didSendViaMessagingTool: didSendViaMessagingTool(),
          successfulCronAdds: getSuccessfulCronAdds(),
          toolMetas: toolMetasNormalized,
        }),
        itemLifecycle: getItemLifecycle(),
        aborted,
        timedOut,
        idleTimedOut,
        timedOutDuringCompaction,
        promptError,
        promptErrorSource,
        preflightRecovery,
        sessionIdUsed,
        bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
        bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        successfulCronAdds: getSuccessfulCronAdds(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage,
        promptCache,
        compactionCount: getCompactionCount(),
        // Client tool call detected (OpenResponses hosted tools)
        clientToolCall: clientToolCallDetected ?? undefined,
        yieldDetected: yieldDetected || undefined,
      };
    } finally {
      // Always tear down the session (and release the lock) before we leave this attempt.
      //
      // BUGFIX: Wait for the agent to be truly idle before flushing pending tool results.
      // Pi-agent-core's auto-retry resolves waitForRetry() on assistant message receipt,
      // *Before* tool execution completes in the retried agent loop. Without this wait,
      // FlushPendingToolResults() fires while tools are still executing, inserting
      // Synthetic "missing tool result" errors and causing silent agent failures.
      // See: https://github.com/openclaw/openclaw/issues/8643
      await cleanupEmbeddedAttemptResources({
        bundleLspRuntime,
        flushPendingToolResultsAfterIdle,
        releaseWsSession,
        removeToolResultContextGuard,
        session,
        sessionId: params.sessionId,
        sessionLock,
        sessionManager,
      });
    }
  } finally {
    restoreSkillEnv?.();
  }
}
