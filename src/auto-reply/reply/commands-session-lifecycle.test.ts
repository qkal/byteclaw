import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

interface ResolveCommandConversationParams {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}

function firstText(values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean) || undefined;
}

function resolveThreadTargetId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^thread-chat:/i, "")
    .replace(/^channel:/i, "")
    .trim();
}

function resolveThreadCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveThreadTargetId(params.threadParentId),
    resolveThreadTargetId(params.originatingTo),
    resolveThreadTargetId(params.commandTo),
    resolveThreadTargetId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveRoomId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^room-chat:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function resolveRoomCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveRoomId(params.originatingTo),
    resolveRoomId(params.commandTo),
    resolveRoomId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveTopicCommandConversation(params: ResolveCommandConversationParams) {
  const chatId = firstText([params.originatingTo, params.commandTo, params.fallbackTo])
    ?.replace(/^topic-chat:/i, "")
    .trim();
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

const hoisted = vi.hoisted(() => {
  const threadChannel = "thread-chat";
  const roomChannel = "room-chat";
  const topicChannel = "topic-chat";
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const runtimeChannelRegistry = {
    channels: [
      {
        plugin: {
          bindings: {
            resolveCommandConversation: resolveThreadCommandConversation,
          },
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            setIdleTimeoutBySessionKey: setThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setThreadBindingMaxAgeBySessionKeyMock,
            supportsCurrentConversationBinding: true,
          },
          id: threadChannel,
          meta: {},
        },
      },
      {
        plugin: {
          bindings: {
            resolveCommandConversation: resolveRoomCommandConversation,
          },
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            setIdleTimeoutBySessionKey: setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setMatrixThreadBindingMaxAgeBySessionKeyMock,
            supportsCurrentConversationBinding: true,
          },
          id: roomChannel,
          meta: {},
        },
      },
      {
        plugin: {
          bindings: {
            resolveCommandConversation: resolveTopicCommandConversation,
          },
          config: {
            hasPersistedAuthState: () => false,
          },
          conversationBindings: {
            setIdleTimeoutBySessionKey: setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setTelegramThreadBindingMaxAgeBySessionKeyMock,
            supportsCurrentConversationBinding: true,
          },
          id: topicChannel,
          meta: {},
        },
      },
    ],
  };
  return {
    runtimeChannelRegistry,
    sessionBindingResolveByConversationMock,
    setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    setMatrixThreadBindingMaxAgeBySessionKeyMock,
    setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKeyMock,
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
  };
});

vi.mock("../../plugins/runtime.js", () => ({
    getActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginChannelRegistryVersion: () => 1,
    getActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginRegistryVersion: () => 1,
    requireActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
  }));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  normalizeChannelId: (raw?: string | null) => {
    const normalized = raw?.trim().toLowerCase();
    return normalized || null;
  },
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs: number;
  }) => {
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingIdleTimeoutBySessionKeyMock({
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock({
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock({
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    return [];
  },
  setChannelConversationBindingMaxAgeBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => {
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingMaxAgeBySessionKeyMock({
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock({
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock({
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
        targetSessionKey: params.targetSessionKey,
      });
    }
    return [];
  },
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: vi.fn(),
    }),
  }));

let handleSessionCommand: (typeof import("./commands-session.js"))["handleSessionCommand"];
const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildSessionCommandParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandAuthorized: true,
    CommandBody: commandBody,
    CommandSource: "text",
    From: "+1222",
    Provider: "whatsapp",
    SenderId: "user-1",
    Surface: "whatsapp",
    To: "+1222",
    ...ctxOverrides,
  } as HandleCommandsParams["ctx"];
  const channel = String(ctx.Provider ?? ctx.Surface ?? "")
    .trim()
    .toLowerCase();
  const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : undefined;
  return {
    cfg: baseCfg,
    command: {
      abortKey: senderId,
      channel,
      channelId: channel,
      commandBodyNormalized: commandBody.trim().toLowerCase(),
      from: typeof ctx.From === "string" ? ctx.From : undefined,
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: commandBody.trim(),
      senderId,
      senderIsOwner: false,
      surface: String(ctx.Surface ?? ctx.Provider ?? "")
        .trim()
        .toLowerCase(),
      to: typeof ctx.To === "string" ? ctx.To : undefined,
    },
    contextTokens: 0,
    ctx,
    defaultGroupActivation: () => "mention",
    directives: parseInlineDirectives(commandBody),
    elevated: { allowed: true, enabled: true, failures: [] },
    isGroup: false,
    model: "test-model",
    provider: channel,
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
  };
}

function createThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    AccountId: "default",
    MessageThreadId: "thread-1",
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:thread-1",
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    ...overrides,
  });
}

function createTopicCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    AccountId: "default",
    MessageThreadId: "77",
    OriginatingChannel: TOPIC_CHANNEL,
    OriginatingTo: "-100200300:topic:77",
    Provider: TOPIC_CHANNEL,
    Surface: TOPIC_CHANNEL,
    ...overrides,
  });
}

function createRoomThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    AccountId: "default",
    MessageThreadId: "$thread-1",
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    ...overrides,
  });
}

function createRoomTriggerThreadCommandParams(
  commandBody: string,
  overrides?: Record<string, unknown>,
) {
  return buildSessionCommandParams(commandBody, {
    AccountId: "default",
    MessageThreadId: "$root",
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    ...overrides,
  });
}

function createRoomCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    AccountId: "default",
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    ...overrides,
  });
}

function createThreadBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    boundAt: Date.now(),
    conversation: {
      accountId: "default",
      channel: THREAD_CHANNEL,
      conversationId: "thread-1",
      parentConversationId: "thread-1",
    },
    metadata: {
      boundBy: "user-1",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
      maxAgeMs: 0,
    },
    status: "active",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    ...overrides,
  };
}

function createTopicBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:-100200300:topic:77",
    boundAt: Date.now(),
    conversation: {
      accountId: "default",
      channel: TOPIC_CHANNEL,
      conversationId: "-100200300:topic:77",
    },
    metadata: {
      boundBy: "user-1",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
      maxAgeMs: 0,
    },
    status: "active",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    ...overrides,
  };
}

function createRoomBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:$thread-1",
    boundAt: Date.now(),
    conversation: {
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    },
    metadata: {
      boundBy: "user-1",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      lastActivityAt: Date.now(),
      maxAgeMs: 0,
    },
    status: "active",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    ...overrides,
  };
}

function createRoomTriggerBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createRoomBinding({
    bindingId: "default:$root",
    conversation: {
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    },
    ...overrides,
  });
}

function expectIdleTimeoutSetReply(
  mock: ReturnType<typeof vi.fn>,
  text: string,
  idleTimeoutMs: number,
  idleTimeoutLabel: string,
) {
  expect(mock).toHaveBeenCalledWith({
    accountId: "default",
    idleTimeoutMs,
    targetSessionKey: "agent:main:subagent:child",
  });
  expect(text).toContain(`Idle timeout set to ${idleTimeoutLabel}`);
  expect(text).toContain("2026-02-20T02:00:00.000Z");
}

describe("/session idle and /session max-age", () => {
  beforeEach(async () => {
    if (!handleSessionCommand) {
      ({ handleSessionCommand } = await import("./commands-session.js"));
    }
  });

  beforeEach(() => {
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        lastActivityAt: Date.now(),
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(createThreadCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          idleTimeoutMs: 2 * 60 * 60 * 1000,
          lastActivityAt: Date.now(),
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("sets max age for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T03:00:00.000Z");
  });

  it("sets idle timeout for focused topic-chat conversations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createTopicBinding());
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        lastActivityAt: Date.now(),
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(createTopicCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        lastActivityAt: Date.now(),
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for the triggering room-chat always-thread turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomTriggerBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
        lastActivityAt: Date.now(),
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createRoomTriggerThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      accountId: "default",
      channel: ROOM_CHANNEL,
      conversationId: "$root",
      parentConversationId: "!room:example.org",
      threadId: "$root",
    });
    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets max age for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding({ boundAt }));
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("reports topic-chat max-age expiry from the original bind time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createTopicBinding({ boundAt }),
    );
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createTopicCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("disables max age when set to off", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          lastActivityAt: Date.now(),
          maxAgeMs: 2 * 60 * 60 * 1000,
        },
      }),
    );
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 0,
        targetSessionKey: "agent:main:subagent:child",
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age off"),
      true,
    );

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      accountId: "default",
      maxAgeMs: 0,
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(result?.reply?.text).toContain("Max age disabled");
  });

  it("is unavailable outside bindable channels", async () => {
    const params = buildSessionCommandParams("/session idle 2h");
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain(
      "currently available only on channels that support focused conversation bindings",
    );
  });

  it("requires a focused room-chat thread for lifecycle updates", async () => {
    const result = await handleSessionCommand(createRoomCommandParams("/session idle 2h"), true);

    expect(result?.reply?.text).toContain("This conversation is not currently focused.");
    expect(hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });

  it("requires binding owner for lifecycle updates", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "owner-1",
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          lastActivityAt: Date.now(),
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(
      createThreadCommandParams("/session idle 2h", {
        SenderId: "other-user",
      }),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Only owner-1 can update session lifecycle settings");
  });
});
