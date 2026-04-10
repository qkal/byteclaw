import type * as ConversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

type ConfiguredBindingRoute = ReturnType<typeof ConversationRuntime.resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof ConversationRuntime.getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<
  ReturnType<typeof ConversationRuntime.ensureConfiguredBindingRouteReady>
>;
type ReplyDispatcher = Parameters<
  PluginRuntime["channel"]["reply"]["withReplyDispatcher"]
>[0]["dispatcher"];
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends readonly unknown[]
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

function createReplyDispatcher(): ReplyDispatcher {
  return {
    getFailedCounts: vi.fn(() => ({ block: 0, final: 0, tool: 0 })),
    getQueuedCounts: vi.fn(() => ({ block: 0, final: 0, tool: 0 })),
    markComplete: vi.fn(),
    sendBlockReply: vi.fn(),
    sendFinalReply: vi.fn(),
    sendToolResult: vi.fn(),
    waitForIdle: vi.fn(),
  };
}

function createConfiguredFeishuRoute(): NonNullable<ConfiguredBindingRoute> {
  return {
    bindingResolution: {
      compiledBinding: {
        accountPattern: "default",
        agentId: "codex",
        binding: {
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "feishu",
            peer: { id: "ou_sender_1", kind: "direct" },
          },
          type: "acp",
        },
        bindingConversationId: "ou_sender_1",
        channel: "feishu",
        provider: {
          compileConfiguredBinding: () => ({ conversationId: "ou_sender_1" }),
          matchInboundConversation: () => ({ conversationId: "ou_sender_1" }),
        },
        target: {
          conversationId: "ou_sender_1",
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: {
              bindingId: "config:acp:feishu:default:ou_sender_1",
              boundAt: 0,
              conversation: {
                accountId: "default",
                channel: "feishu",
                conversationId: "ou_sender_1",
              },
              metadata: { source: "config" },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
            },
            statefulTarget: {
              agentId: "codex",
              driverId: "acp",
              kind: "stateful",
              sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
            },
          }),
        },
      },
      conversation: {
        accountId: "default",
        channel: "feishu",
        conversationId: "ou_sender_1",
      },
      match: {
        conversationId: "ou_sender_1",
      },
      record: {
        bindingId: "config:acp:feishu:default:ou_sender_1",
        boundAt: 0,
        conversation: {
          accountId: "default",
          channel: "feishu",
          conversationId: "ou_sender_1",
        },
        metadata: { source: "config" },
        status: "active",
        targetKind: "session",
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      },
      statefulTarget: {
        agentId: "codex",
        driverId: "acp",
        kind: "stateful",
        sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      },
    },
    route: {
      accountId: "default",
      agentId: "codex",
      channel: "feishu",
      lastRoutePolicy: "session",
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
    } as ResolvedAgentRoute,
  };
}

function createConfiguredBindingReadiness(ok: boolean, error?: string): BindingReadiness {
  return (ok ? { ok: true } : { error: error ?? "unknown error", ok: false }) as BindingReadiness;
}

function createBoundConversation(): NonNullable<BoundConversation> {
  return {
    bindingId: "default:oc_group_chat:topic:om_topic_root",
    boundAt: 0,
    conversation: {
      accountId: "default",
      channel: "feishu",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    },
    status: "active",
    targetKind: "session",
    targetSessionKey: "agent:codex:acp:binding:feishu:default:feedface",
  };
}

function buildDefaultResolveRoute(): ResolvedAgentRoute {
  return {
    accountId: "default",
    agentId: "main",
    channel: "feishu",
    lastRoutePolicy: "session",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
  };
}

function _createUnboundConfiguredRoute(
  route: NonNullable<ConfiguredBindingRoute>["route"],
): ConfiguredBindingRoute {
  return { bindingResolution: null, route };
}

function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  return {
    channel: {
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldComputeCommandAuthorized: vi.fn(() => false),
      },
      pairing: {
        buildPairingReply: vi.fn(),
        readAllowFromStore: vi.fn().mockResolvedValue(["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
      },
      reply: {
        dispatchReplyFromConfig: vi.fn().mockResolvedValue({
          counts: { final: 1 },
          queuedFinal: false,
        }),
        finalizeInboundContext: finalizeInboundContextMock as never,
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        resolveEnvelopeFormatOptions:
          resolveEnvelopeFormatOptionsMock as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
        withReplyDispatcher: withReplyDispatcherMock as never,
      },
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
      session: {
        readSessionUpdatedAt: readSessionUpdatedAtMock,
        resolveStorePath: resolveStorePathMock,
      },
      ...overrides.channel,
    },
    ...(overrides.system ? { system: overrides.system as PluginRuntime["system"] } : {}),
    ...(overrides.media ? { media: overrides.media as PluginRuntime["media"] } : {}),
  } as unknown as PluginRuntime;
}

