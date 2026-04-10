import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { toAcpRuntimeError } from "../acp/runtime/errors.js";
import { resolveAcpSessionCwd } from "../acp/runtime/session-identifiers.js";
import {
  type VerboseLevel,
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../auto-reply/thinking.js";
import { resolveCommandConfigWithSecrets } from "../cli/command-config-resolution.js";
import { formatCliCommand } from "../cli/command-format.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import {
  type OpenClawConfig,
  loadConfig,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { type SessionEntry, resolveAgentIdFromSessionKey } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
} from "./agent-scope.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import {
  buildAcpResult,
  createAcpVisibleTextAccumulator,
  emitAcpAssistantDelta,
  emitAcpLifecycleEnd,
  emitAcpLifecycleError,
  emitAcpLifecycleStart,
  persistAcpTurnTranscript,
  persistSessionEntry as persistSessionEntryBase,
  prependInternalEventContext,
  runAgentAttempt,
  sessionFileHasContent,
} from "./command/attempt-execution.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { updateSessionStoreAfterAgentRun } from "./command/session-store.js";
import { resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { canExecRequestNode } from "./exec-defaults.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";
import { loadModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  buildAllowedModelSet,
  modelKey,
  normalizeModelRef,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "./model-selection.js";
import { buildWorkspaceSkillSnapshot } from "./skills.js";
import { matchesSkillFilter } from "./skills/filter.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./skills/refresh.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { ensureAgentWorkspace } from "./workspace.js";

const log = createSubsystemLogger("agents/agent-command");

interface PersistSessionEntryParams {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
}

type OverrideFieldClearedByDelete =
  | "providerOverride"
  | "modelOverride"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
  | "claudeCliSessionId";

const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  await persistSessionEntryBase({
    ...params,
    clearedFields: OVERRIDE_FIELDS_CLEARED_BY_DELETE,
  });
}

async function resolveAgentRuntimeConfig(
  runtime: RuntimeEnv,
  params?: { runtimeTargetsChannelSecrets?: boolean },
): Promise<{
  loadedRaw: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  cfg: OpenClawConfig;
}> {
  const loadedRaw = loadConfig();
  const sourceConfig = await (async () => {
    try {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (snapshot.valid) {
        return snapshot.resolved;
      }
    } catch {
      // Fall back to runtime-loaded config when source snapshot is unavailable.
    }
    return loadedRaw;
  })();
  const { resolvedConfig: cfg } = await resolveCommandConfigWithSecrets({
    commandName: "agent",
    config: loadedRaw,
    runtime,
    targetIds: getAgentRuntimeCommandSecretTargetIds({
      includeChannelTargets: params?.runtimeTargetsChannelSecrets === true,
    }),
  });
  setRuntimeConfigSnapshot(cfg, sourceConfig);
  return { cfg, loadedRaw, sourceConfig };
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1F || (code >= 0x7F && code <= 0x9F)) {
      return true;
    }
  }
  return false;
}

