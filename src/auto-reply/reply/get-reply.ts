import fs from "node:fs/promises";
import {
  resolveAgentDir,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import type { MsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  buildFastReplyCommandContext,
  initFastReplySessionState,
  resolveGetReplyConfig,
  shouldHandleFastReplyTextCommands,
  shouldUseReplyFastDirectiveExecution,
  shouldUseReplyFastTestBootstrap,
  shouldUseReplyFastTestRuntime,
} from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createFastTestModelSelectionState } from "./model-selection.js";
import { initSessionState } from "./session.js";
import { createTypingController } from "./typing.js";

type ResetCommandAction = "new" | "reset";

let sessionResetModelRuntimePromise: Promise<
  typeof import("./session-reset-model.runtime.js")
> | null = null;
let stageSandboxMediaRuntimePromise: Promise<
  typeof import("./stage-sandbox-media.runtime.js")
> | null = null;

function loadSessionResetModelRuntime() {
  sessionResetModelRuntimePromise ??= import("./session-reset-model.runtime.js");
  return sessionResetModelRuntimePromise;
}

function loadStageSandboxMediaRuntime() {
  stageSandboxMediaRuntimePromise ??= import("./stage-sandbox-media.runtime.js");
  return stageSandboxMediaRuntimePromise;
}

let hookRunnerGlobalPromise: Promise<typeof import("../../plugins/hook-runner-global.js")> | null =
  null;
let originRoutingPromise: Promise<typeof import("./origin-routing.js")> | null = null;

function loadHookRunnerGlobal() {
  hookRunnerGlobalPromise ??= import("../../plugins/hook-runner-global.js");
  return hookRunnerGlobalPromise;
}

