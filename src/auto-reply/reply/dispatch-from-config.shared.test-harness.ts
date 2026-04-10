import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type {
  PluginHookBeforeDispatchResult,
  PluginHookReplyDispatchResult,
  PluginTargetedInboundClaimOutcome,
} from "../../plugins/hooks.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

interface AbortResult {
  handled: boolean;
  aborted: boolean;
  stoppedSubagents?: number;
}

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ messageId: "mock", ok: true })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    aborted: false,
    handled: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageProcessed: vi.fn(),
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  registry: {
    plugins: [] as { id: string; status: "loaded" | "disabled" | "error" }[],
  },
  runner: {
    hasHooks: vi.fn<(hookName?: string) => boolean>(() => false),
    runBeforeDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookBeforeDispatchResult | undefined>
    >(async () => undefined),
    runInboundClaim: vi.fn(async () => undefined),
    runInboundClaimForPlugin: vi.fn(async () => undefined),
    runInboundClaimForPluginOutcome: vi.fn<() => Promise<PluginTargetedInboundClaimOutcome>>(
      async () => ({ status: "no_handler" as const }),
    ),
    runMessageReceived: vi.fn(async () => {}),
    runReplyDispatch: vi.fn<
      (_event: unknown, _ctx: unknown) => Promise<PluginHookReplyDispatchResult | undefined>
    >(async () => undefined),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const acpMocks = vi.hoisted(() => ({
  getAcpRuntimeBackend: vi.fn<() => unknown>(() => null),
  listAcpSessionEntries: vi.fn(async () => []),
  readAcpSessionEntry: vi.fn<(params: { sessionKey: string; cfg?: OpenClawConfig }) => unknown>(
    () => null,
  ),
  requireAcpRuntimeBackend: vi.fn<() => unknown>(),
  upsertAcpSessionMeta: vi.fn<
    (params: {
      sessionKey: string;
      cfg?: OpenClawConfig;
      mutate: (
        current: Record<string, unknown> | undefined,
        entry: { acp?: Record<string, unknown> } | undefined,
      ) => Record<string, unknown> | null | undefined;
    }) => Promise<unknown>
  >(async () => null),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(targetSessionKey: string) => SessionBindingRecord[]>(() => []),
  resolveByConversation: vi.fn<
    (ref: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    }) => SessionBindingRecord | null
  >(() => null),
  touch: vi.fn(),
}));
const pluginConversationBindingMocks = vi.hoisted(() => ({
  shownFallbackNoticeBindingIds: new Set<string>(),
}));
const sessionStoreMocks = vi.hoisted(() => ({
  currentEntry: undefined as Record<string, unknown> | undefined,
  loadSessionStore: vi.fn(() => ({})),
  resolveSessionStoreEntry: vi.fn(() => ({ existing: sessionStoreMocks.currentEntry })),
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
}));
const acpManagerRuntimeMocks = vi.hoisted(() => ({
  getAcpSessionManager: vi.fn(),
}));
const agentEventMocks = vi.hoisted(() => ({
  emitAgentEvent: vi.fn(),
  onAgentEvent: vi.fn<(listener: unknown) => () => void>(() => () => {}),
}));
const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: ReplyPayload };
    return params.payload;
  }),
  normalizeTtsAutoMode: vi.fn((value: unknown) => (typeof value === "string" ? value : undefined)),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));
const threadInfoMocks = vi.hoisted(() => ({
  parseSessionThreadInfo: vi.fn<
    (sessionKey: string | undefined) => {
      baseSessionKey: string | undefined;
      threadId: string | undefined;
    }
  >(),
}));

export {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  mocks,
  pluginConversationBindingMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  threadInfoMocks,
  ttsMocks,
};

export function parseGenericThreadSessionInfo(sessionKey: string | undefined) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const threadMarker = ":thread:";
  const topicMarker = ":topic:";
  const marker = trimmed.includes(threadMarker)
    ? threadMarker
    : trimmed.includes(topicMarker)
      ? topicMarker
      : undefined;
  if (!marker) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const index = trimmed.lastIndexOf(marker);
  if (index === -1) {
    return { baseSessionKey: trimmed, threadId: undefined };
  }
  const baseSessionKey = trimmed.slice(0, index).trim() || undefined;
  const threadId = trimmed.slice(index + marker.length).trim() || undefined;
  return { baseSessionKey, threadId };
}

