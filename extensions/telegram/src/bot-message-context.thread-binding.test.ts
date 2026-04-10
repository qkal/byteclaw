import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const recordInboundSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveTelegramConversationRouteMock = vi.hoisted(() => vi.fn());

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

function createBoundRoute(params: { accountId: string; sessionKey: string; agentId: string }) {
  return {
    configuredBinding: null,
    configuredBindingSessionKey: "",
    route: {
      accountId: params.accountId,
      agentId: params.agentId,
      channel: "telegram",
      lastRoutePolicy: "bound",
      mainSessionKey: `agent:${params.agentId}:main`,
      matchedBy: "binding.channel",
      sessionKey: params.sessionKey,
    },
  } as const;
}

describe("buildTelegramMessageContext thread binding override", () => {
  beforeEach(() => {
    recordInboundSessionMock.mockClear();
    resolveTelegramConversationRouteMock.mockReset();
  });

  it("passes forum topic messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        agentId: "codex-acp",
        sessionKey: "agent:codex-acp:session-1",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -100_200_300, is_forum: true, type: "supergroup" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 1,
        message_thread_id: 77,
        text: "hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        chatId: -100_200_300,
        isGroup: true,
        replyThreadId: 77,
        resolvedThreadId: 77,
        senderId: "42",
      }),
    );
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-1");
    expect(recordInboundSessionMock.mock.calls[0]?.[0]).toMatchObject({
      updateLastRoute: undefined,
    });
  });

  it("treats named-account bound conversations as explicit route matches", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "work",
        agentId: "codex-acp",
        sessionKey: "agent:codex-acp:session-2",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      accountId: "work",
      message: {
        chat: { id: -100_200_300, is_forum: true, type: "supergroup" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 1,
        message_thread_id: 77,
        text: "hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        chatId: -100_200_300,
        isGroup: true,
        replyThreadId: 77,
        resolvedThreadId: 77,
        senderId: "42",
      }),
    );
    expect(ctx).not.toBeNull();
    expect(ctx?.route.accountId).toBe("work");
    expect(ctx?.route.matchedBy).toBe("binding.channel");
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-2");
  });

  it("passes dm messages through the route seam and uses the bound session", async () => {
    resolveTelegramConversationRouteMock.mockReturnValue(
      createBoundRoute({
        accountId: "default",
        agentId: "codex-acp",
        sessionKey: "agent:codex-acp:session-dm",
      }),
    );

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Alice", id: 42 },
        message_id: 1,
        text: "hello",
      },
    });

    expect(resolveTelegramConversationRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        chatId: 1234,
        isGroup: false,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        senderId: "42",
      }),
    );
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:codex-acp:session-dm");
  });
});