function loadOriginRouting() {
  originRoutingPromise ??= import("./origin-routing.js");
  return originRoutingPromise;
}

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return normalizeStringEntries(list);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function hasInboundMedia(ctx: MsgContext): boolean {
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

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel: { provider: string; model: string };
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  const { applyMediaUnderstanding } = await import("../../media-understanding/apply.runtime.js");
  await applyMediaUnderstanding(params);
  return true;
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  const { applyLinkUnderstanding } = await import("../../link-understanding/apply.runtime.js");
  await applyLinkUnderstanding(params);
  return true;
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = resolveGetReplyConfig({
    configOverride,
    isFastTestEnv,
    loadConfig,
  });
  const useFastTestBootstrap = shouldUseReplyFastTestBootstrap({
    configOverride,
    isFastTestEnv,
  });
  const useFastTestRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv,
  });
  const targetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: agentSessionKey,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    agentId,
    cfg,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // Fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      normalizeOptionalString(opts.heartbeatModelOverride) ??
      normalizeOptionalString(agentCfg?.heartbeat?.model) ??
      "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          aliasIndex,
          defaultProvider,
          raw: heartbeatRaw,
        })
      : null;
    if (heartbeatRef) {
      ({ provider } = heartbeatRef.ref);
      ({ model } = heartbeatRef.ref);
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = useFastTestBootstrap
    ? (await fs.mkdir(workspaceDirRaw, { recursive: true }), { dir: workspaceDirRaw })
    : await ensureAgentWorkspace({
        dir: workspaceDirRaw,
        ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
      });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    log: defaultRuntime.log,
    onCleanup: opts?.onTypingCleanup,
    onReplyStart: opts?.onReplyStart,
    silentToken: SILENT_REPLY_TOKEN,
    typingIntervalSeconds,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);

  if (!isFastTestEnv) {
    await applyMediaUnderstandingIfNeeded({
      activeModel: { model, provider },
      agentDir,
      cfg,
      ctx: finalized,
    });
    await applyLinkUnderstandingIfNeeded({
      cfg,
      ctx: finalized,
    });
  }
  emitPreAgentMessageHooks({
    cfg,
    ctx: finalized,
    isFastTestEnv,
  });

  const commandAuthorized = finalized.CommandAuthorized;
  const sessionState = useFastTestBootstrap
    ? initFastReplySessionState({
        agentId,
        cfg,
        commandAuthorized,
        ctx: finalized,
        workspaceDir,
      })
    : await initSessionState({
        cfg,
        commandAuthorized,
        ctx: finalized,
      });
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;
  if (resetTriggered && normalizeOptionalString(bodyStripped)) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    await applyResetModelOverride({
      agentId,
      aliasIndex,
      bodyStripped,
      cfg,
      ctx: finalized,
      defaultModel,
      defaultProvider,
      resetTriggered,
      sessionCtx,
      sessionEntry,
      sessionKey,
      sessionStore,
      storePath,
    });
  }

  const channelModelOverride = resolveChannelModelOverride({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromString({
      aliasIndex,
      defaultProvider,
      raw: channelModelOverride.model,
    });
    if (resolved) {
      ({ provider } = resolved.ref);
      ({ model } = resolved.ref);
    }
  }

  if (
    shouldUseReplyFastDirectiveExecution({
      isFastTestBootstrap: useFastTestRuntime,
      isGroup,
      isHeartbeat: opts?.isHeartbeat === true,
      resetTriggered,
      triggerBodyNormalized,
    })
  ) {
    const fastCommand = buildFastReplyCommandContext({
      agentId,
      cfg,
      commandAuthorized,
      ctx,
      isGroup,
      sessionKey,
      triggerBodyNormalized,
    });
    return runPreparedReply({
      abortedLastRun,
      agentCfg,
      agentDir,
      agentId,
      allowTextCommands: shouldHandleFastReplyTextCommands({
        cfg,
        commandSource: finalized.CommandSource,
      }),
      blockReplyChunking: undefined,
      blockStreamingEnabled: false,
      cfg,
      command: fastCommand,
      commandAuthorized,
      commandSource: finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
      ctx,
      defaultActivation: "always",
      defaultModel,
      defaultProvider,
      directives: clearInlineDirectives(
        finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
      ),
      elevatedAllowed: false,
      elevatedEnabled: false,
      execOverrides: undefined,
      isNewSession,
      model,
      modelState: createFastTestModelSelectionState({
        agentCfg,
        model,
        provider,
      }),
      opts: resolvedOpts,
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
      provider,
      resetTriggered,
      resolvedBlockStreamingBreak: "text_end",
      resolvedElevatedLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: normalizeVerboseLevel(agentCfg?.verboseDefault),
      sessionCfg,
      sessionCtx,
      sessionEntry,
      sessionId,
      sessionKey,
      sessionStore,
      storePath,
      systemSent,
      timeoutMs,
      typing,
      workspaceDir,
    });
  }

  const directiveResult = await resolveReplyDirectives({
    agentCfg,
    agentDir,
    agentId,
    aliasIndex,
    cfg,
    commandAuthorized,
    ctx: finalized,
    defaultModel,
    defaultProvider,
    groupResolution,
    hasResolvedHeartbeatModelOverride,
    isGroup,
    model,
    opts: resolvedOpts,
    provider,
    sessionCtx,
    sessionEntry,
    sessionKey,
    sessionScope,
    sessionStore,
    skillFilter: mergedSkillFilter,
    storePath,
    triggerBodyNormalized,
    typing,
    workspaceDir,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await import("./commands-core.runtime.js");
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      cfg,
      command,
      ctx,
      previousSessionEntry,
      sessionEntry,
      sessionKey,
      workspaceDir,
    });
  };

  const inlineActionResult = await handleInlineActions({
    abortedLastRun,
    agentDir,
    agentId,
    allowTextCommands,
    blockReplyChunking,
    cfg,
    cleanedBody,
    command,
    contextTokens,
    ctx,
    defaultActivation: () => defaultActivation,
    directiveAck,
    directives,
    elevatedAllowed,
    elevatedEnabled,
    elevatedFailures,
    inlineStatusRequested,
    isGroup,
    model,
    opts: resolvedOpts,
    previousSessionEntry,
    provider,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    resolvedBlockStreamingBreak,
    resolvedElevatedLevel,
    resolvedReasoningLevel,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    sessionCtx,
    sessionEntry,
    sessionKey,
    sessionScope,
    sessionStore,
    skillCommands,
    skillFilter: mergedSkillFilter,
    storePath,
    typing,
    workspaceDir,
  });
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  ({ directives } = inlineActionResult);
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  // Allow plugins to intercept and return a synthetic reply before the LLM runs.
  if (!useFastTestBootstrap) {
    const { getGlobalHookRunner } = await loadHookRunnerGlobal();
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_agent_reply")) {
      const { resolveOriginMessageProvider } = await loadOriginRouting();
      const hookMessageProvider = resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider,
      });
      const hookResult = await hookRunner.runBeforeAgentReply(
        { cleanedBody },
        {
          agentId,
          channelId: hookMessageProvider,
          messageProvider: hookMessageProvider,
          sessionId,
          sessionKey: agentSessionKey,
          trigger: opts?.isHeartbeat ? "heartbeat" : "user",
          workspaceDir,
        },
      );
      if (hookResult?.handled) {
        return hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
      }
    }
  }

  if (!useFastTestBootstrap && sessionKey && hasInboundMedia(ctx)) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    await stageSandboxMedia({
      cfg,
      ctx,
      sessionCtx,
      sessionKey,
      workspaceDir,
    });
  }

  return runPreparedReply({
    abortedLastRun,
    agentCfg,
    agentDir,
    agentId,
    allowTextCommands,
    blockReplyChunking,
    blockStreamingEnabled,
    cfg,
    command,
    commandAuthorized,
    commandSource,
    ctx,
    defaultActivation,
    defaultModel,
    defaultProvider,
    directives,
    elevatedAllowed,
    elevatedEnabled,
    execOverrides,
    isNewSession,
    model,
    modelState,
    opts: resolvedOpts,
    perMessageQueueMode,
    perMessageQueueOptions,
    provider,
    resetTriggered,
    resolvedBlockStreamingBreak,
    resolvedElevatedLevel,
    resolvedReasoningLevel,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    sessionCfg,
    sessionCtx,
    sessionEntry,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    systemSent,
    timeoutMs,
    typing,
    workspaceDir,
  });
}
