import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions/types.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import type { ApplyInlineDirectivesFastLaneParams } from "./directive-handling.params.js";
import { type InlineDirectives, isDirectiveOnly } from "./directive-handling.parse.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import type { createModelSelectionState } from "./model-selection.js";
import type { TypingController } from "./typing.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

let commandsStatusPromise: Promise<typeof import("./commands-status.runtime.js")> | null = null;
let directiveLevelsPromise: Promise<typeof import("./directive-handling.levels.js")> | null = null;
let directiveImplPromise: Promise<typeof import("./directive-handling.impl.js")> | null = null;
let directiveFastLanePromise: Promise<typeof import("./directive-handling.fast-lane.js")> | null =
  null;
let directivePersistPromise: Promise<
  typeof import("./directive-handling.persist.runtime.js")
> | null = null;

function loadCommandsStatus() {
  commandsStatusPromise ??= import("./commands-status.runtime.js");
  return commandsStatusPromise;
}

function loadDirectiveLevels() {
  directiveLevelsPromise ??= import("./directive-handling.levels.js");
  return directiveLevelsPromise;
}

function loadDirectiveImpl() {
  directiveImplPromise ??= import("./directive-handling.impl.js");
  return directiveImplPromise;
}

function loadDirectiveFastLane() {
  directiveFastLanePromise ??= import("./directive-handling.fast-lane.js");
  return directiveFastLanePromise;
}

function loadDirectivePersist() {
  directivePersistPromise ??= import("./directive-handling.persist.runtime.js");
  return directivePersistPromise;
}

export type ApplyDirectiveResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      provider: string;
      model: string;
      contextTokens: number;
      directiveAck?: ReplyPayload;
      perMessageQueueMode?: InlineDirectives["queueMode"];
      perMessageQueueOptions?: {
        debounceMs?: number;
        cap?: number;
        dropPolicy?: InlineDirectives["dropPolicy"];
      };
    };

