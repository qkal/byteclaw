import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { handleSubagentsFocusAction } from "./commands-subagents/action-focus.js";
import { handleSubagentsUnfocusAction } from "./commands-subagents/action-unfocus.js";
import type { HandleCommandsParams } from "./commands-types.js";
import type { InlineDirectives } from "./directive-handling.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

const hoisted = vi.hoisted(() => ({
  readAcpSessionEntryMock: vi.fn(),
  resolveConversationBindingContextMock: vi.fn(),
  resolveFocusTargetSessionMock: vi.fn(),
  sessionBindingBindMock: vi.fn(),
  sessionBindingCapabilitiesMock: vi.fn(),
  sessionBindingResolveByConversationMock: vi.fn(),
  sessionBindingUnbindMock: vi.fn(),
}));

function buildFocusSessionBindingService() {
  return {
    bind(input: unknown) {
      return hoisted.sessionBindingBindMock(input);
    },
    getCapabilities(params: unknown) {
      return hoisted.sessionBindingCapabilitiesMock(params);
    },
    listBySession: vi.fn(),
    resolveByConversation(ref: unknown) {
      return hoisted.sessionBindingResolveByConversationMock(ref);
    },
    touch: vi.fn(),
    unbind(input: unknown) {
      return hoisted.sessionBindingUnbindMock(input);
    },
  };
}

vi.mock("../../acp/runtime/session-identifiers.js", () => ({
  resolveAcpSessionCwd: () => undefined,
  resolveAcpThreadSessionDetailLines: (params: {
    meta?: { identity?: Record<string, unknown> };
  }) => {
    const identity = params.meta?.identity ?? {};
    const lines: string[] = [];
    if (typeof identity.agentSessionId === "string") {
      lines.push(`agent session id: ${identity.agentSessionId}`);
      lines.push(`codex resume ${identity.agentSessionId}`);
    }
    if (typeof identity.acpxSessionId === "string") {
      lines.push(`acpx session id: ${identity.acpxSessionId}`);
    }
    return lines;
  },
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
}));

vi.mock("../../channels/thread-bindings-messages.js", () => ({
  resolveThreadBindingIntroText: (params: { agentId: string; sessionDetails?: string[] }) =>
    [
      `⚙️ ${params.agentId} session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.`,
      ...(params.sessionDetails ?? []),
    ].join("\n"),
  resolveThreadBindingThreadName: (params: { label?: string; agentId: string }) =>
    params.label ?? params.agentId,
}));

vi.mock("../../channels/thread-bindings-policy.js", () => ({
  formatThreadBindingDisabledError: (params: { channel: string }) =>
    `channels.${params.channel}.threadBindings.enabled=true required`,
  formatThreadBindingSpawnDisabledError: (params: { channel: string }) =>
    `channels.${params.channel}.threadBindings.spawnSubagentSessions=true`,
  resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
  resolveThreadBindingMaxAgeMsForChannel: () => undefined,
  resolveThreadBindingPlacementForCurrentContext: (params: {
    channel: string;
    threadId?: string;
  }) => (params.channel === ROOM_CHANNEL && !params.threadId ? "child" : "current"),
  resolveThreadBindingSpawnPolicy: (params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
  }) => {
    const settings = params.cfg.channels?.[params.channel]?.threadBindings;
    return {
      accountId: params.accountId,
      channel: params.channel,
      enabled: settings?.enabled !== false,
      spawnEnabled: settings?.spawnSubagentSessions === true,
    };
  },
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => buildFocusSessionBindingService(),
}));

vi.mock("./conversation-binding-input.js", () => ({
  resolveConversationBindingContextFromAcpCommand: (params: unknown) =>
    hoisted.resolveConversationBindingContextMock(params),
}));

vi.mock("./commands-subagents/shared.js", async () => {
  const actual = await vi.importActual<typeof import("./commands-subagents/shared.js")>(
    "./commands-subagents/shared.js",
  );
  return {
    ...actual,
    resolveFocusTargetSession: (params: unknown) => hoisted.resolveFocusTargetSessionMock(params),
  };
});

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createSessionBindingRecord(
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    boundAt: Date.now(),
    conversation: {
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    metadata: {
      agentId: "codex-acp",
      boundBy: "user-1",
    },
    status: "active",
    targetKind: "session",
    targetSessionKey: "agent:codex-acp:session-1",
    ...overrides,
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    placements: ["current", "child"] as const,
    unbindSupported: true,
  };
}

function buildCommandParams(params?: {
  cfg?: OpenClawConfig;
  chatType?: string;
  senderId?: string;
  sessionEntry?: SessionEntry;
}): HandleCommandsParams {
  const directives: InlineDirectives = {
    cleaned: "",
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasExecOptions: false,
    hasFastDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    hasQueueOptions: false,
    hasReasoningDirective: false,
    hasStatusDirective: false,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    invalidExecAsk: false,
    invalidExecHost: false,
    invalidExecNode: false,
    invalidExecSecurity: false,
    queueReset: false,
  };
  return {
    cfg: params?.cfg ?? baseCfg,
    command: {
      channel: "whatsapp",
      commandBodyNormalized: "",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: "",
      senderId: params?.senderId ?? "user-1",
      senderIsOwner: true,
      surface: "whatsapp",
    },
    contextTokens: 0,
    ctx: {
      ChatType: params?.chatType ?? "group",
    },
    defaultGroupActivation: () => "mention",
    directives,
    elevated: { allowed: false, enabled: false, failures: [] },
    isGroup: true,
    model: "test-model",
    provider: "whatsapp",
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionEntry: params?.sessionEntry,
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-subagents-focus",
  };
}

