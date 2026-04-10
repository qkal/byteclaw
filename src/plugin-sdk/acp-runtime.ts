// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import { getAcpSessionManager, __testing as managerTesting } from "../acp/control-plane/manager.js";
import { __testing as registryTesting } from "../acp/runtime/registry.js";
import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { getAcpSessionManager };
export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";
export { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
export type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";

let dispatchAcpRuntimePromise: Promise<
  typeof import("../auto-reply/reply/dispatch-acp.runtime.js")
> | null = null;

function loadDispatchAcpRuntime() {
  dispatchAcpRuntimePromise ??= import("../auto-reply/reply/dispatch-acp.runtime.js");
  return dispatchAcpRuntimePromise;
}

function hasExplicitCommandCandidate(ctx: PluginHookReplyDispatchEvent["ctx"]): boolean {
  const commandBody = normalizeOptionalString(ctx.CommandBody);
  if (commandBody) {
    return true;
  }

  const normalized = normalizeOptionalString(ctx.BodyForCommands);
  if (!normalized) {
    return false;
  }

  return normalized.startsWith("!") || normalized.startsWith("/");
}

export async function tryDispatchAcpReplyHook(
  event: PluginHookReplyDispatchEvent,
  ctx: PluginHookReplyDispatchContext,
): Promise<PluginHookReplyDispatchResult | void> {
  if (event.sendPolicy === "deny" && !hasExplicitCommandCandidate(event.ctx)) {
    return;
  }
  const runtime = await loadDispatchAcpRuntime();
  const bypassForCommand = await runtime.shouldBypassAcpDispatchForCommand(event.ctx, ctx.cfg);

  if (event.sendPolicy === "deny" && !bypassForCommand) {
    return;
  }

  const result = await runtime.tryDispatchAcpReply({
    abortSignal: ctx.abortSignal,
    bypassForCommand,
    cfg: ctx.cfg,
    ctx: event.ctx,
    dispatcher: ctx.dispatcher,
    inboundAudio: event.inboundAudio,
    markIdle: ctx.markIdle,
    onReplyStart: ctx.onReplyStart,
    originatingChannel: event.originatingChannel,
    originatingTo: event.originatingTo,
    recordProcessed: ctx.recordProcessed,
    runId: event.runId,
    sessionKey: event.sessionKey,
    sessionTtsAuto: event.sessionTtsAuto,
    shouldRouteToOriginating: event.shouldRouteToOriginating,
    shouldSendToolSummaries: event.shouldSendToolSummaries,
    suppressUserDelivery: event.suppressUserDelivery,
    ttsChannel: event.ttsChannel,
  });

  if (!result) {
    return;
  }

  return {
    counts: result.counts,
    handled: true,
    queuedFinal: result.queuedFinal,
  };
}

// Keep test helpers off the hot init path. Eagerly merging them here can
// Create a back-edge through the bundled ACP runtime chunk before the imported
// Testing bindings finish initialization.
export const __testing = new Proxy({} as typeof managerTesting & typeof registryTesting, {
  get(_target, prop, receiver) {
    if (Reflect.has(managerTesting, prop)) {
      return Reflect.get(managerTesting, prop, receiver);
    }
    return Reflect.get(registryTesting, prop, receiver);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }
    return undefined;
  },
  has(_target, prop) {
    return Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop);
  },
  ownKeys() {
    return [...new Set([...Reflect.ownKeys(managerTesting), ...Reflect.ownKeys(registryTesting)])];
  },
});
