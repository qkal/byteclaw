import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedDispatchParams: unknown;

const { dispatchReplyWithBufferedBlockDispatcherMock } = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: { ctx: unknown }) => {
    capturedDispatchParams = params;
    return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
  }),
}));

vi.mock("./runtime-api.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
  finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ({
    ...ctx,
    BodyForCommands:
      typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.BodyForAgent === "string"
          ? ctx.BodyForAgent
          : "",
  }),
  getAgentScopedMediaLocalRoots: () => [],
  jidToE164: (value: string) => {
    const phone = value.split("@")[0]?.replace(/[^\d]/g, "");
    return phone ? `+${phone}` : null;
  },
  logVerbose: () => {},
  resolveChunkMode: () => "length",
  resolveIdentityNamePrefix: (cfg: {
    agents?: { list?: { id?: string; default?: boolean; identity?: { name?: string } }[] };
  }) => {
    const agent = cfg.agents?.list?.find((entry) => entry.default) ?? cfg.agents?.list?.[0];
    const name = agent?.identity?.name?.trim();
    return name ? `[${name}]` : undefined;
  },
  resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
  resolveMarkdownTableMode: () => undefined,
  resolveSendableOutboundReplyParts: (payload: { text?: string }) => ({
    hasMedia: false,
    text: payload.text ?? "",
  }),
  resolveTextChunkLimit: () => 4000,
  shouldLogVerbose: () => false,
  toLocationContext: () => ({}),
}));

import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof buildWhatsAppInboundContext>[0]["route"];
type TestMsg = Parameters<typeof buildWhatsAppInboundContext>[0]["msg"];

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    accountId: "default",
    agentId: "main",
    channel: "whatsapp",
    lastRoutePolicy: "main",
    mainSessionKey: "agent:main:whatsapp:direct:+1000",
    matchedBy: "default",
    sessionKey: "agent:main:whatsapp:direct:+1000",
    ...overrides,
  };
}

function makeMsg(overrides: Partial<TestMsg> = {}): TestMsg {
  return {
    accountId: "default",
    body: "hi",
    chatId: "+1000",
    chatType: "direct",
    conversationId: "+1000",
    from: "+1000",
    id: "msg1",
    reply: async () => {},
    sendComposing: async () => {},
    sendMedia: async () => {},
    to: "+2000",
    ...overrides,
  };
}

function getCapturedDeliver() {
  return (
    capturedDispatchParams as {
      dispatcherOptions?: {
        deliver?: (
          payload: { text?: string; isReasoning?: boolean; isCompactionNotice?: boolean },
          info: { kind: "tool" | "block" | "final" },
        ) => Promise<void>;
      };
    }
  )?.dispatcherOptions?.deliver;
}

type BufferedReplyParams = Parameters<typeof dispatchWhatsAppBufferedReply>[0];

function makeReplyLogger(): BufferedReplyParams["replyLogger"] {
  return {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  } as never;
}

async function dispatchBufferedReply(overrides: Partial<BufferedReplyParams> = {}) {
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
    connectionId: "conn",
    context: { Body: "hi" },
    conversationId: "+1000",
    deliverReply: async () => {},
    groupHistories: new Map(),
    groupHistoryKey: "+1000",
    maxMediaBytes: 1,
    msg: makeMsg(),
    rememberSentText: () => {},
    replyLogger: makeReplyLogger(),
    replyPipeline: {} as never,
    replyResolver: (async () => undefined) as never,
    route: makeRoute(),
    shouldClearGroupHistory: false,
  };

  return dispatchWhatsAppBufferedReply({ ...params, ...overrides });
}

