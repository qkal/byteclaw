import { type Mock, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
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
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

interface AbortResult { handled: boolean; aborted: boolean; stoppedSubagents?: number }

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
    plugins: [] as {
      id: string;
      status: "loaded" | "disabled" | "error";
    }[],
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
const ttsMocks = vi.hoisted(() => {
  const state = {
    synthesizeFinalAudio: false,
  };
  return {
    maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        payload: ReplyPayload;
        kind: "tool" | "block" | "final";
      };
      if (
        state.synthesizeFinalAudio &&
        params.kind === "final" &&
        typeof params.payload?.text === "string" &&
        params.payload.text.trim()
      ) {
        return {
          ...params.payload,
          audioAsVoice: true,
          mediaUrl: "https://example.com/tts-synth.opus",
        };
      }
      return params.payload;
    }),
    normalizeTtsAutoMode: vi.fn((value: unknown) =>
      typeof value === "string" ? value : undefined,
    ),
    resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
    state,
  };
});
const threadInfoMocks = vi.hoisted(() => ({
  parseSessionThreadInfo: vi.fn<
    (sessionKey: string | undefined) => {
      baseSessionKey: string | undefined;
      threadId: string | undefined;
    }
  >(),
}));

function parseGenericThreadSessionInfo(sessionKey: string | undefined) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const threadMarker = ":thread:";
  const topicMarker = ":topic:";
  const marker = trimmed.includes(threadMarker)
    ? threadMarker
    : (trimmed.includes(topicMarker)
      ? topicMarker
      : undefined);
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
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      [
        "telegram",
        "slack",
        "discord",
        "signal",
        "imessage",
        "whatsapp",
        "feishu",
        "mattermost",
      ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      [
        "telegram",
        "slack",
        "discord",
        "signal",
        "imessage",
        "whatsapp",
        "feishu",
        "mattermost",
      ].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.runtime.js", () => ({
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
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
  toPluginConversationBinding: (record: SessionBindingRecord) => {
    const metadata = (record.metadata ?? {}) as {
      pluginId?: string;
      pluginName?: string;
      pluginRoot?: string;
    };
    return {
      accountId: record.conversation.accountId,
      bindingId: record.bindingId,
      channel: record.conversation.channel,
      conversationId: record.conversation.conversationId,
      parentConversationId: record.conversation.parentConversationId,
      pluginId: metadata.pluginId ?? "unknown-plugin",
      pluginName: metadata.pluginName,
      pluginRoot: metadata.pluginRoot ?? "",
    };
  },
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

const noAbortResult = { aborted: false, handled: false } as const;
const emptyConfig = {} as OpenClawConfig;
let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;
type DispatchReplyArgs = Parameters<
  typeof import("./dispatch-from-config.js").dispatchReplyFromConfig
>[0];

beforeAll(async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  await import("./dispatch-acp.js");
  await import("./dispatch-acp-command-bypass.js");
  await import("./dispatch-acp-tts.runtime.js");
  await import("./dispatch-acp-session.runtime.js");
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
});

function createDispatcher(): ReplyDispatcher {
  return {
    getFailedCounts: vi.fn(() => ({ block: 0, final: 0, tool: 0 })),
    getQueuedCounts: vi.fn(() => ({ block: 0, final: 0, tool: 0 })),
    markComplete: vi.fn(),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    sendToolResult: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
  };
}

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.ctx?.AcpDispatchTailAfterReset) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

type MockAcpRuntime = AcpRuntime & {
  ensureSession: Mock<(input: AcpRuntimeEnsureInput) => Promise<AcpRuntimeHandle>>;
  runTurn: Mock<(input: AcpRuntimeTurnInput) => AsyncIterable<AcpRuntimeEvent>>;
  cancel: Mock<(input: { handle: AcpRuntimeHandle; reason?: string }) => Promise<void>>;
  close: Mock<(input: { handle: AcpRuntimeHandle; reason: string }) => Promise<void>>;
};

