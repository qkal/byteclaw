import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob, CronRunTelemetry } from "../types.js";
import {
  dispatchCronDelivery,
  matchesMessagingToolDeliveryTarget,
  resolveCronDeliveryBestEffort,
} from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  resolveCronPayloadOutcome,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";
import { type CronExecutionResult, executeCronRun } from "./run-executor.js";
import {
  type CronLiveSelection,
  type MutableCronSession,
  type PersistCronSessionEntry,
  createPersistCronSessionEntry,
  markCronSessionPreRun,
  persistCronSkillsSnapshotIfChanged,
} from "./run-session-state.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  buildSafeExternalPrompt,
  deriveSessionTotalTokens,
  detectSuspiciousPatterns,
  ensureAgentWorkspace,
  hasNonzeroUsage,
  isCliProvider,
  isExternalHookSession,
  loadModelCatalog,
  logWarn,
  lookupContextTokens,
  mapHookExternalContentSource,
  normalizeAgentId,
  normalizeThinkLevel,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentTimeoutMs,
  resolveAgentWorkspaceDir,
  resolveCronStyleNow,
  resolveDefaultAgentId,
  resolveHookExternalContentSource,
  resolveSessionAuthProfileOverride,
  resolveThinkingDefault,
  setSessionRuntimeModel,
  supportsXHighThinking,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

let sessionStoreRuntimePromise:
  | Promise<typeof import("../../config/sessions/store.runtime.js")>
  | undefined;

async function loadSessionStoreRuntime() {
  sessionStoreRuntimePromise ??= import("../../config/sessions/store.runtime.js");
  return await sessionStoreRuntimePromise;
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type { RunCronAgentTurnResult } from "./run.types.js";

type ResolvedCronDeliveryTarget = Awaited<ReturnType<typeof resolveDeliveryTarget>>;

type IsolatedDeliveryContract = "cron-owned" | "shared";

function resolveCronToolPolicy(params: {
  deliveryRequested: boolean;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryContract: IsolatedDeliveryContract;
}) {
  return {
    // Only enforce an explicit message target when the cron delivery target
    // Was successfully resolved. When resolution fails the agent should not
    // Be blocked by a target it cannot satisfy (#27898).
    requireExplicitMessageTarget: params.deliveryRequested && params.resolvedDelivery.ok,
    // Cron-owned runs always route user-facing delivery through the runner
    // Itself. Shared callers keep the previous behavior so non-cron paths do
    // Not silently lose the message tool when no explicit delivery is active.
    disableMessageTool: params.deliveryContract === "cron-owned" ? true : params.deliveryRequested,
  };
}

async function resolveCronDeliveryContext(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  deliveryContract: IsolatedDeliveryContract;
}) {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  if (!deliveryPlan.requested) {
    const resolvedDelivery = {
      accountId: undefined,
      channel: undefined,
      error: new Error("cron delivery not requested"),
      mode: "implicit" as const,
      ok: false as const,
      threadId: undefined,
      to: undefined,
    };
    return {
      deliveryPlan,
      deliveryRequested: false,
      resolvedDelivery,
      toolPolicy: resolveCronToolPolicy({
        deliveryContract: params.deliveryContract,
        deliveryRequested: false,
        resolvedDelivery,
      }),
    };
  }
  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, params.agentId, {
    accountId: deliveryPlan.accountId,
    channel: deliveryPlan.channel ?? "last",
    sessionKey: params.job.sessionKey,
    threadId: deliveryPlan.threadId,
    to: deliveryPlan.to,
  });
  return {
    deliveryPlan,
    deliveryRequested: deliveryPlan.requested,
    resolvedDelivery,
    toolPolicy: resolveCronToolPolicy({
      deliveryContract: params.deliveryContract,
      deliveryRequested: deliveryPlan.requested,
      resolvedDelivery,
    }),
  };
}