vi.mock("./route-reply.runtime.js", () => ({
  isRoutableChannel: () => true,
  routeReply: mocks.routeReply,
}));
vi.mock("./route-reply.js", () => ({
  isRoutableChannel: () => true,
  routeReply: mocks.routeReply,
}));
vi.mock("./abort.runtime.js", () => ({
  formatAbortReplyText: () => "⚙️ Agent was aborted.",
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));
vi.mock("../../config/sessions/thread-info.js", () => ({
  parseSessionThreadInfo: (sessionKey: string | undefined) =>
    threadInfoMocks.parseSessionThreadInfo(sessionKey),
}));
vi.mock("./dispatch-from-config.runtime.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  loadSessionStore: sessionStoreMocks.loadSessionStore,
  resolveSessionStoreEntry: sessionStoreMocks.resolveSessionStoreEntry,
  resolveStorePath: sessionStoreMocks.resolveStorePath,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
  getGlobalPluginRegistry: () => hookMocks.registry,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  upsertAcpSessionMeta: acpMocks.upsertAcpSessionMeta,
}));
vi.mock("../../acp/runtime/registry.js", () => ({
  getAcpRuntimeBackend: acpMocks.getAcpRuntimeBackend,
  requireAcpRuntimeBackend: acpMocks.requireAcpRuntimeBackend,
}));
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(async () => {
      throw new Error("bind not mocked");
    }),
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["current", "child"] as const,
      unbindSupported: true,
    })),
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    resolveByConversation: sessionBindingMocks.resolveByConversation,
    touch: sessionBindingMocks.touch,
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (params: unknown) => agentEventMocks.emitAgentEvent(params),
  onAgentEvent: (listener: unknown) => agentEventMocks.onAgentEvent(listener),
}));
vi.mock("../../plugins/conversation-binding.js", () => ({
  buildPluginBindingDeclinedText: () => "Plugin binding request was declined.",
  buildPluginBindingErrorText: () => "Plugin binding request failed.",
  buildPluginBindingUnavailableText: (binding: { pluginName?: string; pluginId: string }) =>
    `${binding.pluginName ?? binding.pluginId} is not currently loaded.`,
  hasShownPluginBindingFallbackNotice: (bindingId: string) =>
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.has(bindingId),
  isPluginOwnedSessionBindingRecord: (
    record: SessionBindingRecord | null | undefined,
  ): record is SessionBindingRecord =>
    record?.metadata != null &&
    typeof record.metadata === "object" &&
    (record.metadata as { pluginBindingOwner?: string }).pluginBindingOwner === "plugin",
  markPluginBindingFallbackNoticeShown: (bindingId: string) => {
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.add(bindingId);
  },
  toPluginConversationBinding: (record: SessionBindingRecord) => ({
    accountId: record.conversation.accountId,
    bindingId: record.bindingId,
    channel: record.conversation.channel,
    conversationId: record.conversation.conversationId,
    parentConversationId: record.conversation.parentConversationId,
    pluginId: "unknown-plugin",
    pluginName: undefined,
    pluginRoot: "",
  }),
}));
vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => acpManagerRuntimeMocks.getAcpSessionManager(),
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      sessionBindingMocks.listBySession(targetSessionKey),
    unbind: vi.fn(async () => []),
  }),
}));
vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    maxLength: 1500,
    provider: "auto",
    summarize: true,
  }),
}));
vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));
vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    acpMocks.readAcpSessionEntry(params),
}));
vi.mock("../../tts/tts-config.js", () => ({
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveConfiguredTtsMode: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg).mode,
}));

export const noAbortResult = { aborted: false, handled: false } as const;
export const emptyConfig = {} as OpenClawConfig;

export function createDispatcher(): ReplyDispatcher {
  const acceptReply = () => true;
  const emptyCounts = () => ({ block: 0, final: 0, tool: 0 });
  return {
    getFailedCounts: vi.fn(emptyCounts),
    getQueuedCounts: vi.fn(emptyCounts),
    markComplete: vi.fn(),
    sendBlockReply: vi.fn(acceptReply),
    sendFinalReply: vi.fn(acceptReply),
    sendToolResult: vi.fn(acceptReply),
    waitForIdle: vi.fn(async () => {}),
  };
}

export function resetPluginTtsAndThreadMocks() {
  pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
  ttsMocks.maybeApplyTtsToPayload.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: ReplyPayload };
    return params.payload;
  });
  ttsMocks.normalizeTtsAutoMode
    .mockReset()
    .mockImplementation((value: unknown) => (typeof value === "string" ? value : undefined));
  ttsMocks.resolveTtsConfig.mockReset().mockReturnValue({ mode: "final" });
  threadInfoMocks.parseSessionThreadInfo
    .mockReset()
    .mockImplementation(parseGenericThreadSessionInfo);
}

export function setDiscordTestRegistry() {
  const discordTestPlugin = {
    ...createChannelTestPluginBase({
      capabilities: { chatTypes: ["direct"], nativeCommands: true },
      id: "discord",
    }),
    outbound: {
      deliveryMode: "direct",
      shouldSuppressLocalPayloadPrompt: () => false,
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ plugin: discordTestPlugin, pluginId: "discord", source: "test" }]),
  );
}

export function createHookCtx() {
  return buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    ChatType: "private",
    From: "user1",
    SessionKey: "agent:test:session",
    Surface: "telegram",
  });
}