const resolveAgentRouteMock: PluginRuntime["channel"]["routing"]["resolveAgentRoute"] = (params) =>
  mockResolveAgentRoute(params);
const readSessionUpdatedAtMock: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"] = (
  params,
) => mockReadSessionUpdatedAt(params);
const resolveStorePathMock: PluginRuntime["channel"]["session"]["resolveStorePath"] = (params) =>
  mockResolveStorePath(params);
const resolveEnvelopeFormatOptionsMock = () => ({});
const finalizeInboundContextMock = (ctx: Record<string, unknown>) => ctx;
const withReplyDispatcherMock = async ({
  run,
}: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => await run();

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockListFeishuThreadMessages,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
  mockReadSessionUpdatedAt,
  mockResolveStorePath,
  mockResolveConfiguredBindingRoute,
  mockEnsureConfiguredBindingRouteReady,
  mockResolveBoundConversation,
  mockTouchBinding,
  mockResolveFeishuReasoningPreviewEnabled,
} = vi.hoisted(() => ({
  mockCreateFeishuClient: vi.fn(),
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: createReplyDispatcher(),
    markDispatchIdle: vi.fn(),
    replyOptions: {},
  })),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockEnsureConfiguredBindingRouteReady: vi.fn(
    async (_params?: unknown): Promise<BindingReadiness> => ({ ok: true }),
  ),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockListFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  mockReadSessionUpdatedAt: vi.fn((_params?: unknown): number | undefined => undefined),
  mockResolveAgentRoute: vi.fn((_params?: unknown) => buildDefaultResolveRoute()),
  mockResolveBoundConversation: vi.fn(() => null as BoundConversation),
  mockResolveConfiguredBindingRoute: vi.fn(
    ({
      route,
    }: {
      route: NonNullable<ConfiguredBindingRoute>["route"];
    }): ConfiguredBindingRoute => ({
      bindingResolution: null,
      route,
    }),
  ),
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
  mockResolveStorePath: vi.fn((_params?: unknown) => "/tmp/feishu-sessions.json"),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ chatId: "oc-dm", messageId: "pairing-msg" }),
  mockTouchBinding: vi.fn(),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: mockResolveFeishuReasoningPreviewEnabled,
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: mockGetMessageFeishu,
  listFeishuThreadMessages: mockListFeishuThreadMessages,
  sendMessageFeishu: mockSendMessageFeishu,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (params: unknown) =>
      mockEnsureConfiguredBindingRouteReady(params),
    getSessionBindingService: () => ({
      resolveByConversation: mockResolveBoundConversation,
      touch: mockTouchBinding,
    }),
    resolveConfiguredBindingRoute: (params: unknown) =>
      mockResolveConfiguredBindingRoute(params as { route: ResolvedAgentRoute }),
  };
});

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
  const runtime = createRuntimeEnv();
  await handleFeishuMessage({
    cfg: params.cfg,
    event: params.event,
    runtime,
  });
  return runtime;
}

