import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  estimateTokens,
} from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  ensureContextEnginesInitialized,
  resolveContextEngine,
} from "../../context-engine/index.js";
import {
  type CapturedCompactionCheckpointSnapshot,
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
  resolveSessionCompactionCheckpointReason,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  prepareProviderRuntimeAuth,
  resolveProviderSystemPromptContribution,
} from "../../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import { type enqueueCommand, enqueueCommandInLane } from "../../process/command-queue.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolCapabilities,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../channel-tools.js";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "../compaction-real-conversation.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  getApiKeyForModel,
  resolveModelAuthMode,
} from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import { createBundleLspToolRuntime } from "../pi-bundle-lsp-runtime.js";
import { createBundleMcpToolRuntime } from "../pi-bundle-mcp-tools.js";
import { ensureSessionHeader } from "../pi-embedded-helpers.js";
import { pickFallbackThinkingLevel } from "../pi-embedded-helpers.js";
import {
  consumeCompactionSafeguardCancelReason,
  setCompactionSafeguardCancelReason,
} from "../pi-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedPiSettingsManager } from "../pi-project-settings.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { resolveSandboxContext } from "../sandbox.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../session-write-lock.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  type SkillSnapshot,
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { classifyCompactionReason, resolveCompactionFailureReason } from "./compact-reasons.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";
import { readPiModelContextTokens } from "./model-context-tokens.js";
import { buildModelAliasLines, resolveModelAsync } from "./model.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";
import { shouldUseOpenAIWebSocketTransport } from "./run/attempt.thread-helpers.js";
import { buildEmbeddedSandboxInfo } from "./sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import { truncateSessionAfterCompaction } from "./session-truncation.js";
import { resolveEmbeddedRunSkillEntries } from "./skills-runtime.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";
import { collectAllowedToolNames } from "./tool-name-allowlist.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "./tool-schema-runtime.js";
import { splitSdkTools } from "./tool-split.js";
import type { EmbeddedPiCompactResult } from "./types.js";
import { mapThinkingLevel } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

