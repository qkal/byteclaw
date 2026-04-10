import type { ReplyPayload } from "../types.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { resolveCurrentDirectiveLevels } from "./directive-handling.levels.js";
import type { ApplyInlineDirectivesFastLaneParams } from "./directive-handling.params.js";
import { isDirectiveOnly } from "./directive-handling.parse.js";

export async function applyInlineDirectivesFastLane(
  params: ApplyInlineDirectivesFastLaneParams,
): Promise<{ directiveAck?: ReplyPayload; provider: string; model: string }> {
  const {
    directives,
    commandAuthorized,
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
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    formatModelSwitchEvent,
    modelState,
  } = params;

  let { provider, model } = params;
  if (
    !commandAuthorized ||
    isDirectiveOnly({
      agentId,
      cfg,
      cleanedBody: directives.cleaned,
      ctx,
      directives,
      isGroup,
    })
  ) {
    return { directiveAck: undefined, model, provider };
  }

  const {agentCfg} = params;
  const {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = await resolveCurrentDirectiveLevels({
    agentCfg,
    resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
    sessionEntry,
  });

  const directiveAck = await handleDirectiveOnly({
    aliasIndex,
    allowedModelCatalog,
    allowedModelKeys,
    cfg,
    currentElevatedLevel,
    currentFastMode,
    currentReasoningLevel,
    currentThinkLevel,
    currentVerboseLevel,
    defaultModel,
    defaultProvider,
    directives,
    elevatedAllowed,
    elevatedEnabled,
    elevatedFailures,
    formatModelSwitchEvent,
    gatewayClientScopes: ctx.GatewayClientScopes,
    initialModelLabel: params.initialModelLabel,
    messageProviderKey,
    model,
    provider,
    resetModelOverride,
    sessionEntry,
    sessionKey,
    sessionStore,
    storePath,
    surface: ctx.Surface,
  });

  if (sessionEntry?.providerOverride) {
    provider = sessionEntry.providerOverride;
  }
  if (sessionEntry?.modelOverride) {
    model = sessionEntry.modelOverride;
  }

  return { directiveAck, model, provider };
}