function appendCronDeliveryInstruction(params: {
  commandBody: string;
  deliveryRequested: boolean;
}) {
  if (!params.deliveryRequested) {
    return params.commandBody;
  }
  return `${params.commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
}

function resolvePositiveContextTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function loadCliRunnerRuntime() {
  return await import("../../agents/cli-runner.runtime.js");
}

async function loadUsageFormatRuntime() {
  return await import("../../utils/usage-format.js");
}

interface RunCronAgentTurnParams {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
}

type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

interface PreparedCronRunContext {
  input: RunCronAgentTurnParams;
  cfgWithAgentDefaults: OpenClawConfig;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  agentDir: string;
  agentSessionKey: string;
  runSessionId: string;
  runSessionKey: string;
  workspaceDir: string;
  commandBody: string;
  cronSession: MutableCronSession;
  persistSessionEntry: PersistCronSessionEntry;
  withRunSession: WithRunSession;
  agentPayload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
  resolvedDelivery: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
  deliveryRequested: boolean;
  toolPolicy: ReturnType<typeof resolveCronToolPolicy>;
  skillsSnapshot: SkillSnapshot;
  liveSelection: CronLiveSelection;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
}

type CronPreparationResult =
  | { ok: true; context: PreparedCronRunContext }
  | { ok: false; result: RunCronAgentTurnResult };

async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
}): Promise<CronPreparationResult> {
  const { input } = params;
  const defaultAgentId = resolveDefaultAgentId(input.cfg);
  const requestedAgentId =
    typeof input.agentId === "string" && input.agentId.trim()
      ? input.agentId
      : (typeof input.job.agentId === "string" && input.job.agentId.trim()
        ? input.job.agentId
        : undefined);
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(input.cfg, normalizedRequested)
    : undefined;
  const agentId = normalizedRequested ?? defaultAgentId;
  const agentCfg: AgentDefaultsConfig = buildCronAgentDefaultsConfig({
    agentConfigOverride,
    defaults: input.cfg.agents?.defaults,
  });
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...input.cfg,
    agents: { ...input.cfg.agents, defaults: agentCfg},
  };
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };

  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({
    agentId,
    cfg: input.cfg,
    mainKey: input.cfg.session?.mainKey,
    sessionKey: baseSessionKey,
  });
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const workspaceDirRaw = resolveAgentWorkspaceDir(input.cfg, agentId);
  const agentDir = resolveAgentDir(input.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
  });
  const workspaceDir = workspace.dir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const cronSession = resolveCronSession({
    agentId,
    cfg: input.cfg,
    forceNew: input.job.sessionTarget === "isolated",
    nowMs: now,
    sessionKey: agentSessionKey,
  });
  const runSessionId = cronSession.sessionEntry.sessionId;
  const runSessionKey = baseSessionKey.startsWith("cron:")
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const persistSessionEntry = createPersistCronSessionEntry({
    agentSessionKey,
    cronSession,
    isFastTestEnv: params.isFastTestEnv,
    runSessionKey,
    updateSessionStore: async (storePath, update) => {
      const { updateSessionStore } = await loadSessionStoreRuntime();
      await updateSessionStore(storePath, update);
    },
  });
  const withRunSession: WithRunSession = (result) => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
    const labelSuffix =
      typeof input.job.name === "string" && input.job.name.trim()
        ? input.job.name.trim()
        : input.job.id;
    cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
  }

  const resolvedModelSelection = await resolveCronModelSelection({
    agentConfigOverride,
    cfg: input.cfg,
    cfgWithAgentDefaults,
    isGmailHook,
    payload: input.job.payload,
    sessionEntry: cronSession.sessionEntry,
  });
  if (!resolvedModelSelection.ok) {
    return {
      ok: false,
      result: withRunSession({ error: resolvedModelSelection.error, status: "error" }),
    };
  }
  const {provider} = resolvedModelSelection;
  const {model} = resolvedModelSelection;
  if (resolvedModelSelection.warning) {
    logWarn(resolvedModelSelection.warning);
  }

  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(input.cfg.hooks?.gmail?.thinking)
    : undefined;
  const jobThink = normalizeThinkLevel(
    (input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined) ?? undefined,
  );
  let thinkLevel: ThinkLevel | undefined = jobThink ?? hooksGmailThinking;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      catalog: await loadCatalog(),
      cfg: cfgWithAgentDefaults,
      model,
      provider,
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[cron:${input.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined,
  });
  const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
  const { deliveryRequested, resolvedDelivery, toolPolicy } = await resolveCronDeliveryContext({
    agentId,
    cfg: cfgWithAgentDefaults,
    deliveryContract: input.deliveryContract ?? "cron-owned",
    job: input.job,
  });

  const { formattedTime, timeLine } = resolveCronStyleNow(input.cfg, now);
  const base = `[cron:${input.job.id} ${input.job.name}] ${input.message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    const suspiciousPatterns = detectSuspiciousPatterns(input.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: input.message,
      jobId: input.job.id,
      jobName: input.job.name,
      source: hookType,
      timestamp: formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });

  const skillsSnapshot = resolveCronSkillsSnapshot({
    agentId,
    config: cfgWithAgentDefaults,
    existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
    isFastTestEnv: params.isFastTestEnv,
    workspaceDir,
  });
  await persistCronSkillsSnapshotIfChanged({
    cronSession,
    isFastTestEnv: params.isFastTestEnv,
    nowMs: Date.now(),
    persistSessionEntry,
    skillsSnapshot,
  });

  markCronSessionPreRun({ entry: cronSession.sessionEntry, model, provider });
  try {
    await persistSessionEntry();
  } catch (error) {
    logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(error)}`);
  }
  const authProfileId = await resolveSessionAuthProfileOverride({
    agentDir,
    cfg: cfgWithAgentDefaults,
    isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated",
    provider,
    sessionEntry: cronSession.sessionEntry,
    sessionKey: agentSessionKey,
    sessionStore: cronSession.store,
    storePath: cronSession.storePath,
  });
  const liveSelection: CronLiveSelection = {
    authProfileId,
    authProfileIdSource: authProfileId
      ? cronSession.sessionEntry.authProfileOverrideSource
      : undefined,
    model,
    provider,
  };

  return {
    context: {
      agentCfg,
      agentDir,
      agentId,
      agentPayload,
      agentSessionKey,
      cfgWithAgentDefaults,
      commandBody,
      cronSession,
      deliveryRequested,
      input,
      liveSelection,
      persistSessionEntry,
      resolvedDelivery,
      runSessionId,
      runSessionKey,
      skillsSnapshot,
      thinkLevel,
      timeoutMs,
      toolPolicy,
      withRunSession,
      workspaceDir,
    },
    ok: true,
  };
}

async function finalizeCronRun(params: {
  prepared: PreparedCronRunContext;
  execution: CronExecutionResult;
  abortReason: () => string;
  isAborted: () => boolean;
}): Promise<RunCronAgentTurnResult> {
  const { prepared, execution } = params;
  const finalRunResult = execution.runResult;
  const payloads = finalRunResult.payloads ?? [];
  let telemetry: CronRunTelemetry | undefined;

  if (finalRunResult.meta?.systemPromptReport) {
    prepared.cronSession.sessionEntry.systemPromptReport = finalRunResult.meta.systemPromptReport;
  }
  const usage = finalRunResult.meta?.agentMeta?.usage;
  const promptTokens = finalRunResult.meta?.agentMeta?.promptTokens;
  const modelUsed =
    finalRunResult.meta?.agentMeta?.model ??
    execution.fallbackModel ??
    execution.liveSelection.model;
  const providerUsed =
    finalRunResult.meta?.agentMeta?.provider ??
    execution.fallbackProvider ??
    execution.liveSelection.provider;
  const contextTokens =
    resolvePositiveContextTokens(prepared.agentCfg?.contextTokens) ??
    lookupContextTokens(modelUsed, { allowAsyncLoad: false }) ??
    resolvePositiveContextTokens(prepared.cronSession.sessionEntry.contextTokens) ??
    DEFAULT_CONTEXT_TOKENS;

  setSessionRuntimeModel(prepared.cronSession.sessionEntry, {
    model: modelUsed,
    provider: providerUsed,
  });
  prepared.cronSession.sessionEntry.contextTokens = contextTokens;
  if (isCliProvider(providerUsed, prepared.cfgWithAgentDefaults)) {
    const cliSessionId = finalRunResult.meta?.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      const { setCliSessionId } = await loadCliRunnerRuntime();
      setCliSessionId(prepared.cronSession.sessionEntry, providerUsed, cliSessionId);
    }
  }
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } = await loadUsageFormatRuntime();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      contextTokens,
      promptTokens,
      usage,
    });
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        cost: resolveModelCostConfig({
          config: prepared.cfgWithAgentDefaults,
          model: modelUsed,
          provider: providerUsed,
        }),
        usage,
      }),
    );
    prepared.cronSession.sessionEntry.inputTokens = input;
    prepared.cronSession.sessionEntry.outputTokens = output;
    const telemetryUsage: NonNullable<CronRunTelemetry["usage"]> = {
      input_tokens: input,
      output_tokens: output,
    };
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      prepared.cronSession.sessionEntry.totalTokens = totalTokens;
      prepared.cronSession.sessionEntry.totalTokensFresh = true;
      telemetryUsage.total_tokens = totalTokens;
    } else {
      prepared.cronSession.sessionEntry.totalTokens = undefined;
      prepared.cronSession.sessionEntry.totalTokensFresh = false;
    }
    prepared.cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
    prepared.cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;
    if (runEstimatedCostUsd !== undefined) {
      prepared.cronSession.sessionEntry.estimatedCostUsd =
        (resolveNonNegativeNumber(prepared.cronSession.sessionEntry.estimatedCostUsd) ?? 0) +
        runEstimatedCostUsd;
    }
    telemetry = {
      model: modelUsed,
      provider: providerUsed,
      usage: telemetryUsage,
    };
  } else {
    telemetry = { model: modelUsed, provider: providerUsed };
  }
  await prepared.persistSessionEntry();

  if (params.isAborted()) {
    return prepared.withRunSession({ error: params.abortReason(), status: "error", ...telemetry });
  }
  let {
    summary,
    outputText,
    synthesizedText,
    deliveryPayloads,
    deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    embeddedRunError,
  } = resolveCronPayloadOutcome({
    finalAssistantVisibleText: finalRunResult.meta?.finalAssistantVisibleText,
    payloads,
    preferFinalAssistantVisibleText: prepared.resolvedDelivery.channel === "telegram",
    runLevelError: finalRunResult.meta?.error,
  });
  const resolveRunOutcome = (result?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    prepared.withRunSession({
      status: hasFatalErrorPayload ? "error" : "ok",
      ...(hasFatalErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: result?.delivered,
      deliveryAttempted: result?.deliveryAttempted,
      ...telemetry,
    });

  const skipHeartbeatDelivery =
    prepared.deliveryRequested &&
    isHeartbeatOnlyResponse(payloads, resolveHeartbeatAckMaxChars(prepared.agentCfg));
  const skipMessagingToolDelivery =
    (prepared.input.deliveryContract ?? "cron-owned") === "shared" &&
    prepared.deliveryRequested &&
    finalRunResult.didSendViaMessagingTool === true &&
    (finalRunResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        accountId: prepared.resolvedDelivery.accountId,
        channel: prepared.resolvedDelivery.channel,
        to: prepared.resolvedDelivery.to,
      }),
    );
  const deliveryResult = await dispatchCronDelivery({
    abortReason: params.abortReason,
    abortSignal: prepared.input.abortSignal ?? prepared.input.signal,
    agentId: prepared.agentId,
    agentSessionKey: prepared.agentSessionKey,
    cfg: prepared.input.cfg,
    cfgWithAgentDefaults: prepared.cfgWithAgentDefaults,
    deliveryBestEffort: resolveCronDeliveryBestEffort(prepared.input.job),
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    deliveryRequested: prepared.deliveryRequested,
    deps: prepared.input.deps,
    isAborted: params.isAborted,
    job: prepared.input.job,
    outputText,
    resolvedDelivery: prepared.resolvedDelivery,
    runEndedAt: execution.runEndedAt,
    runSessionId: prepared.runSessionId,
    runStartedAt: execution.runStartedAt,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    summary,
    synthesizedText,
    telemetry,
    timeoutMs: prepared.timeoutMs,
    withRunSession: prepared.withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
    if (!hasFatalErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  ({ summary } = deliveryResult);
  ({ outputText } = deliveryResult);
  return resolveRunOutcome({
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
  });
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deliveryContract?: IsolatedDeliveryContract;
}): Promise<RunCronAgentTurnResult> {
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const prepared = await prepareCronRunContext({ input: params, isFastTestEnv });
  if (!prepared.ok) {
    return prepared.result;
  }

  try {
    const execution = await executeCronRun({
      abortReason,
      abortSignal,
      agentDir: prepared.context.agentDir,
      agentId: prepared.context.agentId,
      agentPayload: prepared.context.agentPayload,
      agentSessionKey: prepared.context.agentSessionKey,
      agentVerboseDefault: prepared.context.agentCfg?.verboseDefault,
      cfg: params.cfg,
      cfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,
      commandBody: prepared.context.commandBody,
      cronSession: prepared.context.cronSession,
      isAborted,
      job: params.job,
      lane: params.lane,
      liveSelection: prepared.context.liveSelection,
      persistSessionEntry: prepared.context.persistSessionEntry,
      resolvedDelivery: {
        accountId: prepared.context.resolvedDelivery.accountId,
        channel: prepared.context.resolvedDelivery.channel,
      },
      skillsSnapshot: prepared.context.skillsSnapshot,
      thinkLevel: prepared.context.thinkLevel,
      timeoutMs: prepared.context.timeoutMs,
      toolPolicy: prepared.context.toolPolicy,
      workspaceDir: prepared.context.workspaceDir,
    });
    if (isAborted()) {
      return prepared.context.withRunSession({ error: abortReason(), status: "error" });
    }
    return await finalizeCronRun({
      abortReason,
      execution,
      isAborted,
      prepared: prepared.context,
    });
  } catch (error) {
    return prepared.context.withRunSession({ error: String(error), status: "error" });
  }
}
