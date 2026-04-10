import type { createDedupeCache} from "../infra/dedupe.js";
import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

export type RegisteredInteractiveHandler = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

interface InteractiveState {
  interactiveHandlers: Map<string, RegisteredInteractiveHandler>;
  callbackDedupe: ReturnType<typeof createDedupeCache>;
}

const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");

function getState() {
  return resolveGlobalSingleton<InteractiveState>(PLUGIN_INTERACTIVE_STATE_KEY, () => ({
    callbackDedupe: resolveGlobalDedupeCache(
      Symbol.for("openclaw.pluginInteractiveCallbackDedupe"),
      {
        maxSize: 4096,
        ttlMs: 5 * 60_000,
      },
    ),
    interactiveHandlers: new Map<string, RegisteredInteractiveHandler>(),
  }));
}

export function getPluginInteractiveHandlersState() {
  return getState().interactiveHandlers;
}

export function getPluginInteractiveCallbackDedupeState() {
  return getState().callbackDedupe;
}

export function clearPluginInteractiveHandlersState(): void {
  getPluginInteractiveHandlersState().clear();
  getPluginInteractiveCallbackDedupeState().clear();
}
