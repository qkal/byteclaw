import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { type ResetCommandAction, emitResetCommandHooks } from "./commands-reset-hooks.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  mutableCtx.AcpDispatchTailAfterReset = true;
}
export async function maybeHandleResetCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult | null> {
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  if (!resetMatch) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const commandAction: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    const resetResult = await resetConfiguredBindingTargetInPlace({
      cfg: params.cfg,
      commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
      reason: commandAction,
      sessionKey: boundAcpKey,
    });
    if (!resetResult.ok) {
      logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
    }
    if (resetResult.ok) {
      params.command.resetHookTriggered = true;
      if (resetTail) {
        applyAcpResetTailContext(params.ctx, resetTail);
        if (params.rootCtx && params.rootCtx !== params.ctx) {
          applyAcpResetTailContext(params.rootCtx, resetTail);
        }
        return { shouldContinue: false };
      }
      return {
        reply: { text: "✅ ACP session reset in place." },
        shouldContinue: false,
      };
    }
    return {
      reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." },
      shouldContinue: false,
    };
  }

  await emitResetCommandHooks({
    action: commandAction,
    cfg: params.cfg,
    command: params.command,
    ctx: params.ctx,
    previousSessionEntry: params.previousSessionEntry,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  return null;
}