describe("whatsapp inbound dispatch", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
  });

  it("builds a finalized inbound context payload", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "Alice: hi",
      conversationId: "123@g.us",
      groupHistory: [],
      groupMemberRoster: new Map(),
      msg: makeMsg({
        chatType: "group",
        from: "123@g.us",
        groupParticipants: [],
        groupSubject: "Test Group",
        senderE164: "+15550002222",
        senderJid: "alice@s.whatsapp.net",
        senderName: "Alice",
        timestamp: 1_737_158_400_000,
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      sender: {
        e164: "+15550002222",
        name: "Alice",
      },
    });

    expect(ctx).toMatchObject({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      BodyForCommands: "hi",
      CommandBody: "hi",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
      RawBody: "hi",
      SenderE164: "+15550002222",
      SenderId: "+15550002222",
      Timestamp: 1_737_158_400_000,
    });
  });

  it("falls back SenderId to SenderE164 when sender id is missing", () => {
    const ctx = buildWhatsAppInboundContext({
      combinedBody: "hi",
      conversationId: "+1000",
      msg: makeMsg({
        senderE164: "+1000",
        senderJid: "",
      }),
      route: makeRoute(),
      sender: {
        e164: "+1000",
      },
    });

    expect(ctx.SenderId).toBe("+1000");
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.To).toBe("+2000");
  });

  it("defaults responsePrefix to identity name in self-chats when unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      agentId: "main",
      cfg: {
        agents: {
          list: [
            {
              default: true,
              id: "main",
              identity: { emoji: "🦞", name: "Mainbot", theme: "space lobster" },
            },
          ],
        },
        messages: {},
      } as never,
      isSelfChat: true,
    });

    expect(responsePrefix).toBe("[Mainbot]");
  });

  it("does not force a response prefix in self-chats when identity is unset", () => {
    const responsePrefix = resolveWhatsAppResponsePrefix({
      agentId: "main",
      cfg: { messages: {} } as never,
      isSelfChat: true,
    });

    expect(responsePrefix).toBeUndefined();
  });

  it("clears pending group history when the dispatcher does not queue a final reply", async () => {
    const groupHistories = new Map<string, { sender: string; body: string }[]>([
      ["whatsapp:default:group:123@g.us", [{ body: "first", sender: "Alice (+111)" }]],
    ]);

    await dispatchBufferedReply({
      context: { Body: "second" },
      conversationId: "123@g.us",
      groupHistories,
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      msg: makeMsg({
        chatType: "group",
        from: "123@g.us",
        senderE164: "+222",
      }),
      route: makeRoute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }),
      shouldClearGroupHistory: true,
    });

    expect(groupHistories.get("whatsapp:default:group:123@g.us") ?? []).toHaveLength(0);
  });

  it("delivers block and final WhatsApp payloads, but suppresses tool payloads", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ text: "tool payload" }, { kind: "tool" });
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();

    await deliver?.({ text: "block payload" }, { kind: "block" });
    await deliver?.({ text: "final payload" }, { kind: "final" });
    expect(deliverReply).toHaveBeenCalledTimes(2);
    expect(rememberSentText).toHaveBeenCalledTimes(2);
  });

  it("suppresses reasoning and compaction payloads before WhatsApp delivery", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();

    await dispatchBufferedReply({
      deliverReply,
      rememberSentText,
    });

    const deliver = getCapturedDeliver();
    expect(deliver).toBeTypeOf("function");

    await deliver?.({ isReasoning: true, text: "Reasoning:\n_hidden_" }, { kind: "block" });
    await deliver?.(
      { isCompactionNotice: true, text: "🧹 Compacting context..." },
      { kind: "block" },
    );
    expect(deliverReply).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
  });

  it("maps WhatsApp blockStreaming=true to disableBlockStreaming=false", async () => {
    await dispatchBufferedReply();

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(false);
  });

  it("maps WhatsApp blockStreaming=false to disableBlockStreaming=true", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: { blockStreaming: false } } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBe(true);
  });

  it("leaves disableBlockStreaming undefined when WhatsApp blockStreaming is unset", async () => {
    await dispatchBufferedReply({
      cfg: { channels: { whatsapp: {} } } as never,
    });

    expect(
      (
        capturedDispatchParams as {
          replyOptions?: { disableBlockStreaming?: boolean };
        }
      )?.replyOptions?.disableBlockStreaming,
    ).toBeUndefined();
  });

  it("treats block-only turns as visible replies instead of silent turns", async () => {
    const deliverReply = vi.fn(async () => undefined);
    const rememberSentText = vi.fn();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: {
        ctx: unknown;
        dispatcherOptions?: {
          deliver?: (
            payload: { text?: string },
            info: { kind: "tool" | "block" | "final" },
          ) => Promise<void>;
        };
      }) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "partial block" }, { kind: "block" });
        return { counts: { block: 1, final: 0, tool: 0 }, queuedFinal: false };
      },
    );

    await expect(
      dispatchBufferedReply({
        deliverReply,
        rememberSentText,
      }),
    ).resolves.toBe(true);

    expect(deliverReply).toHaveBeenCalledTimes(1);
    expect(rememberSentText).toHaveBeenCalledTimes(1);
  });

  it("passes sendComposing through as the reply typing callback", async () => {
    const sendComposing = vi.fn(async () => undefined);

    await dispatchBufferedReply({
      msg: makeMsg({ sendComposing }),
    });

    expect(
      (
        capturedDispatchParams as {
          dispatcherOptions?: { onReplyStart?: unknown };
        }
      )?.dispatcherOptions?.onReplyStart,
    ).toBe(sendComposing);
  });

  it("updates main last route for DM when session key matches main session key", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: null,
      route: makeRoute(),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("does not update main last route for isolated DM scope sessions", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: null,
      route: makeRoute({
        mainSessionKey: "agent:main:whatsapp:direct:+1000",
        sessionKey: "agent:main:whatsapp:dm:+1000:peer:+3000",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("does not update main last route for non-owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+3000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        mainSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).not.toHaveBeenCalled();
  });

  it("updates main last route for owner sender when main DM scope is pinned", () => {
    const updateLastRoute = vi.fn();

    updateWhatsAppMainLastRoute({
      backgroundTasks: new Set(),
      cfg: {} as never,
      ctx: { Body: "hello" },
      dmRouteTarget: "+1000",
      pinnedMainDmRecipient: "+1000",
      route: makeRoute({
        mainSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      }),
      updateLastRoute,
      warn: () => {},
    });

    expect(updateLastRoute).toHaveBeenCalledTimes(1);
  });

  it("resolves DM route targets from the sender first and the chat JID second", () => {
    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        normalizeE164: (value) => value,
        senderE164: "+15550002222",
      }),
    ).toBe("+15550002222");

    expect(
      resolveWhatsAppDmRouteTarget({
        msg: makeMsg({ from: "15550003333@s.whatsapp.net" }),
        normalizeE164: () => null,
      }),
    ).toBe("+15550003333");
  });
});
