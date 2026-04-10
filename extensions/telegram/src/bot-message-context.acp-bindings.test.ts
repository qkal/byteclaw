import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const recordInboundSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveTelegramConversationRouteMock = vi.hoisted(() => vi.fn());

vi.mock("./bot-message-context.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.runtime.js")>(
    "./bot-message-context.runtime.js",
  );
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
      ensureConfiguredBindingRouteReadyMock(...args),
  };
});
vi.mock("./bot-message-context.session.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.session.runtime.js")>(
    "./bot-message-context.session.runtime.js",
  );
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});
vi.mock("./conversation-route.js", async () => {
  const actual =
    await vi.importActual<typeof import("./conversation-route.js")>("./conversation-route.js");
  return {
    ...actual,
    resolveTelegramConversationRoute: (...args: unknown[]) =>
      resolveTelegramConversationRouteMock(...args),
  };
});

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;

function createConfiguredTelegramBinding() {
  return {
    record: {
      bindingId: "config:acp:telegram:work:-1001234567890:topic:42",
      boundAt: 0,
      conversation: {
        accountId: "work",
        channel: "telegram",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      metadata: {
        agentId: "codex",
        mode: "persistent",
        source: "config",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: "agent:codex:acp:binding:telegram:work:abc123",
    },
    spec: {
      accountId: "work",
      agentId: "codex",
      channel: "telegram",
      conversationId: "-1001234567890:topic:42",
      mode: "persistent",
      parentConversationId: "-1001234567890",
    },
  } as const;
}

function createConfiguredTelegramRoute() {
  const configuredBinding = createConfiguredTelegramBinding();
  return {
    configuredBinding: {
      compiledBinding: {
        accountPattern: "work",
        agentId: "codex",
        binding: {
          agentId: "codex",
          match: {
            accountId: "work",
            channel: "telegram",
            peer: {
              id: "-1001234567890:topic:42",
              kind: "group",
            },
          },
          type: "acp",
        },
        bindingConversationId: "-1001234567890:topic:42",
        channel: "telegram",
        provider: {
          compileConfiguredBinding: () => ({
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
          }),
          matchInboundConversation: () => ({
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
          }),
        },
        target: {
          conversationId: "-1001234567890:topic:42",
          parentConversationId: "-1001234567890",
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: configuredBinding.record,
            statefulTarget: {
              agentId: configuredBinding.spec.agentId,
              driverId: "acp",
              kind: "stateful",
              sessionKey: configuredBinding.record.targetSessionKey,
            },
          }),
        },
      },
      conversation: {
        accountId: "work",
        channel: "telegram",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      match: {
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      record: configuredBinding.record,
      statefulTarget: {
        agentId: configuredBinding.spec.agentId,
        driverId: "acp",
        kind: "stateful",
        sessionKey: configuredBinding.record.targetSessionKey,
      },
    },
    configuredBindingSessionKey: configuredBinding.record.targetSessionKey,
    route: {
      accountId: "work",
      agentId: "codex",
      channel: "telegram",
      lastRoutePolicy: "bound",
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      sessionKey: configuredBinding.record.targetSessionKey,
    },
  } as const;
}

describe("buildTelegramMessageContext ACP configured bindings", () => {
  beforeAll(async () => {
    ({ buildTelegramMessageContextForTest } =
      await import("./bot-message-context.test-harness.js"));
  });

  beforeEach(() => {
    ensureConfiguredBindingRouteReadyMock.mockReset();
    recordInboundSessionMock.mockClear();
    resolveTelegramConversationRouteMock.mockReset();
    resolveTelegramConversationRouteMock.mockReturnValue(createConfiguredTelegramRoute());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
  });

  it("treats configured topic bindings as explicit route matches on non-default accounts", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "OpenClaw", type: "supergroup" },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.route.sessionKey).toBe("agent:codex:acp:binding:telegram:work:abc123");
    expect(recordInboundSessionMock.mock.calls[0]?.[0]).toMatchObject({
      updateLastRoute: undefined,
    });
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });

  it("skips ACP session initialization when topic access is denied", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "OpenClaw", type: "supergroup" },
        message_thread_id: 42,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { enabled: false },
      }),
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("defers ACP session initialization for unauthorized control commands", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      cfg: {
        channels: {
          telegram: {},
        },
        commands: {
          useAccessGroups: true,
        },
      },
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "OpenClaw", type: "supergroup" },
        message_thread_id: 42,
        text: "/new",
      },
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("drops inbound processing when configured ACP binding initialization fails", async () => {
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      error: "gateway unavailable",
      ok: false,
    });

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "OpenClaw", type: "supergroup" },
        message_thread_id: 42,
        text: "hello",
      },
    });

    expect(ctx).toBeNull();
    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
  });
});
