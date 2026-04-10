import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { CronJob } from "../types.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import {
  LiveSessionModelSwitchError,
  countActiveDescendantRuns,
  getCliSessionId,
  isCliProvider,
  listDescendantRunsForRequester,
  logWarn,
  normalizeVerboseLevel,
  registerAgentRunContext,
  resolveBootstrapWarningSignaturesSeen,
  resolveFastModeState,
  resolveNestedAgentLane,
  resolveSessionTranscriptPath,
  runCliAgent,
  runEmbeddedPiAgent,
  runWithModelFallback,
} from "./run-execution.runtime.js";
import { resolveCronFallbacksOverride } from "./run-fallback-policy.js";
import type {
  CronLiveSelection,
  MutableCronSession,
  PersistCronSessionEntry,
} from "./run-session-state.js";
import { syncCronSessionLiveSelection } from "./run-session-state.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

type AgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
type CronPromptRunResult = Awaited<ReturnType<typeof runCliAgent>>;

export interface CronExecutionResult {
  runResult: CronPromptRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  runStartedAt: number;
  runEndedAt: number;
  liveSelection: CronLiveSelection;
}

export function createCronPromptExecutor(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentDir: string;
  agentSessionKey: string;
  workspaceDir: string;
  lane?: string;
  resolvedVerboseLevel: VerboseLevel;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
  messageChannel: string | undefined;
  resolvedDelivery: { accountId?: string };
  toolPolicy: {
    requireExplicitMessageTarget: boolean;
    disableMessageTool: boolean;
  };
  skillsSnapshot: SkillSnapshot;
  agentPayload: AgentTurnPayload;
  liveSelection: CronLiveSelection;
  cronSession: MutableCronSession;
  abortSignal?: AbortSignal;
  abortReason: () => string;
}) {
  const sessionFile = resolveSessionTranscriptPath(
    params.cronSession.sessionEntry.sessionId,
    params.agentId,
  );
  const cronFallbacksOverride = resolveCronFallbacksOverride({
    agentId: params.agentId,
    cfg: params.cfg,
    job: params.job,
  });
  let runResult: CronPromptRunResult | undefined;
  let fallbackProvider = params.liveSelection.provider;
  let fallbackModel = params.liveSelection.model;
  let runEndedAt = Date.now();
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.cronSession.sessionEntry.systemPromptReport,
  );

  const runPrompt = async (promptText: string) => {
    const fallbackResult = await runWithModelFallback({
      agentDir: params.agentDir,
      cfg: params.cfgWithAgentDefaults,
      fallbacksOverride: cronFallbacksOverride,
      model: params.liveSelection.model,
      provider: params.liveSelection.provider,
      run: async (providerOverride, modelOverride, runOptions) => {
        if (params.abortSignal?.aborted) {
          throw new Error(params.abortReason());
        }
        const bootstrapPromptWarningSignature =
          bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
        if (isCliProvider(providerOverride, params.cfgWithAgentDefaults)) {
          const cliSessionId = params.cronSession.isNewSession
            ? undefined
            : getCliSessionId(params.cronSession.sessionEntry, providerOverride);
          const result = await runCliAgent({
            agentId: params.agentId,
            bootstrapPromptWarningSignature,
            bootstrapPromptWarningSignaturesSeen,
            cliSessionId,
            config: params.cfgWithAgentDefaults,
            model: modelOverride,
            prompt: promptText,
            provider: providerOverride,
            runId: params.cronSession.sessionEntry.sessionId,
            sessionFile,
            sessionId: params.cronSession.sessionEntry.sessionId,
            sessionKey: params.agentSessionKey,
            skillsSnapshot: params.skillsSnapshot,
            thinkLevel: params.thinkLevel,
            timeoutMs: params.timeoutMs,
            workspaceDir: params.workspaceDir,
          });
          bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        }
        const result = await runEmbeddedPiAgent({
          abortSignal: params.abortSignal,
          agentAccountId: params.resolvedDelivery.accountId,
          agentDir: params.agentDir,
          agentId: params.agentId,
          allowGatewaySubagentBinding: true,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          authProfileId: params.liveSelection.authProfileId,
          authProfileIdSource: params.liveSelection.authProfileId
            ? params.liveSelection.authProfileIdSource
            : undefined,
          bootstrapContextMode: params.agentPayload?.lightContext ? "lightweight" : undefined,
          bootstrapContextRunKind: "cron",
          bootstrapPromptWarningSignature,
          bootstrapPromptWarningSignaturesSeen,
          config: params.cfgWithAgentDefaults,
          disableMessageTool: params.toolPolicy.disableMessageTool,
          fastMode: resolveFastModeState({
            cfg: params.cfgWithAgentDefaults,
            provider: providerOverride,
            model: modelOverride,
            agentId: params.agentId,
            sessionEntry: params.cronSession.sessionEntry,
          }).enabled,
          lane: resolveNestedAgentLane(params.lane),
          messageChannel: params.messageChannel,
          model: modelOverride,
          prompt: promptText,
          provider: providerOverride,
          requireExplicitMessageTarget: params.toolPolicy.requireExplicitMessageTarget,
          runId: params.cronSession.sessionEntry.sessionId,
          senderIsOwner: true,
          sessionFile,
          sessionId: params.cronSession.sessionEntry.sessionId,
          sessionKey: params.agentSessionKey,
          skillsSnapshot: params.skillsSnapshot,
          thinkLevel: params.thinkLevel,
          timeoutMs: params.timeoutMs,
          toolsAllow: params.agentPayload?.toolsAllow,
          trigger: "cron",
          verboseLevel: params.resolvedVerboseLevel,
          workspaceDir: params.workspaceDir,
        });
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
      runId: params.cronSession.sessionEntry.sessionId,
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
    params.liveSelection.provider = fallbackResult.provider;
    params.liveSelection.model = fallbackResult.model;
    runEndedAt = Date.now();
  };

  return {
    getState: () => ({
      fallbackModel,
      fallbackProvider,
      liveSelection: params.liveSelection,
      runEndedAt,
      runResult,
    }),
    runPrompt,
  };
}

export async function executeCronRun(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentDir: string;
  agentSessionKey: string;
  workspaceDir: string;
  lane?: string;
  resolvedDelivery: {
    channel?: string;
    accountId?: string;
  };
  toolPolicy: {
    requireExplicitMessageTarget: boolean;
    disableMessageTool: boolean;
  };
  skillsSnapshot: SkillSnapshot;
  agentPayload: AgentTurnPayload;
  agentVerboseDefault: AgentDefaultsConfig["verboseDefault"];
  liveSelection: CronLiveSelection;
  cronSession: MutableCronSession;
  commandBody: string;
  persistSessionEntry: PersistCronSessionEntry;
  abortSignal?: AbortSignal;
  abortReason: () => string;
  isAborted: () => boolean;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
  runStartedAt?: number;
}): Promise<CronExecutionResult> {
  const resolvedVerboseLevel: VerboseLevel =
    normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ??
    normalizeVerboseLevel(params.agentVerboseDefault) ??
    "off";
  registerAgentRunContext(params.cronSession.sessionEntry.sessionId, {
    sessionKey: params.agentSessionKey,
    verboseLevel: resolvedVerboseLevel,
  });
  const executor = createCronPromptExecutor({
    abortReason: params.abortReason,
    abortSignal: params.abortSignal,
    agentDir: params.agentDir,
    agentId: params.agentId,
    agentPayload: params.agentPayload,
    agentSessionKey: params.agentSessionKey,
    cfg: params.cfg,
    cfgWithAgentDefaults: params.cfgWithAgentDefaults,
    cronSession: params.cronSession,
    job: params.job,
    lane: params.lane,
    liveSelection: params.liveSelection,
    messageChannel: params.resolvedDelivery.channel,
    resolvedDelivery: params.resolvedDelivery,
    resolvedVerboseLevel,
    skillsSnapshot: params.skillsSnapshot,
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    toolPolicy: params.toolPolicy,
    workspaceDir: params.workspaceDir,
  });

  const runStartedAt = params.runStartedAt ?? Date.now();
  const MAX_MODEL_SWITCH_RETRIES = 2;
  let modelSwitchRetries = 0;
  while (true) {
    try {
      await executor.runPrompt(params.commandBody);
      break;
    } catch (error) {
      if (!(error instanceof LiveSessionModelSwitchError)) {
        throw error;
      }
      modelSwitchRetries += 1;
      if (modelSwitchRetries > MAX_MODEL_SWITCH_RETRIES) {
        logWarn(
          `[cron:${params.job.id}] LiveSessionModelSwitchError retry limit reached (${MAX_MODEL_SWITCH_RETRIES}); aborting`,
        );
        throw error;
      }
      params.liveSelection.provider = error.provider;
      params.liveSelection.model = error.model;
      params.liveSelection.authProfileId = error.authProfileId;
      params.liveSelection.authProfileIdSource = error.authProfileId
        ? error.authProfileIdSource
        : undefined;
      syncCronSessionLiveSelection({
        entry: params.cronSession.sessionEntry,
        liveSelection: params.liveSelection,
      });
      try {
        await params.persistSessionEntry();
      } catch (error) {
        logWarn(
          `[cron:${params.job.id}] Failed to persist model switch session entry: ${String(error)}`,
        );
      }
      continue;
    }
  }

  let { runResult, fallbackProvider, fallbackModel, runEndedAt } = executor.getState();
  if (!runResult) {
    throw new Error("cron isolated run returned no result");
  }

  if (!params.isAborted()) {
    const interimPayloads = runResult.payloads ?? [];
    const {
      deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent,
      outputText: interimOutputText,
    } = resolveCronPayloadOutcome({
      finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
      payloads: interimPayloads,
      preferFinalAssistantVisibleText: params.resolvedDelivery.channel === "telegram",
      runLevelError: runResult.meta?.error,
    });
    const interimText = interimOutputText?.trim() ?? "";
    const shouldRetryInterimAck =
      !runResult.meta?.error &&
      !runResult.didSendViaMessagingTool &&
      !interimPayloadHasStructuredContent &&
      !interimPayloads.some((payload) => payload?.isError === true) &&
      !listDescendantRunsForRequester(params.agentSessionKey).some((entry) => {
        const descendantStartedAt =
          typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
        return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
      }) &&
      countActiveDescendantRuns(params.agentSessionKey) === 0 &&
      isLikelyInterimCronMessage(interimText);

    if (shouldRetryInterimAck) {
      const continuationPrompt = [
        "Your previous response was only an acknowledgement and did not complete this cron task.",
        "Complete the original task now.",
        "Do not send a status update like 'on it'.",
        "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
      ].join(" ");
      await executor.runPrompt(continuationPrompt);
      ({ runResult, fallbackProvider, fallbackModel, runEndedAt } = executor.getState());
    }
  }

  if (!runResult) {
    throw new Error("cron isolated run returned no result");
  }
  return {
    fallbackModel,
    fallbackProvider,
    liveSelection: params.liveSelection,
    runEndedAt,
    runResult,
    runStartedAt,
  };
}
