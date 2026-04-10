import {
  type InteractiveRegistrationResult,
  resolvePluginInteractiveNamespaceMatch,
} from "./interactive-registry.js";
import {
  type RegisteredInteractiveHandler,
  getPluginInteractiveCallbackDedupeState,
} from "./interactive-state.js";

type InteractiveDispatchResult =
  | { matched: false; handled: false; duplicate: false }
  | { matched: true; handled: boolean; duplicate: boolean };

interface PluginInteractiveDispatchRegistration {
  channel: string;
  namespace: string;
}

export interface PluginInteractiveMatch<
  TRegistration extends PluginInteractiveDispatchRegistration,
> {
  registration: RegisteredInteractiveHandler & TRegistration;
  namespace: string;
  payload: string;
}

export {
  clearPluginInteractiveHandlers,
  clearPluginInteractiveHandlersForPlugin,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";
export type { InteractiveRegistrationResult } from "./interactive-registry.js";

export async function dispatchPluginInteractiveHandler<
  TRegistration extends PluginInteractiveDispatchRegistration,
>(params: {
  channel: TRegistration["channel"];
  data: string;
  dedupeId?: string;
  onMatched?: () => Promise<void> | void;
  invoke: (
    match: PluginInteractiveMatch<TRegistration>,
  ) => Promise<{ handled?: boolean } | void> | { handled?: boolean } | void;
}): Promise<InteractiveDispatchResult> {
  const callbackDedupe = getPluginInteractiveCallbackDedupeState();
  const match = resolvePluginInteractiveNamespaceMatch(params.channel, params.data);
  if (!match) {
    return { duplicate: false, handled: false, matched: false };
  }

  const dedupeKey = params.dedupeId?.trim();
  if (dedupeKey && callbackDedupe.peek(dedupeKey)) {
    return { duplicate: true, handled: true, matched: true };
  }

  await params.onMatched?.();

  const resolved = await params.invoke(match as PluginInteractiveMatch<TRegistration>);
  if (dedupeKey) {
    callbackDedupe.check(dedupeKey);
  }

  return {
    duplicate: false,
    handled: resolved?.handled ?? true,
    matched: true,
  };
}