function createAcpRuntime(events: AcpRuntimeEvent[]): MockAcpRuntime {
  const runtime = {
    cancel: vi.fn<(input: { handle: AcpRuntimeHandle; reason?: string }) => Promise<void>>(
      async () => {},
    ),
    close: vi.fn<(input: { handle: AcpRuntimeHandle; reason: string }) => Promise<void>>(
      async () => {},
    ),
    ensureSession: vi.fn<(input: AcpRuntimeEnsureInput) => Promise<AcpRuntimeHandle>>(
      async (input) => ({
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}`,
        sessionKey: input.sessionKey,
      }),
    ),
    runTurn: vi.fn<(input: AcpRuntimeTurnInput) => AsyncIterable<AcpRuntimeEvent>>(
      async function*  runTurn(_input) {
        for (const event of events) {
          yield event;
        }
      },
    ),
  } satisfies AcpRuntime;
  return runtime as MockAcpRuntime;
}

function createMockAcpSessionManager() {
  return {
    getObservabilitySnapshot: () => ({
      errorsByCode: {},
      runtimeCache: {
        activeSessions: 0,
        evictedTotal: 0,
        idleTtlMs: 0,
      },
      turns: {
        active: 0,
        averageLatencyMs: 0,
        completed: 0,
        failed: 0,
        maxLatencyMs: 0,
        queueDepth: 0,
      },
    }),
    resolveSession: (params: { cfg: OpenClawConfig; sessionKey: string }) => {
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      }) as { acp?: Record<string, unknown> } | null;
      if (entry?.acp) {
        return {
          kind: "ready" as const,
          meta: entry.acp,
          sessionKey: params.sessionKey,
        };
      }
      return String(params.sessionKey).startsWith("agent:")
        ? {
            error: {
              code: "ACP_SESSION_INIT_FAILED",
              message: `ACP metadata is missing for ${params.sessionKey}.`,
            },
            kind: "stale" as const,
            sessionKey: params.sessionKey,
          }
        : {
            kind: "none" as const,
            sessionKey: params.sessionKey,
          };
    },
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }) as {
          acp?: {
            agent?: string;
            mode?: string;
          };
        } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as {
          runtime?: ReturnType<typeof createAcpRuntime>;
        };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          agent: entry?.acp?.agent || "codex",
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          sessionKey: params.sessionKey,
        });
        const stream = runtimeBackend.runtime.runTurn({
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          handle,
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
          text: params.text ?? "",
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
        if (entry?.acp?.mode === "oneshot") {
          await runtimeBackend.runtime.close({
            handle,
            reason: "oneshot-complete",
          });
        }
      },
    ),
  };
}

function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | ReplyPayload
    | undefined;
}

async function dispatchTwiceWithFreshDispatchers(params: Omit<DispatchReplyArgs, "dispatcher">) {
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    const discordTestPlugin = {
      ...createChannelTestPluginBase({
        capabilities: {
          chatTypes: ["direct"],
          nativeCommands: true,
        },
        id: "discord",
      }),
      outbound: {
        deliveryMode: "direct",
        shouldSuppressLocalPayloadPrompt: ({ payload }: { payload: ReplyPayload }) =>
          Boolean(
            payload.channelData &&
            typeof payload.channelData === "object" &&
            !Array.isArray(payload.channelData) &&
            payload.channelData.execApproval,
          ),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: discordTestPlugin,
          pluginId: "discord",
          source: "test",
        },
      ]),
    );
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ messageId: "mock", ok: true });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runInboundClaim.mockClear();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockClear();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockClear();
    hookMocks.runner.runBeforeDispatch.mockClear();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockClear();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      if (!shouldUseAcpReplyDispatchHook(event)) {
        return undefined;
      }
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.registry.plugins = [];
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    acpMocks.readAcpSessionEntry.mockReset();
    acpMocks.readAcpSessionEntry.mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset();
    acpMocks.upsertAcpSessionMeta.mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReturnValue(() => {});
    sessionBindingMocks.listBySession.mockReset();
    sessionBindingMocks.listBySession.mockReturnValue([]);
    pluginConversationBindingMocks.shownFallbackNoticeBindingIds.clear();
    sessionBindingMocks.resolveByConversation.mockReset();
    sessionBindingMocks.resolveByConversation.mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockClear();
    sessionStoreMocks.resolveStorePath.mockClear();
    sessionStoreMocks.resolveSessionStoreEntry.mockClear();
    threadInfoMocks.parseSessionThreadInfo.mockReset();
    threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.normalizeTtsAutoMode.mockClear();
    ttsMocks.resolveTtsConfig.mockClear();
    ttsMocks.resolveTtsConfig.mockReturnValue({
      mode: "final",
    });
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      Provider: "slack",
      Surface: undefined,
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "acc-1",
      GroupChannel: "ops-room",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "slack",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-1",
        channel: "telegram",
        groupId: "telegram:999",
        isGroup: true,
        threadId: 123,
        to: "telegram:999",
      }),
    );
  });

  it("falls back to thread-scoped session key when current ctx has no MessageThreadId", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        accountId: "default",
        channel: "discord",
        to: "channel:CHAN1",
      },
      lastThreadId: "stale-origin-root",
      origin: {
        threadId: "stale-origin-root",
      },
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      ExplicitDeliverRoute: true,
      MessageThreadId: undefined,
      OriginatingChannel: "discord",
      OriginatingTo: "channel:CHAN1",
      Provider: "webchat",
      SessionKey: "agent:main:discord:channel:CHAN1:thread:post-root",
      Surface: "webchat",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        threadId: "post-root",
        to: "channel:CHAN1",
      }),
    );
  });

  it("does not resurrect a cleared route thread from origin metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    // Simulate the real store: lastThreadId and deliveryContext.threadId may be normalised from
    // Origin.threadId on read, but a non-thread session key must still route to channel root.
    sessionStoreMocks.currentEntry = {
      deliveryContext: {
        accountId: "default",
        channel: "mattermost",
        threadId: "stale-root",
        to: "channel:CHAN1",
      },
      lastThreadId: "stale-root",
      origin: {
        threadId: "stale-root",
      },
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      ExplicitDeliverRoute: true,
      MessageThreadId: undefined,
      OriginatingChannel: "mattermost",
      OriginatingTo: "channel:CHAN1",
      Provider: "webchat",
      SessionKey: "agent:main:mattermost:channel:CHAN1",
      Surface: "webchat",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    const routeCall = mocks.routeReply.mock.calls[0]?.[0] as
      | { channel?: string; to?: string; threadId?: string | number }
      | undefined;
    expect(routeCall).toMatchObject({
      channel: "mattermost",
      to: "channel:CHAN1",
    });
    expect(routeCall?.threadId).toBeUndefined();
  });

  it("forces suppressTyping when routing to a different originating channel", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "slack",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("system_event");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });
  });

  it("forces suppressTyping for internal webchat turns", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "webchat",
      OriginatingTo: "session:abc",
      Provider: "webchat",
      Surface: "webchat",
    });

    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(opts?.suppressTyping).toBe(true);
      expect(opts?.typingPolicy).toBe("internal_webchat");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });
  });

  it("routes when provider is webchat but surface carries originating channel metadata", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "webchat",
      Surface: "telegram",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
      }),
    );
  });

  it("routes Feishu replies when provider is webchat and origin metadata points to Feishu", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "feishu",
      OriginatingTo: "ou_feishu_direct_123",
      Provider: "webchat",
      Surface: "feishu",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        to: "ou_feishu_direct_123",
      }),
    );
  });

  it("does not route when provider already matches originating channel", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "telegram",
      Surface: "webchat",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not route external origin replies when current surface is internal webchat without explicit delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
      Provider: "webchat",
      Surface: "webchat",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes external origin replies for internal webchat turns when explicit delivery is set", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ExplicitDeliverRoute: true,
      OriginatingChannel: "imessage",
      OriginatingTo: "imessage:+15550001111",
      Provider: "webchat",
      Surface: "webchat",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "imessage",
        to: "imessage:+15550001111",
      }),
    );
  });

  it("routes media-only tool results when summaries are suppressed", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "acc-1",
      ChatType: "group",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "slack",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({
        mediaUrls: ["https://example.com/tts-routed.opus"],
        text: "NO_REPLY",
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    const routed = mocks.routeReply.mock.calls[0]?.[0] as { payload?: ReplyPayload } | undefined;
    expect(routed?.payload?.mediaUrls).toEqual(["https://example.com/tts-routed.opus"]);
    expect(routed?.payload?.text).toBeUndefined();
  });

  it("provides onToolResult in DM sessions", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      expect(typeof opts?.onToolResult).toBe("function");
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses group tool summaries but still forwards tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "group",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      await opts?.onToolResult?.({
        mediaUrls: ["https://example.com/tts-group.opus"],
        text: "NO_REPLY",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const sent = firstToolResultPayload(dispatcher);
    expect(sent?.mediaUrls).toEqual(["https://example.com/tts-group.opus"]);
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers tool summaries in forum topic sessions (group + IsForum)", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "group",
      IsForum: true,
      MessageThreadId: 99,
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers deterministic exec approval tool payloads in groups", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "group",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        channelData: {
          execApproval: {
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
          },
        },
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toEqual(
      expect.objectContaining({
        channelData: {
          execApproval: {
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
          },
        },
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ text: "🔧 exec: ls" }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers native tool summaries and tool media", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      CommandSource: "native",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      expect(opts?.onToolResult).toBeDefined();
      await opts?.onToolResult?.({ text: "🔧 tools/sessions_send" });
      await opts?.onToolResult?.({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "🔧 tools/sessions_send" }),
    );
    const sent = (dispatcher.sendToolResult as Mock).mock.calls[1]?.[0] as ReplyPayload | undefined;
    expect(sent?.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent?.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("renders plain-text plan updates and concise approval progress when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        explanation: "Inspect code, patch it, run tests.",
        phase: "update",
        steps: ["Inspect code", "Patch code", "Run tests"],
      });
      await opts?.onApprovalEvent?.({
        command: "pnpm test",
        phase: "requested",
        status: "pending",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: "Inspect code, patch it, run tests.\n\n1. Inspect code\n2. Patch code\n3. Run tests",
      }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "Working: awaiting approval: pnpm test" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("renders concise patch summaries when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPatchSummary?.({
        phase: "end",
        summary: "1 added, 2 modified",
        title: "apply patch",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: "Working: 1 added, 2 modified" }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses plan and working-status progress when session verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      ChatType: "direct",
      Provider: "telegram",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        explanation: "Inspect code, patch it, run tests.",
        phase: "update",
        steps: ["Inspect code", "Patch code", "Run tests"],
      });
      await opts?.onApprovalEvent?.({
        command: "pnpm test",
        phase: "requested",
        status: "pending",
      });
      await opts?.onPatchSummary?.({
        phase: "end",
        summary: "1 added, 2 modified",
        title: "apply patch",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });
  it("delivers deterministic exec approval tool payloads for native commands", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      CommandSource: "native",
      Provider: "telegram",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        channelData: {
          execApproval: {
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
          },
        },
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toEqual(
      expect.objectContaining({
        channelData: {
          execApproval: {
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
          },
        },
      }),
    );
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      aborted: true,
      handled: true,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Body: "/stop",
      Provider: "telegram",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      aborted: true,
      handled: true,
      stoppedSubagents: 2,
    });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Body: "/stop",
      Provider: "telegram",
    });

    await dispatchReplyFromConfig({
      cfg,
      ctx,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "hi" }) as ReplyPayload),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("routes ACP sessions through the runtime branch and streams block replies", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([
      { text: "hello ", type: "text_delta" },
      { text: "world", type: "text_delta" },
      { type: "done" },
    ]);
    let currentAcpEntry = {
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => currentAcpEntry);
    acpMocks.upsertAcpSessionMeta.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: Record<string, unknown> | undefined,
          entry: { acp?: Record<string, unknown> } | undefined,
        ) => Record<string, unknown> | null | undefined;
      };
      const nextMeta = params.mutate(currentAcpEntry.acp as Record<string, unknown>, {
        acp: currentAcpEntry.acp as Record<string, unknown>,
      });
      if (nextMeta === null) {
        return null;
      }
      if (nextMeta) {
        currentAcpEntry = {
          ...currentAcpEntry,
          acp: nextMeta as typeof currentAcpEntry.acp,
        };
      }
      return currentAcpEntry;
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
        stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "write a test",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });
    const replyResolver = vi.fn(async () => ({ text: "fallback" }) as ReplyPayload);

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(runtime.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        mode: "persistent",
        sessionKey: "agent:codex-acp:session-1",
      }),
    );
    const blockCalls = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(blockCalls.length).toBeGreaterThan(0);
    const streamedText = blockCalls.map((call) => (call[0] as ReplyPayload).text ?? "").join("");
    expect(streamedText).toContain("hello");
    expect(streamedText).toContain("world");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello world" }),
    );
  });

  it("emits lifecycle end for ACP turns using the current run id", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ text: "done", type: "text_delta" }, { type: "done" }]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "write a test",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({
      cfg: {
        acp: {
          dispatch: { enabled: true },
          enabled: true,
          stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
        },
      } as OpenClawConfig,
      ctx,
      dispatcher,
      replyOptions: {
        runId: "run-acp-lifecycle-end",
      },
    });

    expect(agentEventMocks.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "end",
        }),
        runId: "run-acp-lifecycle-end",
        sessionKey: "agent:codex-acp:session-1",
        stream: "lifecycle",
      }),
    );
  });

  it("emits lifecycle error for ACP turn failures using the current run id", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([]);
    runtime.runTurn.mockImplementation(async function* () {
      yield { tag: "usage_update", text: "warming up", type: "status" };
      throw new Error("ACP exploded");
    });
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "write a test",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({
      cfg: {
        acp: {
          dispatch: { enabled: true },
          enabled: true,
          stream: { coalesceIdleMs: 0, maxChunkChars: 128 },
        },
      } as OpenClawConfig,
      ctx,
      dispatcher,
      replyOptions: {
        runId: "run-acp-lifecycle-error",
      },
    });

    expect(agentEventMocks.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.stringContaining("ACP exploded"),
          phase: "error",
        }),
        runId: "run-acp-lifecycle-error",
        sessionKey: "agent:codex-acp:session-1",
        stream: "lifecycle",
      }),
    );
  });

  it("posts a one-time resolved-session-id notice in thread after the first ACP turn", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ text: "hello", type: "text_delta" }, { type: "done" }]);
    const pendingAcp = {
      agent: "codex",
      backend: "acpx",
      identity: {
        acpxSessionId: "acpx-123",
        agentSessionId: "inner-123",
        lastUpdatedAt: Date.now(),
        source: "ensure" as const,
        state: "pending" as const,
      },
      lastActivityAt: Date.now(),
      mode: "persistent" as const,
      runtimeSessionName: "runtime:1",
      state: "idle" as const,
    };
    const resolvedAcp = {
      ...pendingAcp,
      identity: {
        ...pendingAcp.identity,
        source: "status" as const,
        state: "resolved" as const,
      },
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => {
      const runTurnStarted = runtime.runTurn.mock.calls.length > 0;
      return {
        acp: runTurnStarted ? resolvedAcp : pendingAcp,
        cfg: {},
        entry: {},
        sessionKey: "agent:codex-acp:session-1",
        storePath: "/tmp/mock-sessions.json",
        storeSessionKey: "agent:codex-acp:session-1",
      };
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "show ids",
      MessageThreadId: "thread-1",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver: vi.fn() });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.length).toBe(2);
    const noticePayload = finalCalls[1]?.[0] as ReplyPayload | undefined;
    expect(noticePayload?.text).toContain("Session ids resolved");
    expect(noticePayload?.text).toContain("agent session id: inner-123");
    expect(noticePayload?.text).toContain("acpx session id: acpx-123");
    expect(noticePayload?.text).toContain("codex resume inner-123");
  });

  it("posts resolved-session-id notice when ACP session is bound even without MessageThreadId", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ text: "hello", type: "text_delta" }, { type: "done" }]);
    const pendingAcp = {
      agent: "codex",
      backend: "acpx",
      identity: {
        acpxSessionId: "acpx-123",
        agentSessionId: "inner-123",
        lastUpdatedAt: Date.now(),
        source: "ensure" as const,
        state: "pending" as const,
      },
      lastActivityAt: Date.now(),
      mode: "persistent" as const,
      runtimeSessionName: "runtime:1",
      state: "idle" as const,
    };
    const resolvedAcp = {
      ...pendingAcp,
      identity: {
        ...pendingAcp.identity,
        source: "status" as const,
        state: "resolved" as const,
      },
    };
    acpMocks.readAcpSessionEntry.mockImplementation(() => {
      const runTurnStarted = runtime.runTurn.mock.calls.length > 0;
      return {
        acp: runTurnStarted ? resolvedAcp : pendingAcp,
        cfg: {},
        entry: {},
        sessionKey: "agent:codex-acp:session-1",
        storePath: "/tmp/mock-sessions.json",
        storeSessionKey: "agent:codex-acp:session-1",
      };
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });
    sessionBindingMocks.listBySession.mockReturnValue([
      {
        bindingId: "default:thread-1",
        boundAt: Date.now(),
        conversation: {
          accountId: "default",
          channel: "discord",
          conversationId: "thread-1",
        },
        status: "active",
        targetKind: "session",
        targetSessionKey: "agent:codex-acp:session-1",
      },
    ]);

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      BodyForAgent: "show ids",
      MessageThreadId: undefined,
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver: vi.fn() });

    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls.length).toBe(2);
    const noticePayload = finalCalls[1]?.[0] as ReplyPayload | undefined;
    expect(noticePayload?.text).toContain("Session ids resolved");
    expect(noticePayload?.text).toContain("agent session id: inner-123");
    expect(noticePayload?.text).toContain("acpx session id: acpx-123");
  });

  it("honors the configured default account when resolving plugin-owned binding fallbacks", async () => {
    setNoAbort();
    sessionBindingMocks.resolveByConversation.mockImplementation(
      (ref: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" && ref.accountId === "work" && ref.conversationId === "thread-1"
          ? ({
              bindingId: "plugin:work:thread-1",
              boundAt: Date.now(),
              conversation: {
                accountId: "work",
                channel: "discord",
                conversationId: "thread-1",
              },
              metadata: {
                pluginBindingOwner: "plugin",
                pluginId: "missing-plugin",
                pluginName: "Missing Plugin",
                pluginRoot: "/plugins/missing-plugin",
              },
              status: "active",
              targetKind: "session",
              targetSessionKey: "plugin-binding:missing-plugin",
            } satisfies SessionBindingRecord)
          : null,
    );

    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => undefined);
    const ctx = buildTestCtx({
      BodyForAgent: "fallback",
      Provider: "discord",
      SessionKey: "main",
      Surface: "discord",
      To: "discord:thread-1",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "discord",
        conversationId: "thread-1",
      }),
    );
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not currently loaded"),
      }),
    );
    expect(replyResolver).toHaveBeenCalled();
  });

  it("coalesces tiny ACP token deltas into normal Discord text spacing", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([
      { text: "What", type: "text_delta" },
      { text: " do", type: "text_delta" },
      { text: " you", type: "text_delta" },
      { text: " want", type: "text_delta" },
      { text: " to", type: "text_delta" },
      { text: " work", type: "text_delta" },
      { text: " on?", type: "text_delta" },
      { type: "done" },
    ]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
        stream: { coalesceIdleMs: 0, maxChunkChars: 256 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "test spacing",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher });

    const blockTexts = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => ((call[0] as ReplyPayload).text ?? "").trim())
      .filter(Boolean);
    expect(blockTexts).toEqual(["What do you want to work on?"]);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What do you want to work on?" }),
    );
  });

  it("generates final-mode TTS audio after ACP block streaming completes", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const runtime = createAcpRuntime([
      { text: "Hello from ACP streaming.", type: "text_delta" },
      { type: "done" },
    ]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "persistent",
        runtimeSessionName: "runtime:1",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:session-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:session-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
        stream: { coalesceIdleMs: 0, maxChunkChars: 256 },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "stream this",
      Provider: "discord",
      SessionKey: "agent:codex-acp:session-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher });

    const finalPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalPayload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
    expect(finalPayload?.text).toBeUndefined();
  });

  it("closes oneshot ACP sessions after the turn completes", async () => {
    setNoAbort();
    const runtime = createAcpRuntime([{ type: "done" }]);
    acpMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "codex",
        backend: "acpx",
        lastActivityAt: Date.now(),
        mode: "oneshot",
        runtimeSessionName: "runtime:oneshot",
        state: "idle",
      },
      cfg: {},
      entry: {},
      sessionKey: "agent:codex-acp:oneshot-1",
      storePath: "/tmp/mock-sessions.json",
      storeSessionKey: "agent:codex-acp:oneshot-1",
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const cfg = {
      acp: {
        dispatch: { enabled: true },
        enabled: true,
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      BodyForAgent: "run once",
      Provider: "discord",
      SessionKey: "agent:codex-acp:oneshot-1",
      Surface: "discord",
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher });

    expect(runtime.close).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "oneshot-complete",
      }),
    );
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const ctx = buildTestCtx({
      MessageSid: "msg-1",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      Provider: "whatsapp",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      cfg,
      ctx,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("suppresses local discord exec approval tool prompts when discord approvals are enabled", async () => {
    setNoAbort();
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          execApprovals: {
            approvers: ["123"],
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      Provider: "discord",
      Surface: "discord",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, options?: GetReplyOptions) => {
      await options?.onToolResult?.({
        channelData: {
          execApproval: {
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            approvalId: "12345678-1234-1234-1234-123456789012",
            approvalSlug: "12345678",
          },
        },
        text: "Approval required.",
      });
      return { text: "done" } as ReplyPayload;
    });

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "done" }),
    );
  });

  it("deduplicates same-agent inbound replies across main and direct session keys", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);
    const baseCtx = buildTestCtx({
      MessageSid: "msg-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:7463849194",
      Provider: "telegram",
      SessionKey: "agent:main:main",
      Surface: "telegram",
    });

    await dispatchReplyFromConfig({
      cfg,
      ctx: baseCtx,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    await dispatchReplyFromConfig({
      cfg,
      ctx: {
        ...baseCtx,
        SessionKey: "agent:main:telegram:direct:7463849194",
      },
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("emits message_received hook with originating channel metadata", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "acc-1",
      Body: "body text",
      CommandBody: "/search hello",
      GroupChannel: "alerts",
      GroupSpace: "guild-123",
      MessageSidFull: "sid-full",
      OriginatingChannel: "Telegram",
      OriginatingTo: "telegram:999",
      Provider: "slack",
      RawBody: "raw text",
      SenderE164: "+15555550123",
      SenderId: "user-1",
      SenderName: "Alice",
      SenderUsername: "alice",
      Surface: "slack",
      Timestamp: 1_710_000_000_000,
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "/search hello",
        from: ctx.From,
        metadata: expect.objectContaining({
          channelName: "alerts",
          guildId: "guild-123",
          messageId: "sid-full",
          originatingChannel: "Telegram",
          originatingTo: "telegram:999",
          senderE164: "+15555550123",
          senderId: "user-1",
          senderName: "Alice",
          senderUsername: "alice",
        }),
        timestamp: 1_710_000_000_000,
      }),
      expect.objectContaining({
        accountId: "acc-1",
        channelId: "telegram",
        conversationId: "telegram:999",
      }),
    );
  });

  it("does not broadcast inbound claims without a core-owned plugin binding", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaim.mockResolvedValue({ handled: true } as never);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      Body: "who are you",
      CommandAuthorized: true,
      CommandBody: "who are you",
      MessageSid: "msg-claim-1",
      MessageThreadId: 77,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-10099",
      Provider: "telegram",
      RawBody: "who are you",
      SenderId: "user-9",
      SenderUsername: "ada",
      SessionKey: "agent:main:telegram:group:-10099:77",
      Surface: "telegram",
      To: "telegram:-10099",
      WasMentioned: true,
    });
    const replyResolver = vi.fn(async () => ({ text: "core reply" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(result).toEqual({ counts: { block: 0, final: 0, tool: 0 }, queuedFinal: true });
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "who are you",
        from: ctx.From,
        metadata: expect.objectContaining({
          messageId: "msg-claim-1",
          originatingChannel: "telegram",
          originatingTo: "telegram:-10099",
          senderId: "user-9",
          senderUsername: "ada",
          threadId: 77,
        }),
      }),
      expect.objectContaining({
        accountId: "default",
        channelId: "telegram",
        conversationId: "telegram:-10099",
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "received",
        sessionKey: "agent:main:telegram:group:-10099:77",
        type: "message",
      }),
    );
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "core reply" }),
    );
  });

  it("emits internal message:received hook when a session key is available", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      CommandBody: "/help",
      GroupChannel: "ops-room",
      GroupSpace: "guild-456",
      MessageSid: "msg-42",
      Provider: "telegram",
      SessionKey: "agent:main:main",
      Surface: "telegram",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "received",
      "agent:main:main",
      expect.objectContaining({
        channelId: "telegram",
        content: "/help",
        from: ctx.From,
        messageId: "msg-42",
        metadata: expect.objectContaining({
          channelName: "ops-room",
          guildId: "guild-456",
        }),
      }),
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("skips internal message:received hook when session key is unavailable", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      CommandBody: "/help",
      Provider: "telegram",
      Surface: "telegram",
    });
    (ctx as MsgContext).SessionKey = undefined;

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits diagnostics when enabled", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      MessageSid: "msg-1",
      Provider: "slack",
      SessionKey: "agent:main:main",
      Surface: "slack",
      To: "slack:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(diagnosticMocks.logMessageQueued).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logSessionStateChange).toHaveBeenCalledWith({
      reason: "message_start",
      sessionKey: "agent:main:main",
      state: "processing",
    });
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        outcome: "completed",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("routes plugin-owned bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      result: { handled: true },
      status: "handled",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:1481858418548412579",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:abc123",
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      Body: "who are you",
      CommandAuthorized: true,
      CommandBody: "who are you",
      MessageSid: "msg-claim-plugin-1",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      Provider: "discord",
      RawBody: "who are you",
      SenderId: "user-9",
      SenderUsername: "ada",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
      Surface: "discord",
      To: "discord:channel:1481858418548412579",
      WasMentioned: false,
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(result).toEqual({ counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        accountId: "default",
        channel: "discord",
        content: "who are you",
        conversationId: "channel:1481858418548412579",
      }),
      expect.objectContaining({
        accountId: "default",
        channelId: "discord",
        conversationId: "channel:1481858418548412579",
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("routes plugin-owned Discord DM bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      result: { handled: true },
      status: "handled",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-dm-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:1177378744822943744",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:dm123",
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      AccountId: "default",
      Body: "who are you",
      CommandAuthorized: true,
      CommandBody: "who are you",
      From: "discord:1177378744822943744",
      MessageSid: "msg-claim-plugin-dm-1",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1480574946919846079",
      Provider: "discord",
      RawBody: "who are you",
      SenderId: "user-9",
      SenderUsername: "ada",
      SessionKey: "agent:main:discord:user:1177378744822943744",
      Surface: "discord",
      To: "channel:1480574946919846079",
      WasMentioned: false,
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(result).toEqual({ counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-dm-1");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({
        accountId: "default",
        channel: "discord",
        content: "who are you",
        conversationId: "1480574946919846079",
      }),
      expect.objectContaining({
        accountId: "default",
        channelId: "discord",
        conversationId: "1480574946919846079",
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw once per startup when a bound plugin is missing", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-missing-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:missing-plugin",
      },
      metadata: {
        detachHint: "/codex_detach",
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:missing123",
    } satisfies SessionBindingRecord);

    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    const firstDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: buildTestCtx({
        AccountId: "default",
        Body: "hello",
        CommandBody: "hello",
        MessageSid: "msg-missing-plugin-1",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        Provider: "discord",
        RawBody: "hello",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        Surface: "discord",
        To: "discord:channel:missing-plugin",
      }),
      dispatcher: firstDispatcher,
      replyResolver,
    });

    const firstNotice = (firstDispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(firstNotice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();

    replyResolver.mockClear();
    hookMocks.runner.runInboundClaim.mockClear();

    const secondDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: buildTestCtx({
        AccountId: "default",
        Body: "still there?",
        CommandBody: "still there?",
        MessageSid: "msg-missing-plugin-2",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        Provider: "discord",
        RawBody: "still there?",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        Surface: "discord",
        To: "discord:channel:missing-plugin",
      }),
      dispatcher: secondDispatcher,
      replyResolver,
    });

    expect(secondDispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when the bound plugin is loaded but has no inbound_claim handler", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-no-handler-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:no-handler",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:nohandler123",
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: buildTestCtx({
        AccountId: "default",
        Body: "hello",
        CommandBody: "hello",
        MessageSid: "msg-no-handler-1",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:no-handler",
        Provider: "discord",
        RawBody: "hello",
        SessionKey: "agent:main:discord:channel:no-handler",
        Surface: "discord",
        To: "discord:channel:no-handler",
      }),
      dispatcher,
      replyResolver,
    });

    const notice = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | ReplyPayload
      | undefined;
    expect(notice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin declines the turn and keeps the binding attached", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "declined",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-declined-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:declined",
      },
      metadata: {
        detachHint: "/codex_detach",
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:declined123",
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: buildTestCtx({
        AccountId: "default",
        Body: "hello",
        CommandBody: "hello",
        MessageSid: "msg-declined-1",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:declined",
        Provider: "discord",
        RawBody: "hello",
        SessionKey: "agent:main:discord:channel:declined",
        Surface: "discord",
        To: "discord:channel:declined",
      }),
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request was declined.");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin errors and keeps raw details out of the reply", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      error: "boom",
      status: "error",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-error-1",
      boundAt: 1_710_000_000_000,
      conversation: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:error",
      },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "plugin-binding:codex:error123",
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: buildTestCtx({
        AccountId: "default",
        Body: "hello",
        CommandBody: "hello",
        MessageSid: "msg-error-1",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:error",
        Provider: "discord",
        RawBody: "hello",
        SessionKey: "agent:main:discord:channel:error",
        Surface: "discord",
        To: "discord:channel:error",
      }),
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request failed.");
    expect(finalNotice?.text).not.toContain("boom");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      MessageSid: "msg-dup",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      Provider: "whatsapp",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      cfg,
      ctx,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        outcome: "skipped",
        reason: "duplicate",
      }),
    );
  });

  it("passes configOverride to replyResolver when provided", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "msteams", Surface: "msteams" });

    const overrideCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      cfg,
      configOverride: overrideCfg,
      ctx,
      dispatcher,
      replyResolver,
    });

    expect(receivedCfg).toBe(overrideCfg);
  });

  it("does not pass cfg as implicit configOverride when configOverride is not provided", async () => {
    setNoAbort();
    const cfg = { agents: { defaults: { userTimezone: "UTC" } } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", Surface: "telegram" });

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ cfg, ctx, dispatcher, replyResolver });

    expect(receivedCfg).toBeUndefined();
  });

  it("suppresses isReasoning payloads from final replies (WhatsApp channel)", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const replyResolver = async () =>
      [
        { isReasoning: true, text: "Reasoning:\n_thinking..._" },
        { text: "The answer is 42" },
      ] satisfies ReplyPayload[];
    await dispatchReplyFromConfig({ cfg: emptyConfig, ctx, dispatcher, replyResolver });
    const finalCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0][0]).toMatchObject({ text: "The answer is 42" });
  });

  it("suppresses isReasoning payloads from block replies (generic dispatch path)", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      // Simulate block reply with reasoning payload
      await opts?.onBlockReply?.({ isReasoning: true, text: "Reasoning:\n_thinking..._" });
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return { text: "The answer is 42" };
    };
    // Capture what actually gets dispatched as block replies
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );
    await dispatchReplyFromConfig({ cfg: emptyConfig, ctx, dispatcher, replyResolver });
    expect(blockReplySentTexts).not.toContain("Reasoning:\n_thinking..._");
    expect(blockReplySentTexts).toContain("The answer is 42");
  });

  it("signals block boundaries before async block delivery is queued", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const callOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };

    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        callOrder.push(`dispatch:${payload.text}`);
        return true;
      },
    );

    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx,
      dispatcher,
      replyOptions: {
        onBlockReplyQueued: (payload) => {
          callOrder.push(`queued:${payload.text}`);
        },
      },
      replyResolver,
    });

    expect(callOrder).toEqual(["queued:The answer is 42", "dispatch:The answer is 42"]);
  });

  it("forwards payload metadata into onBlockReplyQueued context", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const onBlockReplyQueued = vi.fn();
    const { setReplyPayloadMetadata } = await import("../types.js");
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });
      await opts?.onBlockReply?.(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx,
      dispatcher,
      replyOptions: { onBlockReplyQueued },
      replyResolver,
    });

    expect(onBlockReplyQueued).toHaveBeenCalledWith(
      { text: "Alpha" },
      expect.objectContaining({ assistantMessageIndex: 7 }),
    );
  });
});

describe("before_dispatch hook", () => {
  const createHookCtx = (overrides: Partial<MsgContext> = {}) =>
    buildTestCtx({
      Body: "hello",
      BodyForAgent: "hello",
      BodyForCommands: "hello",
      ChatType: "private",
      From: "user1",
      Surface: "telegram",
      ...overrides,
    });

  beforeEach(() => {
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ messageId: "mock", ok: true });
    threadInfoMocks.parseSessionThreadInfo.mockReset();
    threadInfoMocks.parseSessionThreadInfo.mockImplementation(parseGenericThreadSessionInfo);
    ttsMocks.state.synthesizeFinalAudio = false;
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    setNoAbort();
    hookMocks.runner.runBeforeDispatch.mockClear();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockClear();
    hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "before_dispatch",
    );
  });

  it("skips model dispatch when hook returns handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: createHookCtx(),
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Blocked" });
    expect(result.queuedFinal).toBe(true);
  });

  it("silently short-circuits when hook returns handled without text", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true });
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: createHookCtx(),
      dispatcher,
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
  });

  it("uses canonical hook metadata and shared routed final delivery", async () => {
    ttsMocks.state.synthesizeFinalAudio = true;
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: true, text: "Blocked" });
    const dispatcher = createDispatcher();
    const ctx = createHookCtx({
      Body: "raw body",
      BodyForAgent: "agent body",
      BodyForCommands: "command body",
      ChatType: "direct",
      From: "signal:group:ops-room",
      GroupChannel: "ops-room",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
      Provider: "slack",
      SenderId: "signal:user:alice",
      Surface: "slack",
      Timestamp: 123,
    });

    const result = await dispatchReplyFromConfig({ cfg: emptyConfig, ctx, dispatcher });

    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "agent body",
        channel: "telegram",
        content: "command body",
        isGroup: true,
        senderId: "signal:user:alice",
        timestamp: 123,
      }),
      expect.objectContaining({
        channelId: "telegram",
        senderId: "signal:user:alice",
      }),
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        payload: expect.objectContaining({
          audioAsVoice: true,
          mediaUrl: "https://example.com/tts-synth.opus",
          text: "Blocked",
        }),
        to: "telegram:999",
      }),
    );
    expect(result.queuedFinal).toBe(true);
  });

  it("continues default dispatch when hook returns not handled", async () => {
    hookMocks.runner.runBeforeDispatch.mockResolvedValue({ handled: false });
    const dispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      cfg: emptyConfig,
      ctx: createHookCtx(),
      dispatcher,
      replyResolver: async () => ({ text: "model reply" }),
    });
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "model reply" });
  });
});
