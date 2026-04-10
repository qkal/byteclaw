import type { loadConfig } from "../config/config.js";
import type { callGateway } from "../gateway/call.js";

interface DeliveryRuntimeMockOptions {
  callGateway: (request: unknown) => Promise<unknown>;
  loadConfig: () => ReturnType<typeof loadConfig>;
  loadSessionStore: (storePath: string) => unknown;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
  resolveMainSessionKey: (cfg: unknown) => string;
  resolveStorePath: (store: unknown, options: unknown) => string;
  isEmbeddedPiRunActive: (sessionId: string) => boolean;
  queueEmbeddedPiMessage: (sessionId: string, text: string) => boolean;
  hasHooks?: () => boolean;
}

function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
}) {
  return {
    accountId: params.accountId,
    channel: params.channel,
    deliver: Boolean(params.channel && params.to),
    threadId: params.threadId,
    to: params.to,
  };
}

function resolveQueueSettings(params: {
  cfg?: {
    messages?: {
      queue?: {
        byChannel?: Record<string, string>;
      };
    };
  };
  channel?: string;
}) {
  return {
    mode: (params.channel && params.cfg?.messages?.queue?.byChannel?.[params.channel]) ?? "none",
  };
}

export function createSubagentAnnounceDeliveryRuntimeMock(options: DeliveryRuntimeMockOptions) {
  return {
    callGateway: (async <T = Record<string, unknown>>(request: Parameters<typeof callGateway>[0]) =>
      (await options.callGateway(request)) as T) as typeof callGateway,
    createBoundDeliveryRouter: () => ({
      resolveDestination: () => ({ mode: "none" }),
    }),
    getGlobalHookRunner: () => ({ hasHooks: () => options.hasHooks?.() ?? false }),
    isEmbeddedPiRunActive: options.isEmbeddedPiRunActive,
    loadConfig: options.loadConfig,
    loadSessionStore: options.loadSessionStore,
    queueEmbeddedPiMessage: options.queueEmbeddedPiMessage,
    resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
    resolveConversationIdFromTargets: () => "",
    resolveExternalBestEffortDeliveryTarget,
    resolveMainSessionKey: options.resolveMainSessionKey,
    resolveQueueSettings,
    resolveStorePath: options.resolveStorePath,
  };
}