function buildFocusContext(params?: {
  cfg?: OpenClawConfig;
  chatType?: string;
  senderId?: string;
  token?: string;
}) {
  return {
    handledPrefix: "/focus",
    params: buildCommandParams({
      cfg: params?.cfg,
      chatType: params?.chatType,
      senderId: params?.senderId,
    }),
    requesterKey: "agent:main:main",
    restTokens: [params?.token ?? "codex-acp"],
    runs: [],
  } satisfies Parameters<typeof handleSubagentsFocusAction>[0];
}

function buildUnfocusContext(params?: { senderId?: string }) {
  return {
    handledPrefix: "/unfocus",
    params: buildCommandParams({
      senderId: params?.senderId,
    }),
    requesterKey: "agent:main:main",
    restTokens: [],
    runs: [],
  } satisfies Parameters<typeof handleSubagentsUnfocusAction>[0];
}

describe("focus actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.sessionBindingCapabilitiesMock.mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(null);
    hoisted.resolveFocusTargetSessionMock.mockResolvedValue({
      agentId: "codex-acp",
      label: "codex-acp",
      targetKind: "acp",
      targetSessionKey: "agent:codex-acp:session-1",
    });
    hoisted.sessionBindingBindMock.mockImplementation(
      async (input: {
        targetSessionKey: string;
        placement: "current" | "child";
        conversation: {
          channel: string;
          accountId: string;
          conversationId: string;
          parentConversationId?: string;
        };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBindingRecord({
          conversation: {
            accountId: input.conversation.accountId,
            channel: input.conversation.channel,
            conversationId:
              input.placement === "child" ? "thread-created" : input.conversation.conversationId,
            ...(input.conversation.parentConversationId
              ? { parentConversationId: input.conversation.parentConversationId }
              : {}),
          },
          metadata: {
            ...input.metadata,
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1",
          },
          targetKind: "session",
          targetSessionKey: input.targetSessionKey,
        }),
    );
  });

  it("binds the current thread-chat thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    expect(result.reply?.text).toContain("(acp)");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          channel: THREAD_CHANNEL,
          conversationId: "thread-1",
        }),
        placement: "current",
        targetKind: "session",
        targetSessionKey: "agent:codex-acp:session-1",
      }),
    );
  });

  it("binds topic-chat topics as current conversations", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: TOPIC_CHANNEL,
      conversationId: "-100200300:topic:77",
      parentConversationId: "-100200300",
      threadId: "77",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          channel: TOPIC_CHANNEL,
          conversationId: "-100200300:topic:77",
        }),
        placement: "current",
      }),
    );
  });

  it("creates a room-chat child thread from a top-level room when spawning is enabled", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "!room:example.org",
    });

    const result = await handleSubagentsFocusAction(
      buildFocusContext({
        cfg: {
          ...baseCfg,
          channels: {
            [ROOM_CHANNEL]: {
              threadBindings: {
                enabled: true,
                spawnSubagentSessions: true,
              },
            },
          } as OpenClawConfig["channels"],
        } as OpenClawConfig,
      }),
    );

    expect(result.reply?.text).toContain("created child conversation thread-created and bound it");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          channel: ROOM_CHANNEL,
          conversationId: "!room:example.org",
        }),
        placement: "child",
      }),
    );
  });

  it("treats a room thread turn as the current thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$root",
      parentConversationId: "!room:example.org",
      threadId: "$root",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          channel: ROOM_CHANNEL,
          conversationId: "$root",
          parentConversationId: "!room:example.org",
        }),
        placement: "current",
      }),
    );
  });

  it("rejects room top-level thread creation when spawnSubagentSessions is disabled", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "!room:example.org",
    });

    const result = await handleSubagentsFocusAction(
      buildFocusContext({
        cfg: {
          ...baseCfg,
          channels: {
            [ROOM_CHANNEL]: {
              threadBindings: {
                enabled: true,
              },
            },
          } as OpenClawConfig["channels"],
        } as OpenClawConfig,
      }),
    );

    expect(result.reply?.text).toContain(
      `channels.${ROOM_CHANNEL}.threadBindings.spawnSubagentSessions=true`,
    );
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("includes ACP session identifiers in intro text when available", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: {
        identity: {
          acpxSessionId: "acpx-456",
          agentSessionId: "codex-123",
        },
      },
    });

    await handleSubagentsFocusAction(buildFocusContext());

    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("agent session id: codex-123"),
        }),
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("acpx session id: acpx-456"),
        }),
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("codex resume codex-123"),
        }),
      }),
    );
  });

  it("rejects rebinding when another user owns the thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        metadata: { boundBy: "user-2" },
      }),
    );

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("Only user-2 can refocus this conversation.");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported channels", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue(null);

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("must be run inside a bindable conversation");
  });

  it("unfocuses the active binding for the binding owner", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:thread-1",
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsUnfocusAction(buildUnfocusContext());

    expect(result.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:thread-1",
      reason: "manual",
    });
  });

  it("unfocuses an active room thread binding for the binding owner", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
      threadId: "$thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:room-thread-1",
        conversation: {
          accountId: "default",
          channel: ROOM_CHANNEL,
          conversationId: "$thread-1",
          parentConversationId: "!room:example.org",
        },
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsUnfocusAction(buildUnfocusContext());

    expect(result.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    });
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:room-thread-1",
      reason: "manual",
    });
  });
});