describe("handleFeishuMessage ACP routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfiguredBindingRoute.mockReset().mockImplementation(
      ({
        route,
      }: {
        route: NonNullable<ConfiguredBindingRoute>["route"];
      }): ConfiguredBindingRoute => ({
        bindingResolution: null,
        route,
      }),
    );
    mockEnsureConfiguredBindingRouteReady.mockReset().mockResolvedValue({ ok: true });
    mockResolveBoundConversation.mockReset().mockReturnValue(null);
    mockTouchBinding.mockReset();
    mockResolveFeishuReasoningPreviewEnabled.mockReset().mockReturnValue(false);
    mockResolveAgentRoute.mockReset().mockReturnValue({
      ...buildDefaultResolveRoute(),
      sessionKey: "agent:main:feishu:direct:ou_sender_1",
    });
    mockSendMessageFeishu
      .mockReset()
      .mockResolvedValue({ chatId: "oc_dm", messageId: "reply-msg" });
    mockCreateFeishuReplyDispatcher.mockReset().mockReturnValue({
      dispatcher: createReplyDispatcher(),
      markDispatchIdle: vi.fn(),
      replyOptions: {},
    });

    setFeishuRuntime(createFeishuBotRuntime());
  });

  it("ensures configured ACP routes for Feishu DMs", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());

    await dispatchMessage({
      cfg: {
        channels: { feishu: { allowFrom: ["ou_sender_1"], dmPolicy: "open", enabled: true } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      event: {
        message: {
          chat_id: "oc_dm",
          chat_type: "p2p",
          content: JSON.stringify({ text: "hello" }),
          message_id: "msg-1",
          message_type: "text",
        },
        sender: { sender_id: { open_id: "ou_sender_1" } },
      },
    });

    expect(mockResolveConfiguredBindingRoute).toHaveBeenCalledTimes(1);
    expect(mockEnsureConfiguredBindingRouteReady).toHaveBeenCalledTimes(1);
  });

  it("surfaces configured ACP initialization failures to the Feishu conversation", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
      createConfiguredBindingReadiness(false, "runtime unavailable"),
    );

    await dispatchMessage({
      cfg: {
        channels: { feishu: { allowFrom: ["ou_sender_1"], dmPolicy: "open", enabled: true } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      event: {
        message: {
          chat_id: "oc_dm",
          chat_type: "p2p",
          content: JSON.stringify({ text: "hello" }),
          message_id: "msg-2",
          message_type: "text",
        },
        sender: { sender_id: { open_id: "ou_sender_1" } },
      },
    });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("runtime unavailable"),
        to: "chat:oc_dm",
      }),
    );
  });

  it("routes Feishu topic messages through active bound conversations", async () => {
    mockResolveBoundConversation.mockReturnValue(createBoundConversation());

    await dispatchMessage({
      cfg: {
        channels: {
          feishu: {
            allowFrom: ["ou_sender_1"],
            enabled: true,
            groups: {
              oc_group_chat: {
                allow: true,
                groupSessionScope: "group_topic",
                requireMention: false,
              },
            },
          },
        },
        session: { mainKey: "main", scope: "per-sender" },
      },
      event: {
        message: {
          chat_id: "oc_group_chat",
          chat_type: "group",
          content: JSON.stringify({ text: "hello topic" }),
          message_id: "msg-3",
          message_type: "text",
          root_id: "om_topic_root",
        },
        sender: { sender_id: { open_id: "ou_sender_1" } },
      },
    });

    expect(mockResolveBoundConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    );
    expect(mockTouchBinding).toHaveBeenCalledWith("default:oc_group_chat:topic:om_topic_root");
  });

  it("passes reasoning preview permission from session state into the dispatcher", async () => {
    mockResolveFeishuReasoningPreviewEnabled.mockReturnValue(true);

    await dispatchMessage({
      cfg: {
        channels: { feishu: { allowFrom: ["ou_sender_1"], dmPolicy: "open", enabled: true } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      event: {
        message: {
          chat_id: "oc_dm",
          chat_type: "p2p",
          content: JSON.stringify({ text: "hello" }),
          message_id: "msg-reasoning",
          message_type: "text",
        },
        sender: { sender_id: { open_id: "ou_sender_1" } },
      },
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ allowReasoningPreview: true }),
    );
  });
});

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ({
    ...ctx,
    CommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : false,
  }));
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ counts: { final: 1 }, queuedFinal: false });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    contentType: "video/mp4",
    id: "inbound-clip.mp4",
    path: "/tmp/inbound-clip.mp4",
    size: Buffer.byteLength("video"),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    mockListFeishuThreadMessages.mockReset().mockResolvedValue([]);
    mockReadSessionUpdatedAt.mockReturnValue(undefined);
    mockResolveStorePath.mockReturnValue("/tmp/feishu-sessions.json");
    mockResolveConfiguredBindingRoute.mockReset().mockImplementation(
      ({
        route,
      }: {
        route: NonNullable<ConfiguredBindingRoute>["route"];
      }): ConfiguredBindingRoute => ({
        bindingResolution: null,
        route,
      }),
    );
    mockEnsureConfiguredBindingRouteReady.mockReset().mockResolvedValue({ ok: true });
    mockResolveBoundConversation.mockReset().mockReturnValue(null);
    mockTouchBinding.mockReset();
    mockResolveAgentRoute.mockReturnValue(buildDefaultResolveRoute());
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    mockEnqueueSystemEvent.mockReset();
    setFeishuRuntime(
      createFeishuBotRuntime({
        channel: {
          commands: {
            resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
          },
          media: {
            saveMediaBuffer: mockSaveMediaBuffer,
          },
          pairing: {
            buildPairingReply: mockBuildPairingReply,
            readAllowFromStore: mockReadAllowFromStore,
            upsertPairingRequest: mockUpsertPairingRequest,
          },
          reply: {
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            finalizeInboundContext: mockFinalizeInboundContext as never,
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            resolveEnvelopeFormatOptions:
              resolveEnvelopeFormatOptionsMock as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            withReplyDispatcher: mockWithReplyDispatcher as never,
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
        system: {
          enqueueSystemEvent: mockEnqueueSystemEvent,
        },
      }),
    );
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hi there" }),
        message_id: "msg-no-system-preview",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          dmPolicy: "open",
        },
      },
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "/status" }),
        message_id: "msg-auth-bypass-regression",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      authorizers: [{ allowed: false, configured: true }],
      useAccessGroups: true,
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          allowFrom: [],
          dmPolicy: "pairing",
        },
      },
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello there" }),
        message_id: "msg-read-store-non-command",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith({
      accountId: "default",
      channel: "feishu",
    });
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("skips sender-name lookup when resolveSenderNames is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          allowFrom: ["*"],
          dmPolicy: "open",
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-skip-sender-lookup",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuClient).not.toHaveBeenCalled();
  });

  it("propagates parent/root message ids into inbound context for reply reconstruction", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce({
      chatId: "oc-group",
      content: "quoted content",
      contentType: "text",
      messageId: "om_parent_001",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          enabled: true,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "reply text" }),
        message_id: "om_reply_001",
        message_type: "text",
        parent_id: "om_parent_001",
        root_id: "om_root_001",
      },
      sender: {
        sender_id: {
          open_id: "ou-replier",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToBody: "quoted content",
        ReplyToId: "om_parent_001",
        RootMessageId: "om_root_001",
      }),
    );
  });

  it("uses message create_time as Timestamp instead of Date.now()", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "delete this" }),
        create_time: "1700000000000",
        message_id: "msg-create-time",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Timestamp: 1_700_000_000_000,
      }),
    );
  });

  it("falls back to Date.now() when create_time is absent", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-no-create-time",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    const before = Date.now();
    await dispatchMessage({ cfg, event });
    const after = Date.now();

    const call = mockFinalizeInboundContext.mock.calls[0]?.[0] as { Timestamp: number };
    expect(call.Timestamp).toBeGreaterThanOrEqual(before);
    expect(call.Timestamp).toBeLessThanOrEqual(after);
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc_dm_chat_1",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-pairing-chat-reply",
        message_type: "text",
      },
      sender: {
        sender_id: {
          user_id: "u_mobile_only",
        },
      },
    };

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm_chat_1",
      }),
    );
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          allowFrom: [],
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-pairing-flow",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      accountId: "default",
      channel: "feishu",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        text: expect.stringContaining("Your Feishu user id: ou-unapproved"),
        to: "chat:oc-dm",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        text: expect.stringContaining("Pairing code:"),
        to: "chat:oc-dm",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        text: expect.stringContaining("ABCDEFGH"),
        to: "chat:oc-dm",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "/status" }),
        message_id: "msg-group-command-auth",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      authorizers: [{ allowed: false, configured: false }],
      useAccessGroups: true,
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("normalizes group mention-prefixed slash commands before command-auth probing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "@_user_1/model" }),
        mentions: [{ id: { open_id: "ou-bot" }, key: "@_user_1", name: "Bot", tenant_key: "" }],
        message_id: "msg-group-mention-command-probe",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/model", cfg);
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "/status" }),
        message_id: "msg-group-command-fallback",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-admin",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      authorizers: [{ allowed: true, configured: true }],
      useAccessGroups: true,
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-global-group-sender-allow",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        SenderId: "ou-allowed",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender when global groupSenderAllowFrom excludes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-global-group-sender-block",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-blocked",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-global"],
          groups: {
            "oc-group": {
              allowFrom: ["ou-group-only"],
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-per-group-precedence",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-global",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops quoted group context from senders outside the group sender allowlist in allowlist mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      chatId: "oc-group",
      content: "blocked quoted content",
      contentType: "text",
      messageId: "om_parent_blocked",
      senderId: "ou-blocked",
      senderType: "user",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          contextVisibility: "allowlist",
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-group-quoted-filter",
        message_type: "text",
        parent_id: "om_parent_blocked",
      },
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToBody: undefined,
        ReplyToId: "om_parent_blocked",
      }),
    );
  });

  it("keeps quoted group context from non-allowlisted senders in default all mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      chatId: "oc-group",
      content: "visible quoted content",
      contentType: "text",
      messageId: "om_parent_visible",
      senderId: "ou-blocked",
      senderType: "user",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-group-quoted-visible",
        message_type: "text",
        parent_id: "om_parent_visible",
      },
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToBody: "visible quoted content",
        ReplyToId: "om_parent_visible",
      }),
    );
  });

  it("dispatches group image message when groupPolicy is open (requireMention defaults to false)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          // RequireMention is NOT set — should default to false for open policy
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group-open",
        chat_type: "group",
        content: JSON.stringify({ image_key: "img_v3_test" }),
        message_id: "msg-group-image-open",
        message_type: "image",
      },
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("drops group image message when groupPolicy is open but requireMention is explicitly true", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          requireMention: true, // Explicit override — user opts into mention-required even for open
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group-open",
        chat_type: "group",
        content: JSON.stringify({ image_key: "img_v3_test" }),
        message_id: "msg-group-image-open-explicit-mention",
        message_type: "image",
      },
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops group image message when groupPolicy is allowlist and requireMention is not set (defaults to true)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          // RequireMention not set — for non-open policy defaults to true
          groups: {
            "oc-allowlist-group": {
              allow: true,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-allowlist-group",
        chat_type: "group",
        content: JSON.stringify({ image_key: "img_v3_test" }),
        message_id: "msg-group-image-allowlist",
        message_type: "image",
      },
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops message when groupConfig.enabled is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-disabled-group": {
              enabled: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-disabled-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-disabled-group",
        message_type: "text",
      },
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({
          file_key: "file_video_payload",
          file_name: "clip.mp4",
          image_key: "img_thumb_payload",
        }),
        message_id: "msg-video-inbound",
        message_type: "video",
      },
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        fileKey: "file_video_payload",
        messageId: "msg-video-inbound",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("uses media message_type file_key (not thumbnail image_key) for inbound mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({
          file_key: "file_media_payload",
          file_name: "mobile.mp4",
          image_key: "img_media_thumb",
        }),
        message_id: "msg-media-inbound",
        message_type: "media",
      },
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        fileKey: "file_media_payload",
        messageId: "msg-media-inbound",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("falls back to the message payload filename when download metadata omits it", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      contentType: "video/mp4",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({
          file_key: "file_media_payload",
          file_name: "payload-name.mp4",
          image_key: "img_media_thumb",
        }),
        message_id: "msg-media-payload-name",
        message_type: "media",
      },
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "payload-name.mp4",
    );
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({
          content: [
            [
              {
                tag: "media",
                file_key: "file_post_media_payload",
                file_name: "embedded.mov",
              },
            ],
          ],
          title: "Rich text",
        }),
        message_id: "msg-post-media",
        message_type: "post",
      },
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        fileKey: "file_post_media_payload",
        messageId: "msg-post-media",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
    );
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-message-id-line",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-msgid",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-message-id-line]\nou-msgid: hello",
      }),
    );
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const mockGetMerged = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
            message_id: "container",
            msg_type: "merge_forward",
          },
          {
            body: { content: JSON.stringify({ file_name: "report.pdf" }) },
            create_time: "2000",
            message_id: "sub-2",
            msg_type: "file",
            upper_message_id: "container",
          },
          {
            body: { content: JSON.stringify({ text: "alpha" }) },
            create_time: "1000",
            message_id: "sub-1",
            msg_type: "text",
            upper_message_id: "container",
          },
        ],
      },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: mockGetMerged,
        },
      },
    } as unknown as PluginRuntime);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
        message_id: "msg-merge-forward",
        message_type: "merge_forward",
      },
      sender: {
        sender_id: {
          open_id: "ou-merge",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
        ),
      }),
    );
  });

  it("falls back when merge_forward API returns no sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
        message_id: "msg-merge-empty",
        message_type: "merge_forward",
      },
      sender: {
        sender_id: {
          open_id: "ou-merge-empty",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("[Merged and Forwarded Message - could not fetch]"),
      }),
    );
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99_991_672,
                msg: "permission denied https://open.feishu.cn/app/cli_test",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // Pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello group" }),
        message_id: "msg-perm-1",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-perm",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        ),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm: hello group"),
      }),
    );
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99_991_672,
                msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_scope_bug",
          appSecret: "sec_scope_bug", // Pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello group" }),
        message_id: "msg-perm-scope-1",
        message_type: "text",
      },
      sender: {
        sender_id: {
          open_id: "ou-perm-scope",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.not.stringContaining("Permission grant URL"),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm-scope: hello group"),
      }),
    );
  });

  it("routes group sessions by sender when groupSessionScope=group_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "group sender scope" }),
        message_id: "msg-scope-group-sender",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-scope-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: null,
        peer: { id: "oc-group:sender:ou-scope-user", kind: "group" },
      }),
    );
  });

  it("routes topic sessions and parentPeer when groupSessionScope=group_topic_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "topic sender scope" }),
        message_id: "msg-scope-topic-sender",
        message_type: "text",
        root_id: "om_root_topic",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:om_root_topic:sender:ou-topic-user", kind: "group" },
      }),
    );
  });

  it("keeps root_id as topic key when root_id and thread_id both exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "topic sender scope" }),
        message_id: "msg-scope-topic-thread-id",
        message_type: "text",
        root_id: "om_root_topic",
        thread_id: "omt_topic_1",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:om_root_topic:sender:ou-topic-user", kind: "group" },
      }),
    );
  });

  it("uses thread_id as topic key when root_id is missing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "topic sender scope" }),
        message_id: "msg-scope-topic-thread-only",
        message_type: "text",
        thread_id: "omt_topic_1",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:omt_topic_1:sender:ou-topic-user", kind: "group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to group_topic routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
          topicSessionMode: "enabled",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "legacy topic mode" }),
        message_id: "msg-legacy-topic-mode",
        message_type: "text",
        root_id: "om_root_legacy",
      },
      sender: { sender_id: { open_id: "ou-legacy" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:om_root_legacy", kind: "group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
          topicSessionMode: "enabled",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "legacy topic mode" }),
        message_id: "msg-legacy-topic-thread-id",
        message_type: "text",
        root_id: "om_root_legacy",
        thread_id: "omt_topic_legacy",
      },
      sender: { sender_id: { open_id: "ou-legacy-thread-id" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:om_root_legacy", kind: "group" },
      }),
    );
  });

  it("uses message_id as topic root when group_topic + replyInThread and no root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "create topic" }),
        message_id: "msg-new-topic-root",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-topic-init" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPeer: { id: "oc-group", kind: "group" },
        peer: { id: "oc-group:topic:msg-new-topic-root", kind: "group" },
      }),
    );
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const firstTurn: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "create topic" }),
        message_id: "msg-topic-first",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-topic-init" } },
    };
    const secondTurn: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "follow up in same topic" }),
        message_id: "msg-topic-second",
        message_type: "text",
        root_id: "msg-topic-first",
        thread_id: "omt_topic_created",
      },
      sender: { sender_id: { open_id: "ou-topic-init" } },
    };

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { id: "oc-group:topic:msg-topic-first", kind: "group" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { id: "oc-group:topic:msg-topic-first", kind: "group" },
      }),
    );
  });

  it("replies to the topic root when handling a message inside an existing topic", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              replyInThread: "enabled",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "reply inside topic" }),
        message_id: "om_child_message",
        message_type: "text",
        root_id: "om_root_topic",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
      }),
    );
  });

  it("replies to triggering message in normal group even when root_id is present (#32980)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello in normal group" }),
        message_id: "om_quote_reply",
        message_type: "text",
        root_id: "om_original_msg",
      },
      sender: { sender_id: { open_id: "ou-normal-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_quote_reply",
        rootId: "om_original_msg",
      }),
    );
  });

  it("replies to topic root in topic-mode group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello in topic group" }),
        message_id: "om_topic_reply",
        message_type: "text",
        root_id: "om_topic_root",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_root",
        rootId: "om_topic_root",
      }),
    );
  });

  it("replies to topic root in topic-sender group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello in topic sender group" }),
        message_id: "om_topic_sender_reply",
        message_type: "text",
        root_id: "om_topic_sender_root",
      },
      sender: { sender_id: { open_id: "ou-topic-sender-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_sender_root",
        rootId: "om_topic_sender_root",
      }),
    );
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group",
              replyInThread: "disabled",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "thread content" }),
        message_id: "msg-thread-reply",
        message_type: "text",
        thread_id: "omt_topic_thread_reply",
      },
      sender: { sender_id: { open_id: "ou-thread-reply" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyInThread: true,
        threadReply: true,
      }),
    );
  });

  it("bootstraps topic thread context only for a new thread session", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      chatId: "oc-group",
      content: "root starter",
      contentType: "text",
      messageId: "om_topic_root",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        content: "assistant reply",
        contentType: "text",
        createTime: 1_710_000_000_000,
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
      },
      {
        content: "follow-up question",
        contentType: "text",
        createTime: 1_710_000_001_000,
        messageId: "om_follow_up",
        senderId: "ou-topic-user",
        senderType: "user",
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "current turn" }),
        message_id: "om_topic_followup_existing_session",
        message_type: "text",
        root_id: "om_topic_root",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadSessionUpdatedAt).toHaveBeenCalledWith({
      sessionKey: "agent:main:feishu:dm:ou-attacker",
      storePath: "/tmp/feishu-sessions.json",
    });
    expect(mockListFeishuThreadMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        rootMessageId: "om_topic_root",
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "om_topic_root",
        ThreadHistoryBody: "assistant reply\n\nfollow-up question",
        ThreadLabel: "Feishu thread in oc-group",
        ThreadStarterBody: "root starter",
      }),
    );
  });

  it("skips topic thread bootstrap when the thread session already exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadSessionUpdatedAt.mockReturnValue(1_710_000_000_000);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "current turn" }),
        message_id: "om_topic_followup",
        message_type: "text",
        root_id: "om_topic_root",
      },
      sender: { sender_id: { open_id: "ou-topic-user" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockListFeishuThreadMessages).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "om_topic_root",
        ThreadHistoryBody: undefined,
        ThreadLabel: "Feishu thread in oc-group",
        ThreadStarterBody: undefined,
      }),
    );
  });

  it("keeps sender-scoped thread history when the inbound event and thread history use different sender ids", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      chatId: "oc-group",
      content: "root starter",
      contentType: "text",
      messageId: "om_topic_root",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        content: "assistant reply",
        contentType: "text",
        createTime: 1_710_000_000_000,
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
      },
      {
        content: "follow-up question",
        contentType: "text",
        createTime: 1_710_000_001_000,
        messageId: "om_follow_up",
        senderId: "user_topic_1",
        senderType: "user",
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic_sender",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "current turn" }),
        message_id: "om_topic_followup_mixed_ids",
        message_type: "text",
        root_id: "om_topic_root",
      },
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
          user_id: "user_topic_1",
        },
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "om_topic_root",
        ThreadHistoryBody: "assistant reply\n\nfollow-up question",
        ThreadLabel: "Feishu thread in oc-group",
        ThreadStarterBody: "root starter",
      }),
    );
  });

  it("filters topic bootstrap context to allowlisted group senders", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      chatId: "oc-group",
      content: "blocked root starter",
      contentType: "text",
      messageId: "om_topic_root",
      senderId: "ou-blocked",
      senderType: "user",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        content: "blocked follow-up",
        contentType: "text",
        createTime: 1_710_000_000_000,
        messageId: "om_blocked_reply",
        senderId: "ou-blocked",
        senderType: "user",
      },
      {
        content: "assistant reply",
        contentType: "text",
        createTime: 1_710_000_001_000,
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
      },
      {
        content: "allowed follow-up",
        contentType: "text",
        createTime: 1_710_000_002_000,
        messageId: "om_allowed_reply",
        senderId: "ou-allowed",
        senderType: "user",
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          contextVisibility: "allowlist",
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              groupSessionScope: "group_topic",
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-group",
        chat_type: "group",
        content: JSON.stringify({ text: "current turn" }),
        message_id: "om_topic_followup_allowlisted",
        message_type: "text",
        root_id: "om_topic_root",
        thread_id: "omt_topic_1",
      },
      sender: { sender_id: { open_id: "ou-allowed" } },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ThreadHistoryBody: "assistant reply\n\nallowed follow-up",
        ThreadStarterBody: "assistant reply",
      }),
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-dm",
        chat_type: "p2p",
        content: JSON.stringify({
          image_key: "img_dedup_payload",
        }),
        message_id: "msg-image-dedup",
        message_type: "image",
      },
      sender: {
        sender_id: {
          open_id: "ou-image-dedup",
        },
      },
    };

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});
