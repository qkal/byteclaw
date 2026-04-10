import type { OpenClawConfig } from "../../../config/config.js";
import type {
  ContextEnginePromptCacheInfo,
  ContextEngineRuntimeContext,
} from "../../../context-engine/types.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../../plugins/types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../../music-generation-task-status.js";
import { prependSystemPromptAdditionAfterCacheBoundary } from "../../system-prompt-cache-boundary.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../../video-generation-task-status.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import { log } from "../logger.js";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export interface PromptBuildHookRunner {
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
}

export async function resolvePromptBuildHookResult(params: {
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            messages: params.messages,
            prompt: params.prompt,
          },
          params.hookCtx,
        )
        .catch((error: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(error)}`);
          return undefined;
        })
    : undefined;
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              messages: params.messages,
              prompt: params.prompt,
            },
            params.hookCtx,
          )
          .catch((error: unknown) => {
            log.warn(`before_agent_start hook (legacy prompt build path) failed: ${String(error)}`);
            return undefined;
          })
      : undefined);
  return {
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
  };
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

export function shouldInjectHeartbeatPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
  isDefaultAgent: boolean;
  trigger?: EmbeddedRunAttemptParams["trigger"];
}): boolean {
  return (
    params.isDefaultAgent &&
    shouldInjectHeartbeatPromptForTrigger(params.trigger) &&
    Boolean(
      resolveHeartbeatPromptForSystemPrompt({
        agentId: params.agentId,
        config: params.config,
        defaultAgentId: params.defaultAgentId,
      }),
    )
  );
}

export function shouldWarnOnOrphanedUserRepair(
  trigger: EmbeddedRunAttemptParams["trigger"],
): boolean {
  return trigger === "user" || trigger === "manual";
}

export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    agentId: params.sessionAgentId,
    cfg: params.config,
  });
}

export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  return prependSystemPromptAdditionAfterCacheBoundary(params);
}

export function resolveAttemptPrependSystemContext(params: {
  sessionKey?: string;
  trigger?: EmbeddedRunAttemptParams["trigger"];
  hookPrependSystemContext?: string;
}): string | undefined {
  const activeMediaTaskPromptContexts =
    params.trigger === "user" || params.trigger === "manual"
      ? [
          buildActiveVideoGenerationTaskPromptContextForSession(params.sessionKey),
          buildActiveMusicGenerationTaskPromptContextForSession(params.sessionKey),
        ]
      : [];
  return joinPresentTextSegments([
    ...activeMediaTaskPromptContexts,
    params.hookPrependSystemContext,
  ]);
}

/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "currentChannelId"
    | "currentThreadTs"
    | "currentMessageId"
    | "config"
    | "skillsSnapshot"
    | "senderIsOwner"
    | "senderId"
    | "provider"
    | "modelId"
    | "thinkLevel"
    | "reasoningLevel"
    | "bashElevated"
    | "extraSystemPrompt"
    | "ownerNumbers"
    | "authProfileId"
  >;
  workspaceDir: string;
  agentDir: string;
  promptCache?: ContextEnginePromptCacheInfo;
}): ContextEngineRuntimeContext {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      agentAccountId: params.attempt.agentAccountId,
      agentDir: params.agentDir,
      authProfileId: params.attempt.authProfileId,
      bashElevated: params.attempt.bashElevated,
      config: params.attempt.config,
      currentChannelId: params.attempt.currentChannelId,
      currentMessageId: params.attempt.currentMessageId,
      currentThreadTs: params.attempt.currentThreadTs,
      extraSystemPrompt: params.attempt.extraSystemPrompt,
      messageChannel: params.attempt.messageChannel,
      messageProvider: params.attempt.messageProvider,
      modelId: params.attempt.modelId,
      ownerNumbers: params.attempt.ownerNumbers,
      provider: params.attempt.provider,
      reasoningLevel: params.attempt.reasoningLevel,
      senderId: params.attempt.senderId,
      senderIsOwner: params.attempt.senderIsOwner,
      sessionKey: params.attempt.sessionKey,
      skillsSnapshot: params.attempt.skillsSnapshot,
      thinkLevel: params.attempt.thinkLevel,
      workspaceDir: params.workspaceDir,
    }),
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
  };
}
