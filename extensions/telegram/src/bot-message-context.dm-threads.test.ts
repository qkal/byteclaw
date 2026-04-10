import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { recordInboundSessionMock } = vi.hoisted(() => ({
  recordInboundSessionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./bot-message-context.session.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.session.runtime.js")>(
    "./bot-message-context.session.runtime.js",
  );
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: "hello",
    canDetectMention: false,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    historyKey: undefined,
    locationData: undefined,
    rawBody: "hello",
    shouldBypassMention: false,
    stickerCacheHit: false,
  }),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");
const { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
  await import("openclaw/plugin-sdk/config-runtime");

beforeEach(() => {
  clearRuntimeConfigSnapshot();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  recordInboundSessionMock.mockClear();
});

describe("buildTelegramMessageContext dm thread sessions", () => {
  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContextForTest({
      message,
    });

  it("uses thread session key for dm topics", async () => {
    const ctx = await buildContext({
      chat: { id: 1234, type: "private" },
      date: 1_700_000_000,
      from: { first_name: "Alice", id: 42 },
      message_id: 1,
      message_thread_id: 42,
      text: "hello",
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:1234:42");
  });

  it("keeps legacy dm session key when no thread id", async () => {
    const ctx = await buildContext({
      chat: { id: 1234, type: "private" },
      date: 1_700_000_001,
      from: { first_name: "Alice", id: 42 },
      message_id: 2,
      text: "hello",
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});

describe("buildTelegramMessageContext group sessions without forum", () => {
  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContextForTest({
      message,
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

  it("ignores message_thread_id for regular groups (not forums)", async () => {
    // When someone replies to a message in a non-forum group, Telegram sends
    // Message_thread_id but this should NOT create a separate session
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1_001_234_567_890, title: "Test Group", type: "supergroup" },
      date: 1_700_000_000,
      text: "@bot hello",
      message_thread_id: 42, // This is a reply thread, NOT a forum topic
      from: { first_name: "Alice", id: 42 },
    });

    expect(ctx).not.toBeNull();
    // Session key should NOT include :topic:42
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890");
    // MessageThreadId should be undefined (not a forum)
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
  });

  it("keeps same session for regular group with and without message_thread_id", async () => {
    const ctxWithThread = await buildContext({
      chat: { id: -1_001_234_567_890, title: "Test Group", type: "supergroup" },
      date: 1_700_000_000,
      from: { first_name: "Alice", id: 42 },
      message_id: 1,
      message_thread_id: 42,
      text: "@bot hello",
    });

    const ctxWithoutThread = await buildContext({
      chat: { id: -1_001_234_567_890, title: "Test Group", type: "supergroup" },
      date: 1_700_000_001,
      from: { first_name: "Alice", id: 42 },
      message_id: 2,
      text: "@bot world",
    });

    expect(ctxWithThread).not.toBeNull();
    expect(ctxWithoutThread).not.toBeNull();
    // Both messages should use the same session key
    expect(ctxWithThread?.ctxPayload?.SessionKey).toBe(ctxWithoutThread?.ctxPayload?.SessionKey);
  });

  it("uses topic session for forum groups with message_thread_id", async () => {
    const ctx = await buildContext({
      chat: { id: -1_001_234_567_890, is_forum: true, title: "Test Forum", type: "supergroup" },
      date: 1_700_000_000,
      from: { first_name: "Alice", id: 42 },
      message_id: 1,
      message_thread_id: 99,
      text: "@bot hello",
    });

    expect(ctx).not.toBeNull();
    // Session key SHOULD include :topic:99 for forums
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(99);
  });
});

describe("buildTelegramMessageContext direct peer routing", () => {
  it("isolates dm sessions by sender id when chat id differs", async () => {
    const runtimeCfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
      session: { dmScope: "per-channel-peer" as const },
    };
    setRuntimeConfigSnapshot(runtimeCfg);

    const baseMessage = {
      chat: { id: 777_777_777, type: "private" as const },
      date: 1_700_000_000,
      text: "hello",
    };

    const first = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        from: { first_name: "Alice", id: 123_456_789 },
        message_id: 1,
      },
    });
    const second = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        from: { first_name: "Bob", id: 987_654_321 },
        message_id: 2,
      },
    });

    expect(first?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:123456789");
    expect(second?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:987654321");
  });
});