export async function applyInlineDirectiveOverrides(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  agentEntry?: AgentEntry;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: SessionScope | undefined;
  isGroup: boolean;
  allowTextCommands: boolean;
  command: CommandContext;
  directives: InlineDirectives;
  messageProviderKey: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: { gate: string; key: string }[];
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ApplyInlineDirectivesFastLaneParams["aliasIndex"];
  provider: string;
  model: string;
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  resolvedElevatedLevel: ElevatedLevel;
  defaultActivation: () => "always" | "mention";
  contextTokens: number;
  effectiveModelDirective?: string;
  typing: TypingController;
}): Promise<ApplyDirectiveResult> {
  const {
    ctx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    agentEntry,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    isGroup,
    allowTextCommands,
    command,
    messageProviderKey,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultProvider,
    defaultModel,
    aliasIndex,
    modelState,
    initialModelLabel,
    formatModelSwitchEvent,
    resolvedElevatedLevel,
    defaultActivation,
    typing,
    effectiveModelDirective,
  } = params;
  let { directives } = params;
  let { provider, model } = params;
  let { contextTokens } = params;
  const directiveModelState = {
    allowedModelCatalog: modelState.allowedModelCatalog,
    allowedModelKeys: modelState.allowedModelKeys,
    resetModelOverride: modelState.resetModelOverride,
  };
  const createDirectiveHandlingBase = () => ({
    cfg,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    ...directiveModelState,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
  });

  let directiveAck: ReplyPayload | undefined;

  if (modelState.resetModelOverride) {
    enqueueSystemEvent(
      `Model override not allowed for this agent; reverted to ${initialModelLabel}.`,
      {
        contextKey: `model:reset:${initialModelLabel}`,
        sessionKey,
      },
    );
  }

  if (!command.isAuthorizedSender) {
    directives = clearInlineDirectives(directives.cleaned);
  }

  const hasAnyDirective =
    directives.hasThinkDirective ||
    directives.hasFastDirective ||
    directives.hasVerboseDirective ||
    directives.hasReasoningDirective ||
    directives.hasElevatedDirective ||
    directives.hasExecDirective ||
    directives.hasModelDirective ||
    directives.hasQueueDirective ||
    directives.hasStatusDirective;

  if (!hasAnyDirective && !modelState.resetModelOverride) {
    return {
      contextTokens,
      directives,
      kind: "continue",
      model,
      provider,
    };
  }

  if (
    isDirectiveOnly({
      agentId,
      cfg,
      cleanedBody: directives.cleaned,
      ctx,
      directives,
      isGroup,
    })
  ) {
    if (!command.isAuthorizedSender) {
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }
    const {
      currentThinkLevel: resolvedDefaultThinkLevel,
      currentFastMode,
      currentVerboseLevel,
      currentReasoningLevel,
      currentElevatedLevel,
    } = await (
      await loadDirectiveLevels()
    ).resolveCurrentDirectiveLevels({
      agentCfg,
      agentEntry,
      resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
      sessionEntry,
    });
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const directiveReply = await (
      await loadDirectiveImpl()
    ).handleDirectiveOnly({
      ...createDirectiveHandlingBase(),
      currentElevatedLevel,
      currentFastMode,
      currentReasoningLevel,
      currentThinkLevel,
      currentVerboseLevel,
      gatewayClientScopes: ctx.GatewayClientScopes,
      messageProvider: ctx.Provider,
      surface: ctx.Surface,
    });
    let statusReply: ReplyPayload | undefined;
    if (directives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender) {
      const { buildStatusReply } = await loadCommandsStatus();
      statusReply = await buildStatusReply({
        cfg,
        command,
        contextTokens,
        defaultGroupActivation: defaultActivation,
        isGroup,
        mediaDecisions: ctx.MediaUnderstandingDecisions,
        model,
        parentSessionKey: ctx.ParentSessionKey,
        provider,
        resolveDefaultThinkingLevel: async () => resolvedDefaultThinkLevel,
        resolvedElevatedLevel,
        resolvedReasoningLevel: currentReasoningLevel ?? "off",
        resolvedThinkLevel: resolvedDefaultThinkLevel,
        resolvedVerboseLevel: currentVerboseLevel ?? "off",
        sessionEntry,
        sessionKey,
        sessionScope,
      });
    }
    typing.cleanup();
    if (statusReply?.text && directiveReply?.text) {
      return {
        kind: "reply",
        reply: { text: `${directiveReply.text}\n${statusReply.text}` },
      };
    }
    return { kind: "reply", reply: statusReply ?? directiveReply };
  }

  if (hasAnyDirective && command.isAuthorizedSender) {
    const fastLane = await (
      await loadDirectiveFastLane()
    ).applyInlineDirectivesFastLane({
      directives,
      commandAuthorized: command.isAuthorizedSender,
      ctx,
      cfg,
      agentId,
      isGroup,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      messageProviderKey,
      defaultProvider,
      defaultModel,
      aliasIndex,
      ...directiveModelState,
      provider,
      model,
      initialModelLabel,
      formatModelSwitchEvent,
      agentCfg,
      modelState: {
        resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
        ...directiveModelState,
      },
    });
    ({ directiveAck } = fastLane);
    ({ provider } = fastLane);
    ({ model } = fastLane);
  }

  const persisted = await (
    await loadDirectivePersist()
  ).persistInlineDirectives({
    agentCfg,
    agentDir,
    aliasIndex,
    allowedModelKeys: modelState.allowedModelKeys,
    cfg,
    defaultModel,
    defaultProvider,
    directives,
    effectiveModelDirective,
    elevatedAllowed,
    elevatedEnabled,
    formatModelSwitchEvent,
    gatewayClientScopes: ctx.GatewayClientScopes,
    initialModelLabel,
    messageProvider: ctx.Provider,
    model,
    provider,
    sessionEntry,
    sessionKey,
    sessionStore,
    storePath,
    surface: ctx.Surface,
  });
  ({ provider } = persisted);
  ({ model } = persisted);
  ({ contextTokens } = persisted);

  const perMessageQueueMode =
    directives.hasQueueDirective && !directives.queueReset ? directives.queueMode : undefined;
  const perMessageQueueOptions =
    directives.hasQueueDirective && !directives.queueReset
      ? {
          cap: directives.cap,
          debounceMs: directives.debounceMs,
          dropPolicy: directives.dropPolicy,
        }
      : undefined;

  return {
    contextTokens,
    directiveAck,
    directives,
    kind: "continue",
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    provider,
  };
}