function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  const body = prependInternalEventContext(message, opts.internalEvents);
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  const { cfg } = await resolveAgentRuntimeConfig(runtime, {
    runtimeTargetsChannelSecrets: opts.deliver === true,
  });
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    groupChannel: opts.groupChannel,
    groupId: opts.groupId,
    groupSpace: opts.groupSpace,
    spawnedBy: opts.spawnedBy,
    workspaceDir: opts.workspaceDir,
  });
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const laneRaw = normalizeOptionalString(opts.lane) ?? "";
  const isSubagentLane = laneRaw === String(AGENT_LANE_SUBAGENT);
  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (isSubagentLane
        ? 0
        : undefined);
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });

  const sessionResolution = resolveSession({
    agentId: agentIdOverride,
    cfg,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    to: opts.to,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      config: cfg,
      sessionKey: sessionKey ?? opts.sessionKey?.trim(),
    });
  const outboundSession = buildOutboundSessionContext({
    agentId: sessionAgentId,
    cfg,
    sessionKey,
  });
  // Internal callers (for example subagent spawns) may pin workspace inheritance.
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const runId = opts.runId?.trim() || sessionId;
  const acpManager = getAcpSessionManager();
  const acpResolution = sessionKey
    ? acpManager.resolveSession({
        cfg,
        sessionKey,
      })
    : null;

  return {
    acpManager,
    acpResolution,
    agentCfg,
    agentDir,
    body,
    cfg,
    isNewSession,
    normalizedSpawned,
    outboundSession,
    persistedThinking,
    persistedVerbose,
    runId,
    sessionAgentId,
    sessionEntry: sessionEntryRaw,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    thinkOnce,
    thinkOverride,
    timeoutMs,
    verboseOverride,
    workspaceDir,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const prepared = await prepareAgentCommandExecution(opts, runtime);
  const {
    body,
    cfg,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    agentDir,
    runId,
    acpManager,
    acpResolution,
  } = prepared;
  let {sessionEntry} = prepared;

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        channel: sessionEntry?.channel,
        chatType: sessionEntry?.chatType,
        entry: sessionEntry,
        sessionKey,
      });
      if (sendPolicy === "deny") {
        throw new Error("send blocked by session policy");
      }
    }

    if (acpResolution?.kind === "stale") {
      throw acpResolution.error;
    }

    if (acpResolution?.kind === "ready" && sessionKey) {
      const startedAt = Date.now();
      registerAgentRunContext(runId, {
        sessionKey,
      });
      emitAcpLifecycleStart({ runId, startedAt });

      const visibleTextAccumulator = createAcpVisibleTextAccumulator();
      let stopReason: string | undefined;
      try {
        const dispatchPolicyError = resolveAcpDispatchPolicyError(cfg);
        if (dispatchPolicyError) {
          throw dispatchPolicyError;
        }
        const acpAgent = normalizeAgentId(
          acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
        );
        const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
        if (agentPolicyError) {
          throw agentPolicyError;
        }

        await acpManager.runTurn({
          cfg,
          mode: "prompt",
          onEvent: (event) => {
            if (event.type === "done") {
              ({ stopReason } = event);
              return;
            }
            if (event.type !== "text_delta") {
              return;
            }
            if (event.stream && event.stream !== "output") {
              return;
            }
            if (!event.text) {
              return;
            }
            const visibleUpdate = visibleTextAccumulator.consume(event.text);
            if (!visibleUpdate) {
              return;
            }
            emitAcpAssistantDelta({
              delta: visibleUpdate.delta,
              runId,
              text: visibleUpdate.text,
            });
          },
          requestId: runId,
          sessionKey,
          signal: opts.abortSignal,
          text: body,
        });
      } catch (error) {
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        emitAcpLifecycleError({
          message: acpError.message,
          runId,
        });
        throw acpError;
      }

      emitAcpLifecycleEnd({ runId });

      const finalTextRaw = visibleTextAccumulator.finalizeRaw();
      const finalText = visibleTextAccumulator.finalize();
      try {
        sessionEntry = await persistAcpTurnTranscript({
          body,
          finalText: finalTextRaw,
          sessionAgentId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
          sessionEntry,
          sessionId,
          sessionKey,
          sessionStore,
          storePath,
          threadId: opts.threadId,
        });
      } catch (error) {
        log.warn(
          `ACP transcript persistence failed for ${sessionKey}: ${formatErrorMessage(error)}`,
        );
      }

      const result = buildAcpResult({
        abortSignal: opts.abortSignal,
        payloadText: finalText,
        startedAt,
        stopReason,
      });
      const {payloads} = result;

      return await deliverAgentCommandResult({
        cfg,
        deps,
        opts,
        outboundSession,
        payloads,
        result,
        runtime,
        sessionEntry,
      });
    }

    let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
    const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
    const shouldRefreshSkillsSnapshot =
      !currentSkillsSnapshot ||
      shouldRefreshSnapshotForVersion(currentSkillsSnapshot.version, skillsSnapshotVersion) ||
      !matchesSkillFilter(currentSkillsSnapshot.skillFilter, skillFilter);
    const needsSkillsSnapshot = isNewSession || shouldRefreshSkillsSnapshot;
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, {
          agentId: sessionAgentId,
          config: cfg,
          eligibility: {
            remote: getRemoteSkillEligibility({
              advertiseExecNode: canExecRequestNode({
                agentId: sessionAgentId,
                cfg,
                sessionEntry,
                sessionKey,
              }),
            }),
          },
          skillFilter,
          snapshotVersion: skillsSnapshotVersion,
        })
      : currentSkillsSnapshot;

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
      const current = sessionEntry ?? {
        sessionId,
        updatedAt: Date.now(),
      };
      const next: SessionEntry = {
        ...current,
        sessionId,
        skillsSnapshot,
        updatedAt: Date.now(),
      };
      await persistSessionEntry({
        entry: next,
        sessionKey,
        sessionStore,
        storePath,
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    if (sessionStore && sessionKey) {
      const entry = sessionStore[sessionKey] ??
        sessionEntry ?? { sessionId, updatedAt: Date.now() };
      const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
      if (thinkOverride) {
        next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      await persistSessionEntry({
        entry: next,
        sessionKey,
        sessionStore,
        storePath,
      });
      sessionEntry = next;
    }

    const configuredDefaultRef = resolveDefaultModelForAgent({
      agentId: sessionAgentId,
      cfg,
    });
    const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
      configuredDefaultRef.provider,
      configuredDefaultRef.model,
    );
    let provider = defaultProvider;
    let model = defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
    const hasStoredOverride = Boolean(
      sessionEntry?.modelOverride || sessionEntry?.providerOverride,
    );
    const explicitProviderOverride =
      typeof opts.provider === "string"
        ? normalizeExplicitOverrideInput(opts.provider, "provider")
        : undefined;
    const explicitModelOverride =
      typeof opts.model === "string"
        ? normalizeExplicitOverrideInput(opts.model, "model")
        : undefined;
    const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
    if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
      throw new Error("Model override is not authorized for this caller.");
    }
    const needsModelCatalog = hasAllowlist || hasStoredOverride || hasExplicitRunOverride;
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
    let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;
    let allowAnyModel = false;

    if (needsModelCatalog) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      const allowed = buildAllowedModelSet({
        agentId: sessionAgentId,
        catalog: modelCatalog,
        cfg,
        defaultModel,
        defaultProvider,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
      allowAnyModel = allowed.allowAny ?? false;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
        const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
        if (!allowAnyModel && !allowedModelKeys.has(key)) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { isDefault: true, model: defaultModel, provider: defaultProvider },
          });
          if (updated) {
            await persistSessionEntry({
              entry,
              sessionKey,
              sessionStore,
              storePath,
            });
          }
        }
      }
    }

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    let storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride);
      const key = modelKey(normalizedStored.provider, normalizedStored.model);
      if (allowAnyModel || allowedModelKeys.has(key)) {
        ({ provider } = normalizedStored);
        ({ model } = normalizedStored);
      }
    }
    let providerForAuthProfileValidation = provider;
    if (hasExplicitRunOverride) {
      const explicitRef = explicitModelOverride
        ? (explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, explicitModelOverride)
          : parseModelRef(explicitModelOverride, provider))
        : (explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, model)
          : null);
      if (!explicitRef) {
        throw new Error("Invalid model override.");
      }
      const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
      if (!allowAnyModel && !allowedModelKeys.has(explicitKey)) {
        throw new Error(
          `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
        );
      }
      ({ provider } = explicitRef);
      ({ model } = explicitRef);
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        if (!profile || profile.provider !== providerForAuthProfileValidation) {
          if (sessionStore && sessionKey) {
            await clearSessionAuthProfileOverride({
              sessionEntry: entry,
              sessionKey,
              sessionStore,
              storePath,
            });
          }
        }
      }
    }

    if (!resolvedThinkLevel) {
      let catalogForThinking = modelCatalog ?? allowedModelCatalog;
      if (!catalogForThinking || catalogForThinking.length === 0) {
        modelCatalog = await loadModelCatalog({ config: cfg });
        catalogForThinking = modelCatalog;
      }
      resolvedThinkLevel = resolveThinkingDefault({
        catalog: catalogForThinking,
        cfg,
        model,
        provider,
      });
    }
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        const entry = sessionEntry;
        entry.thinkingLevel = "high";
        entry.updatedAt = Date.now();
        await persistSessionEntry({
          entry,
          sessionKey,
          sessionStore,
          storePath,
        });
      }
    }
    let sessionFile: string | undefined;
    if (sessionStore && sessionKey) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        agentId: sessionAgentId,
        sessionEntry,
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
        threadId: opts.threadId,
      });
      ({ sessionFile } = resolvedSessionFile);
      ({ sessionEntry } = resolvedSessionFile);
    }
    if (!sessionFile) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        agentId: sessionAgentId,
        sessionEntry,
        sessionId,
        sessionKey: sessionKey ?? sessionId,
        storePath,
        threadId: opts.threadId,
      });
      ({ sessionFile } = resolvedSessionFile);
      ({ sessionEntry } = resolvedSessionFile);
    }

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runAgentAttempt>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    const MAX_LIVE_SWITCH_RETRIES = 5;
    let liveSwitchRetries = 0;
    for (;;) {
      try {
        const runContext = resolveAgentRunContext(opts);
        const messageChannel = resolveMessageChannel(
          runContext.messageChannel,
          opts.replyChannel ?? opts.channel,
        );
        const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
        const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
          agentId: sessionAgentId,
          cfg,
          hasSessionModelOverride: Boolean(storedModelOverride),
        });

        let fallbackAttemptIndex = 0;
        const fallbackResult = await runWithModelFallback({
          agentDir,
          cfg,
          fallbacksOverride: effectiveFallbacksOverride,
          model,
          provider,
          run: async (providerOverride, modelOverride, runOptions) => {
            const isFallbackRetry = fallbackAttemptIndex > 0;
            fallbackAttemptIndex += 1;
            return runAgentAttempt({
              agentDir,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              authProfileProvider: providerForAuthProfileValidation,
              body,
              cfg,
              isFallbackRetry,
              messageChannel,
              modelOverride,
              onAgentEvent: (evt) => {
                if (
                  evt.stream === "lifecycle" &&
                  typeof evt.data?.phase === "string" &&
                  (evt.data.phase === "end" || evt.data.phase === "error")
                ) {
                  lifecycleEnded = true;
                }
              },
              opts,
              providerOverride,
              resolvedThinkLevel,
              resolvedVerboseLevel,
              runContext,
              runId,
              sessionAgentId,
              sessionEntry,
              sessionFile,
              sessionHasHistory: !isNewSession || (await sessionFileHasContent(sessionFile)),
              sessionId,
              sessionKey,
              sessionStore,
              skillsSnapshot,
              spawnedBy,
              storePath,
              timeoutMs,
              workspaceDir,
            });
          },
          runId,
        });
        ({ result } = fallbackResult);
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
        if (!lifecycleEnded) {
          const {stopReason} = result.meta;
          if (stopReason && stopReason !== "end_turn") {
            console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
          }
          emitAgentEvent({
            data: {
              aborted: result.meta.aborted ?? false,
              endedAt: Date.now(),
              phase: "end",
              startedAt,
              stopReason,
            },
            runId,
            stream: "lifecycle",
          });
        }
        break;
      } catch (error) {
        if (error instanceof LiveSessionModelSwitchError) {
          liveSwitchRetries++;
          if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
            log.error(
              `Live session model switch in subagent run ${runId}: exceeded maximum retries (${MAX_LIVE_SWITCH_RETRIES})`,
            );
            if (!lifecycleEnded) {
              emitAgentEvent({
                data: {
                  endedAt: Date.now(),
                  error: "Agent run failed",
                  phase: "error",
                  startedAt,
                },
                runId,
                stream: "lifecycle",
              });
            }
            throw new Error(
              `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`,
              { cause: error },
            );
          }
          const switchRef = normalizeModelRef(error.provider, error.model);
          const switchKey = modelKey(switchRef.provider, switchRef.model);
          if (!allowAnyModel && !allowedModelKeys.has(switchKey)) {
            log.info(
              `Live session model switch in subagent run ${runId}: ` +
                `rejected ${sanitizeForLog(error.provider)}/${sanitizeForLog(error.model)} (not in allowlist)`,
            );
            if (!lifecycleEnded) {
              emitAgentEvent({
                data: {
                  endedAt: Date.now(),
                  error: "Agent run failed",
                  phase: "error",
                  startedAt,
                },
                runId,
                stream: "lifecycle",
              });
            }
            throw new Error(
              `Live model switch rejected: ${sanitizeForLog(error.provider)}/${sanitizeForLog(error.model)} is not in the agent allowlist`,
              { cause: error },
            );
          }
          const previousProvider = provider;
          const previousModel = model;
          ({ provider } = error);
          ({ model } = error);
          fallbackProvider = error.provider;
          fallbackModel = error.model;
          providerForAuthProfileValidation = error.provider;
          if (sessionEntry) {
            sessionEntry = { ...sessionEntry };
            sessionEntry.authProfileOverride = error.authProfileId;
            sessionEntry.authProfileOverrideSource = error.authProfileId
              ? error.authProfileIdSource
              : undefined;
            sessionEntry.authProfileOverrideCompactionCount = undefined;
          }
          if (
            storedModelOverride ||
            error.model !== previousModel ||
            error.provider !== previousProvider
          ) {
            storedModelOverride = error.model;
          }
          lifecycleEnded = false;
          log.info(
            `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(error.provider)}/${sanitizeForLog(error.model)}`,
          );
          continue;
        }
        if (!lifecycleEnded) {
          emitAgentEvent({
            data: {
              endedAt: Date.now(),
              error: error instanceof Error ? error.message : "Agent run failed",
              phase: "error",
              startedAt,
            },
            runId,
            stream: "lifecycle",
          });
        }
        throw error;
      }
    }

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        defaultModel: model,
        defaultProvider: provider,
        fallbackModel,
        fallbackProvider,
        result,
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      opts,
      outboundSession,
      payloads,
      result,
      runtime,
      sessionEntry,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  return await agentCommandInternal(
    {
      ...opts,
      // AgentCommand is the trusted-operator entrypoint used by CLI/local flows.
      // Ingress callers must opt into owner semantics explicitly via
      // AgentCommandFromIngress so network-facing paths cannot inherit this default by accident.
      senderIsOwner: opts.senderIsOwner ?? true,
      // Local/CLI callers are trusted by default for per-run model overrides.
      allowModelOverride: opts.allowModelOverride ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress must declare the trust level explicitly at the boundary.
    // This keeps network-facing callers from silently picking up the local trusted default.
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      allowModelOverride: opts.allowModelOverride,
      senderIsOwner: opts.senderIsOwner,
    },
    runtime,
    deps,
  );
}

export const __testing = {
  prepareAgentCommandExecution,
  resolveAgentRuntimeConfig,
};
