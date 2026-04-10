import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  normalizePluginInteractiveNamespace,
  resolvePluginInteractiveMatch,
  toPluginInteractiveRegistryKey,
  validatePluginInteractiveNamespace,
} from "./interactive-shared.js";
import {
  type RegisteredInteractiveHandler,
  clearPluginInteractiveHandlersState,
  getPluginInteractiveHandlersState,
} from "./interactive-state.js";
import type { PluginInteractiveHandlerRegistration } from "./types.js";

export interface InteractiveRegistrationResult {
  ok: boolean;
  error?: string;
}

export function resolvePluginInteractiveNamespaceMatch(
  channel: string,
  data: string,
): { registration: RegisteredInteractiveHandler; namespace: string; payload: string } | null {
  return resolvePluginInteractiveMatch({
    channel,
    data,
    interactiveHandlers: getPluginInteractiveHandlersState(),
  });
}

export function registerPluginInteractiveHandler(
  pluginId: string,
  registration: PluginInteractiveHandlerRegistration,
  opts?: { pluginName?: string; pluginRoot?: string },
): InteractiveRegistrationResult {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  const namespace = normalizePluginInteractiveNamespace(registration.namespace);
  const validationError = validatePluginInteractiveNamespace(namespace);
  if (validationError) {
    return { error: validationError, ok: false };
  }
  const key = toPluginInteractiveRegistryKey(registration.channel, namespace);
  const existing = interactiveHandlers.get(key);
  if (existing) {
    return {
      error: `Interactive handler namespace "${namespace}" already registered by plugin "${existing.pluginId}"`,
      ok: false,
    };
  }
  interactiveHandlers.set(key, {
    ...registration,
    channel: normalizeOptionalLowercaseString(registration.channel) ?? "",
    namespace,
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  return { ok: true };
}

export function clearPluginInteractiveHandlers(): void {
  clearPluginInteractiveHandlersState();
}

export function clearPluginInteractiveHandlersForPlugin(pluginId: string): void {
  const interactiveHandlers = getPluginInteractiveHandlersState();
  for (const [key, value] of interactiveHandlers.entries()) {
    if (value.pluginId === pluginId) {
      interactiveHandlers.delete(key);
    }
  }
}