export interface CompactEmbeddedPiSessionParams {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  /** Trusted sender id from inbound context for scoped message-tool discovery. */
  senderId?: string;
  authProfileId?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  /** Whether the sender is an owner (required for owner-only tools). */
  senderIsOwner?: boolean;
  sessionFile: string;
  /** Optional caller-observed live prompt tokens used for compaction diagnostics. */
  currentTokenCount?: number;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  tokenBudget?: number;
  force?: boolean;
  trigger?: "budget" | "overflow" | "manual";
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  abortSignal?: AbortSignal;
  /** Allow runtime plugins for this compaction to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
}

interface CompactionMessageMetrics {
  messages: number;
  historyTextChars: number;
  toolResultChars: number;
  estTokens?: number;
  contributors: { role: string; chars: number; tool?: string }[];
}

function hasRealConversationContent(
  msg: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  return isRealConversationMessage(msg, messages, index);
}

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

function prepareCompactionSessionAgent(params: {
  session: { agent: { streamFn?: unknown } };
  providerStreamFn: unknown;
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  sessionId: string;
  signal: AbortSignal;
  effectiveModel: ProviderRuntimeModel;
  resolvedApiKey?: string;
  authStorage: unknown;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  thinkLevel: ThinkLevel;
  sessionAgentId: string;
  effectiveWorkspace: string;
  agentDir: string;
}) {
  params.session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    authStorage: params.authStorage as never,
    currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session as never }),
    model: params.effectiveModel,
    providerStreamFn: params.providerStreamFn as never,
    resolvedApiKey: params.resolvedApiKey,
    sessionId: params.sessionId,
    shouldUseWebSocketTransport: params.shouldUseWebSocketTransport,
    signal: params.signal,
    wsApiKey: params.wsApiKey,
  });
  return applyExtraParamsToAgent(
    params.session.agent as never,
    params.config,
    params.provider,
    params.modelId,
    undefined,
    params.thinkLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.effectiveModel,
    params.agentDir,
  );
}

function resolveCompactionProviderStream(params: {
  effectiveModel: ProviderRuntimeModel;
  config?: OpenClawConfig;
  agentDir: string;
  effectiveWorkspace: string;
}) {
  return registerProviderStreamForModel({
    agentDir: params.agentDir,
    cfg: params.config,
    model: params.effectiveModel,
    workspaceDir: params.effectiveWorkspace,
  });
}

function normalizeObservedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function getMessageTextChars(msg: AgentMessage): number {
  const { content } = msg as { content?: unknown };
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const { text } = block as { text?: unknown };
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: { role: string; chars: number; tool?: string }[] = [];
  let estTokens = 0;
  let tokenEstimationFailed = false;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ chars, role, tool: resolveMessageToolLabel(msg) });
    if (!tokenEstimationFailed) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        tokenEstimationFailed = true;
      }
    }
  }

  return {
    contributors: contributors.toSorted((a, b) => b.chars - a.chars).slice(0, 3),
    estTokens: tokenEstimationFailed ? undefined : estTokens,
    historyTextChars,
    messages: messages.length,
    toolResultChars,
  };
}

function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    hasRealConversationContent(message, allMessages, index),
  );
}

/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export async function compactEmbeddedPiSessionDirect(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  const startedAt = Date.now();
  const diagId = params.diagId?.trim() || createCompactionDiagId();
  const trigger = params.trigger ?? "manual";
  const attempt = params.attempt ?? 1;
  const maxAttempts = params.maxAttempts ?? 1;
  const runId = params.runId ?? params.sessionId;
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  ensureRuntimePluginsLoaded({
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    config: params.config,
    workspaceDir: resolvedWorkspace,
  });
  const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
    authProfileId: params.authProfileId,
    config: params.config,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
    modelId: params.model,
    provider: params.provider,
  });
  const provider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
  const modelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
  const { authProfileId } = resolvedCompactionTarget;
  let thinkLevel: ThinkLevel = params.thinkLevel ?? "off";
  const attemptedThinking = new Set<ThinkLevel>();
  const fail = (reason: string): EmbeddedPiCompactResult => {
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${classifyCompactionReason(reason)} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      compacted: false,
      ok: false,
      reason,
    };
  };
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  await ensureOpenClawModelsJson(params.config, agentDir);
  const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
    provider,
    modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    const reason = error ?? `Unknown model: ${provider}/${modelId}`;
    return fail(reason);
  }
  let runtimeModel = model;
  let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>> | null = null;
  let hasRuntimeAuthExchange = false;
  try {
    apiKeyInfo = await getApiKeyForModel({
      agentDir,
      cfg: params.config,
      model: runtimeModel,
      profileId: authProfileId,
    });

    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new Error(
          `No API key resolved for provider "${runtimeModel.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
    } else {
      const preparedAuth = await prepareProviderRuntimeAuth({
        config: params.config,
        context: {
          agentDir,
          apiKey: apiKeyInfo.apiKey,
          authMode: apiKeyInfo.mode,
          config: params.config,
          env: process.env,
          model: runtimeModel,
          modelId,
          profileId: apiKeyInfo.profileId,
          provider: runtimeModel.provider,
          workspaceDir: resolvedWorkspace,
        },
        env: process.env,
        provider: runtimeModel.provider,
        workspaceDir: resolvedWorkspace,
      });
      if (preparedAuth?.baseUrl) {
        runtimeModel = { ...runtimeModel, baseUrl: preparedAuth.baseUrl };
      }
      const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
      hasRuntimeAuthExchange = Boolean(preparedAuth?.apiKey);
      if (!runtimeApiKey) {
        throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
      }
      authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
    }
  } catch (error) {
    const reason = formatErrorMessage(error);
    return fail(reason);
  }

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
  await ensureSessionHeader({
    cwd: effectiveWorkspace,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  const { sessionAgentId: effectiveSkillAgentId } = resolveSessionAgentIds({
    config: params.config,
    sessionKey: params.sessionKey,
  });

  let restoreSkillEnv: (() => void) | undefined;
  let compactionSessionManager: unknown = null;
  let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
  let checkpointSnapshotRetained = false;
  try {
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      agentId: effectiveSkillAgentId,
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
      agentId: effectiveSkillAgentId,
      config: params.config,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsSnapshot: params.skillsSnapshot,
      workspaceDir: effectiveWorkspace,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
    const { contextFiles } = await resolveBootstrapContextForRun({
      config: params.config,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      warn: makeBootstrapWarn({
        sessionLabel,
        warn: (message) => log.warn(message),
      }),
      workspaceDir: effectiveWorkspace,
    });
    // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
    // Threshold uses the effective limit, not the native context window.
    const runtimeModelWithContext = runtimeModel as ProviderRuntimeModel;
    const ctxInfo = resolveContextWindowInfo({
      cfg: params.config,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
      modelContextTokens: readPiModelContextTokens(runtimeModel),
      modelContextWindow: runtimeModelWithContext.contextWindow,
      modelId,
      provider,
    });
    const effectiveModel = applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(
        ctxInfo.tokens < (runtimeModelWithContext.contextWindow ?? Infinity)
          ? { ...runtimeModelWithContext, contextWindow: ctxInfo.tokens }
          : runtimeModelWithContext,
        apiKeyInfo,
      ),
      // Skip header injection when runtime auth exchange produced a
      // Different credential — the SDK reads the exchanged token from
      // AuthStorage automatically.
      hasRuntimeAuthExchange ? null : apiKeyInfo,
      params.config,
    );

    const runAbortController = new AbortController();
    const toolsRaw = createOpenClawCodingTools({
      abortSignal: runAbortController.signal,
      agentAccountId: params.agentAccountId,
      agentDir,
      allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      config: params.config,
      exec: {
        elevated: params.bashElevated,
      },
      groupChannel: params.groupChannel,
      groupId: params.groupId,
      groupSpace: params.groupSpace,
      messageProvider: resolvedMessageProvider,
      modelApi: model.api,
      modelAuthMode: resolveModelAuthMode(model.provider, params.config),
      modelCompat: effectiveModel.compat,
      modelContextWindowTokens: ctxInfo.tokens,
      modelId,
      modelProvider: model.provider,
      runId: params.runId,
      sandbox,
      senderIsOwner: params.senderIsOwner,
      sessionId: params.sessionId,
      sessionKey: sandboxSessionKey,
      spawnedBy: params.spawnedBy,
      workspaceDir: effectiveWorkspace,
    });
    const toolsEnabled = supportsModelTools(runtimeModel);
    const tools = normalizeProviderToolSchemas({
      config: params.config,
      env: process.env,
      model,
      modelApi: model.api,
      modelId,
      provider,
      tools: toolsEnabled ? toolsRaw : [],
      workspaceDir: effectiveWorkspace,
    });
    const bundleMcpRuntime = toolsEnabled
      ? await createBundleMcpToolRuntime({
          cfg: params.config,
          reservedToolNames: tools.map((tool) => tool.name),
          workspaceDir: effectiveWorkspace,
        })
      : undefined;
    const bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
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
    const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
    logProviderToolSchemaDiagnostics({
      config: params.config,
      env: process.env,
      model,
      modelApi: model.api,
      modelId,
      provider,
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
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      config: params.config,
      sessionKey: params.sessionKey,
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

    const runtimeInfo = {
      arch: os.arch(),
      capabilities: runtimeCapabilities,
      channel: runtimeChannel,
      channelActions,
      host: machineName,
      model: `${provider}/${modelId}`,
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      shell: detectRuntimeShell(),
    };
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(provider, {
      config: params.config,
      env: process.env,
      model,
      modelApi: model.api,
      modelId,
      workspaceDir: effectiveWorkspace,
    });
    const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
    const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
    const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const docsPath = await resolveOpenClawDocsPath({
      argv1: process.argv[1],
      cwd: effectiveWorkspace,
      moduleUrl: import.meta.url,
      workspaceDir: effectiveWorkspace,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);
    const promptContribution = resolveProviderSystemPromptContribution({
      config: params.config,
      context: {
        agentDir,
        agentId: sessionAgentId,
        config: params.config,
        modelId,
        promptMode,
        provider,
        runtimeCapabilities,
        runtimeChannel,
        workspaceDir: effectiveWorkspace,
      },
      provider,
      workspaceDir: effectiveWorkspace,
    });
    const buildSystemPromptOverride = (defaultThinkLevel: ThinkLevel) =>
      createSystemPromptOverride(
        resolveSystemPromptOverride({
          agentId: sessionAgentId,
          config: params.config,
        }) ??
          buildEmbeddedSystemPrompt({
            acpEnabled: params.config?.acp?.enabled !== false,
            contextFiles,
            defaultThinkLevel,
            docsPath: docsPath ?? undefined,
            extraSystemPrompt: params.extraSystemPrompt,
            heartbeatPrompt: resolveHeartbeatPromptForSystemPrompt({
              agentId: sessionAgentId,
              config: params.config,
              defaultAgentId,
            }),
            memoryCitationsMode: params.config?.memory?.citations,
            messageToolHints,
            modelAliasLines: buildModelAliasLines(params.config),
            ownerDisplay: ownerDisplay.ownerDisplay,
            ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
            ownerNumbers: params.ownerNumbers,
            promptContribution,
            promptMode,
            reactionGuidance,
            reasoningLevel: params.reasoningLevel ?? "off",
            reasoningTagHint,
            runtimeInfo,
            sandboxInfo,
            skillsPrompt,
            tools: effectiveTools,
            ttsHint,
            userTime,
            userTimeFormat,
            userTimezone,
            workspaceDir: effectiveWorkspace,
          }),
      );

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionLock = await acquireSessionWriteLock({
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: compactionTimeoutMs,
      }),
      sessionFile: params.sessionFile,
    });
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      await prewarmSessionFile(params.sessionFile);
      const transcriptPolicy = resolveTranscriptPolicy({
        config: params.config,
        env: process.env,
        model,
        modelApi: model.api,
        modelId,
        provider,
        workspaceDir: effectiveWorkspace,
      });
      const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        allowedToolNames,
        sessionKey: params.sessionKey,
      });
      checkpointSnapshot = captureCompactionCheckpointSnapshot({
        sessionFile: params.sessionFile,
        sessionManager,
      });
      compactionSessionManager = sessionManager;
      trackSessionManagerAccess(params.sessionFile);
      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        agentDir,
        cfg: params.config,
        cwd: effectiveWorkspace,
      });
      // Sets compaction/pruning runtime state and returns extension factories
      // That must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        model,
        modelId,
        provider,
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

      const { builtInTools, customTools } = splitSdkTools({
        sandboxEnabled: Boolean(sandbox?.enabled),
        tools: effectiveTools,
      });

      const providerStreamFn = resolveCompactionProviderStream({
        agentDir,
        config: params.config,
        effectiveModel,
        effectiveWorkspace,
      });
      const shouldUseWebSocketTransport = shouldUseOpenAIWebSocketTransport({
        modelApi: effectiveModel.api,
        provider,
      });
      const wsApiKey = shouldUseWebSocketTransport
        ? await resolveEmbeddedAgentApiKey({
            authStorage,
            provider,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
          })
        : undefined;
      if (shouldUseWebSocketTransport && !wsApiKey) {
        log.warn(
          `[ws-stream] no API key for provider=${provider}; keeping compaction HTTP transport`,
        );
      }
      while (true) {
        // Rebuild the compaction session on retry so provider wrappers, payload
        // Shaping, and the embedded system prompt all reflect the fallback level.
        attemptedThinking.add(thinkLevel);
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const createdSession = await createAgentSession({
            agentDir,
            authStorage,
            customTools,
            cwd: effectiveWorkspace,
            model: effectiveModel,
            modelRegistry,
            resourceLoader,
            sessionManager,
            settingsManager,
            thinkingLevel: mapThinkingLevel(thinkLevel),
            tools: builtInTools,
          });
          ({ session } = createdSession);
          applySystemPromptOverrideToSession(session, buildSystemPromptOverride(thinkLevel)());
          // Compaction builds the same embedded system prompt, so it must flow
          // Through the same transport/payload shaping stack as normal turns.
          prepareCompactionSessionAgent({
            agentDir,
            authStorage,
            config: params.config,
            effectiveModel,
            effectiveWorkspace,
            modelId,
            provider,
            providerStreamFn,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
            session,
            sessionAgentId,
            sessionId: params.sessionId,
            shouldUseWebSocketTransport,
            signal: runAbortController.signal,
            thinkLevel,
            wsApiKey,
          });

          const prior = await sanitizeSessionHistory({
            allowedToolNames,
            config: params.config,
            env: process.env,
            messages: session.messages,
            model,
            modelApi: model.api,
            modelId,
            policy: transcriptPolicy,
            provider,
            sessionId: params.sessionId,
            sessionManager,
            workspaceDir: effectiveWorkspace,
          });
          const validated = await validateReplayTurns({
            config: params.config,
            env: process.env,
            messages: prior,
            model,
            modelApi: model.api,
            modelId,
            policy: transcriptPolicy,
            provider,
            sessionId: params.sessionId,
            workspaceDir: effectiveWorkspace,
          });
          // Apply validated transcript to the live session even when no history limit is configured,
          // So compaction and hook metrics are based on the same message set.
          session.agent.state.messages = validated;
          // "Original" compaction metrics should describe the validated transcript that enters
          // Limiting/compaction, not the raw on-disk session snapshot.
          const originalMessages = [...session.messages];
          const truncated = limitHistoryTurns(
            session.messages,
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
          if (limited.length > 0) {
            session.agent.state.messages = limited;
          }
          const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
          const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
          const beforeHookMetrics = buildBeforeCompactionHookMetrics({
            currentMessages: session.messages,
            estimateTokensFn: estimateTokens,
            observedTokenCount,
            originalMessages,
          });
          const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
            hookRunner,
            messageProvider: resolvedMessageProvider,
            metrics: beforeHookMetrics,
            sessionAgentId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: effectiveWorkspace,
          });
          const { messageCountOriginal } = beforeHookMetrics;
          const diagEnabled = log.isEnabled("debug");
          const preMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics) {
            log.debug(
              `[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} ` +
                `pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} ` +
                `pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`,
            );
            log.debug(
              `[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`,
            );
          }

          if (!containsRealConversationMessages(session.messages)) {
            log.info(
              `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
            );
            return {
              compacted: false,
              ok: true,
              reason: "no real conversation messages",
            };
          }

          const compactStartedAt = Date.now();
          // Measure compactedCount from the original pre-limiting transcript so compaction
          // Lifecycle metrics represent total reduction through the compaction pipeline.
          const messageCountCompactionInput = messageCountOriginal;
          // Estimate full session tokens BEFORE compaction (including system prompt,
          // Bootstrap context, workspace files, and all history). This is needed for
          // A correct sanity check — result.tokensBefore only covers the summarizable
          // History subset, not the full session.
          let fullSessionTokensBefore = 0;
          try {
            fullSessionTokensBefore = limited.reduce((sum, msg) => sum + estimateTokens(msg), 0);
          } catch {
            // If token estimation throws on a malformed message, fall back to 0 so
            // The sanity check below becomes a no-op instead of crashing compaction.
          }
          const activeSession = session;
          const result = await compactWithSafetyTimeout(
            () => {
              setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
              return activeSession.compact(params.customInstructions);
            },
            compactionTimeoutMs,
            {
              abortSignal: params.abortSignal,
              onCancel: () => {
                activeSession.abortCompaction();
              },
            },
          );
          await runPostCompactionSideEffects({
            config: params.config,
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
          });
          let effectiveFirstKeptEntryId = result.firstKeptEntryId;
          let postCompactionLeafId =
            typeof sessionManager.getLeafId === "function"
              ? (sessionManager.getLeafId() ?? undefined)
              : undefined;
          if (params.trigger === "manual") {
            try {
              const hardenedBoundary = await hardenManualCompactionBoundary({
                sessionFile: params.sessionFile,
              });
              if (hardenedBoundary.applied) {
                effectiveFirstKeptEntryId =
                  hardenedBoundary.firstKeptEntryId ?? effectiveFirstKeptEntryId;
                postCompactionLeafId = hardenedBoundary.leafId ?? postCompactionLeafId;
                session.agent.state.messages = hardenedBoundary.messages;
              }
            } catch (error) {
              log.warn("[compaction] failed to harden manual compaction boundary", {
                errorMessage: formatErrorMessage(error),
              });
            }
          }
          // Estimate tokens after compaction by summing token estimates for remaining messages
          const tokensAfter = estimateTokensAfterCompaction({
            estimateTokensFn: estimateTokens,
            fullSessionTokensBefore,
            messagesAfter: session.messages,
            observedTokenCount,
          });
          const messageCountAfter = session.messages.length;
          const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                createdAt: compactStartedAt,
                firstKeptEntryId: effectiveFirstKeptEntryId,
                postEntryId: postCompactionLeafId,
                postLeafId: postCompactionLeafId,
                postSessionFile: params.sessionFile,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                snapshot: checkpointSnapshot,
                summary: result.summary,
                tokensAfter,
                tokensBefore: observedTokenCount ?? result.tokensBefore,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (error) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(error),
              });
            }
          }
          const postMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics && postMetrics) {
            log.debug(
              `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none ` +
                `durationMs=${Date.now() - compactStartedAt} retrying=false ` +
                `post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} ` +
                `post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} ` +
                `delta.messages=${postMetrics.messages - preMetrics.messages} ` +
                `delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} ` +
                `delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} ` +
                `delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`,
            );
          }
          await runAfterCompactionHooks({
            compactedCount,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            hookRunner,
            hookSessionKey,
            messageCountAfter,
            messageProvider: resolvedMessageProvider,
            missingSessionKey,
            sessionAgentId,
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
            tokensAfter,
            tokensBefore: result.tokensBefore,
            workspaceDir: effectiveWorkspace,
          });
          // Truncate session file to remove compacted entries (#39953)
          if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction) {
            try {
              const heartbeatSummary = resolveHeartbeatSummaryForAgent(
                params.config,
                sessionAgentId,
              );
              const truncResult = await truncateSessionAfterCompaction({
                ackMaxChars: heartbeatSummary.ackMaxChars,
                heartbeatPrompt: heartbeatSummary.prompt,
                sessionFile: params.sessionFile,
              });
              if (truncResult.truncated) {
                log.info(
                  `[compaction] post-compaction truncation removed ${truncResult.entriesRemoved} entries ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (error) {
              log.warn("[compaction] post-compaction truncation failed", {
                errorMessage: formatErrorMessage(error),
                errorStack: error instanceof Error ? error.stack : undefined,
              });
            }
          }
          return {
            compacted: true,
            ok: true,
            result: {
              details: result.details,
              firstKeptEntryId: effectiveFirstKeptEntryId,
              summary: result.summary,
              tokensAfter,
              tokensBefore: observedTokenCount ?? result.tokensBefore,
            },
          };
        } catch (error) {
          const fallbackThinking = pickFallbackThinkingLevel({
            attempted: attemptedThinking,
            message: formatErrorMessage(error),
          });
          if (fallbackThinking) {
            // Near-term provider fix: when compaction hits a reasoning-mandatory
            // Endpoint with `off`, retry once with `minimal` instead of surfacing
            // A user-visible failure.
            log.warn(
              `[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }
          throw error;
        } finally {
          try {
            await flushPendingToolResultsAfterIdle({
              agent: session?.agent,
              clearPendingOnTimeout: true,
              sessionManager,
            });
          } catch {
            /* Best-effort */
          }
          try {
            session?.dispose();
          } catch {
            /* Best-effort */
          }
        }
      }
    } finally {
      try {
        await bundleMcpRuntime?.dispose();
      } catch {
        /* Best-effort */
      }
      try {
        await bundleLspRuntime?.dispose();
      } catch {
        /* Best-effort */
      }
      await sessionLock.release();
    }
  } catch (error) {
    const reason = resolveCompactionFailureReason({
      reason: formatErrorMessage(error),
      safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager),
    });
    return fail(reason);
  } finally {
    if (!checkpointSnapshotRetained) {
      await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
    }
    restoreSkillEnv?.();
  }
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedPiSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedPiSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      ensureRuntimePluginsLoaded({
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
        config: params.config,
        workspaceDir: params.workspaceDir,
      });
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config);
      let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
      let checkpointSnapshotRetained = false;
      try {
        const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
        const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
          authProfileId: params.authProfileId,
          config: params.config,
          defaultModel: DEFAULT_MODEL,
          defaultProvider: DEFAULT_PROVIDER,
          modelId: params.model,
          provider: params.provider,
        });
        // Resolve token budget from the effective compaction model so engine-
        // Owned /compact implementations see the same target as the runtime.
        const ceProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
        const ceModelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
        const { model: ceModel } = await resolveModelAsync(
          ceProvider,
          ceModelId,
          agentDir,
          params.config,
        );
        const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
        const ceCtxInfo = resolveContextWindowInfo({
          cfg: params.config,
          defaultTokens: DEFAULT_CONTEXT_TOKENS,
          modelContextTokens: readPiModelContextTokens(ceModel),
          modelContextWindow: ceRuntimeModel?.contextWindow,
          modelId: ceModelId,
          provider: ceProvider,
        });
        // When the context engine owns compaction, its compact() implementation
        // Bypasses compactEmbeddedPiSessionDirect (which fires the hooks internally).
        // Fire before_compaction / after_compaction hooks here so plugin subscribers
        // Are notified regardless of which engine is active.
        const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
        checkpointSnapshot = engineOwnsCompaction
          ? captureCompactionCheckpointSnapshot({
              sessionFile: params.sessionFile,
              sessionManager: SessionManager.open(params.sessionFile),
            })
          : null;
        const hookRunner = engineOwnsCompaction
          ? asCompactionHookRunner(getGlobalHookRunner())
          : null;
        const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
        const { sessionAgentId } = resolveSessionAgentIds({
          config: params.config,
          sessionKey: params.sessionKey,
        });
        const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
        const hookCtx = {
          agentId: sessionAgentId,
          messageProvider: resolvedMessageProvider,
          sessionId: params.sessionId,
          sessionKey: hookSessionKey,
          workspaceDir: resolveUserPath(params.workspaceDir),
        };
        const runtimeContext = {
          ...params,
          ...buildEmbeddedCompactionRuntimeContext({
            agentAccountId: params.agentAccountId,
            agentDir,
            authProfileId: params.authProfileId,
            bashElevated: params.bashElevated,
            config: params.config,
            currentChannelId: params.currentChannelId,
            currentMessageId: params.currentMessageId,
            currentThreadTs: params.currentThreadTs,
            extraSystemPrompt: params.extraSystemPrompt,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            modelId: params.model,
            ownerNumbers: params.ownerNumbers,
            provider: params.provider,
            reasoningLevel: params.reasoningLevel,
            senderId: params.senderId,
            senderIsOwner: params.senderIsOwner,
            sessionKey: params.sessionKey,
            skillsSnapshot: params.skillsSnapshot,
            thinkLevel: params.thinkLevel,
            workspaceDir: params.workspaceDir,
          }),
        };
        // Engine-owned compaction doesn't load the transcript at this level, so
        // Message counts are unavailable.  We pass sessionFile so hook subscribers
        // Can read the transcript themselves if they need exact counts.
        if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) {
          try {
            await hookRunner.runBeforeCompaction(
              {
                messageCount: -1,
                sessionFile: params.sessionFile,
              },
              hookCtx,
            );
          } catch (error) {
            log.warn("before_compaction hook failed", {
              errorMessage: formatErrorMessage(error),
            });
          }
        }
        const result = await contextEngine.compact({
          compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
          currentTokenCount: params.currentTokenCount,
          customInstructions: params.customInstructions,
          force: params.trigger === "manual",
          runtimeContext,
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          tokenBudget: ceCtxInfo.tokens,
        });
        if (result.ok && result.compacted) {
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const postCompactionSession = SessionManager.open(params.sessionFile);
              const postLeafId = postCompactionSession.getLeafId() ?? undefined;
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                firstKeptEntryId: result.result?.firstKeptEntryId,
                postEntryId: postLeafId,
                postLeafId,
                postSessionFile: params.sessionFile,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                snapshot: checkpointSnapshot,
                summary: result.result?.summary,
                tokensAfter: result.result?.tokensAfter,
                tokensBefore: result.result?.tokensBefore,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (error) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(error),
              });
            }
          }
          await runContextEngineMaintenance({
            contextEngine,
            reason: "compaction",
            runtimeContext,
            sessionFile: params.sessionFile,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          });
        }
        if (engineOwnsCompaction && result.ok && result.compacted) {
          await runPostCompactionSideEffects({
            config: params.config,
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
          });
        }
        if (
          result.ok &&
          result.compacted &&
          hookRunner?.hasHooks?.("after_compaction") &&
          hookRunner.runAfterCompaction
        ) {
          try {
            await hookRunner.runAfterCompaction(
              {
                compactedCount: -1,
                messageCount: -1,
                sessionFile: params.sessionFile,
                tokenCount: result.result?.tokensAfter,
              },
              hookCtx,
            );
          } catch (error) {
            log.warn("after_compaction hook failed", {
              errorMessage: formatErrorMessage(error),
            });
          }
        }
        return {
          compacted: result.compacted,
          ok: result.ok,
          reason: result.reason,
          result: result.result
            ? {
                details: result.result.details,
                firstKeptEntryId: result.result.firstKeptEntryId ?? "",
                summary: result.result.summary ?? "",
                tokensAfter: result.result.tokensAfter,
                tokensBefore: result.result.tokensBefore,
              }
            : undefined,
        };
      } finally {
        if (!checkpointSnapshotRetained) {
          await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
        }
        await contextEngine.dispose?.();
      }
    }),
  );
}

export const __testing = {
  buildBeforeCompactionHookMetrics,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  hardenManualCompactionBoundary,
  hasMeaningfulConversationContent,
  hasRealConversationContent,
  prepareCompactionSessionAgent,
  resolveCompactionProviderStream,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} as const;

export { runPostCompactionSideEffects } from "./compaction-hooks.js";
