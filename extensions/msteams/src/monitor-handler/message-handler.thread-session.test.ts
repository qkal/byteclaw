import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../../runtime-api.js";
import type { MSTeamsConversationStore } from "../conversation-store.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.js";
import { setMSTeamsRuntime } from "../runtime.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    capturedCtxPayload: params.ctxPayload,
    counts: {},
    queuedFinal: false,
  })),
}));

vi.mock("../../runtime-api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../runtime-api.js")>("../../runtime-api.js");
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
  };
});

vi.mock("../graph-thread.js", async () => {
  const actual = await vi.importActual<typeof import("../graph-thread.js")>("../graph-thread.js");
  return {
    ...actual,
    fetchChannelMessage: vi.fn(async () => undefined),
    fetchThreadReplies: vi.fn(async () => []),
    resolveTeamGroupId: vi.fn(async () => "group-1"),
  };
});

vi.mock("../reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    markDispatchIdle: vi.fn(),
    replyOptions: {},
  }),
}));

describe("msteams thread session isolation", () => {
  const channelConversationId = "19:general@thread.tacv2";

  function createDeps(cfg: OpenClawConfig) {
    const recordInboundSession = vi.fn(async (_params: { sessionKey: string }) => undefined);
    const resolveAgentRoute = vi.fn(({ peer }: { peer: { kind: string; id: string } }) => ({
      accountId: "default",
      agentId: "main",
      lastRoutePolicy: "session" as const,
      mainSessionKey: "agent:main:main",
      matchedBy: "default" as const,
      sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
    }));

    setMSTeamsRuntime({
      channel: {
        debounce: {
          createInboundDebouncer: <T>(params: {
            onFlush: (entries: T[]) => Promise<void>;
          }): { enqueue: (entry: T) => Promise<void> } => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry]);
            },
          }),
          resolveInboundDebounceMs: () => 0,
        },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => null),
        },
        reply: {
          finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
          formatAgentEnvelope: ({ body }: { body: string }) => body,
        },
        routing: {
          resolveAgentRoute,
        },
        session: {
          recordInboundSession,
          resolveStorePath: () => "/tmp/test-store",
        },
        text: {
          hasControlCommand: () => false,
          resolveTextChunkLimit: () => 4000,
        },
      },
      logging: { shouldLogVerbose: () => false },
      system: { enqueueSystemEvent: vi.fn() },
    } as unknown as PluginRuntime);

    const deps: MSTeamsMessageHandlerDeps = {
      adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
      appId: "test-app",
      cfg,
      conversationStore: {
        findByUserId: vi.fn(async () => null),
        findPreferredDmByUserId: vi.fn(async () => null),
        get: vi.fn(async () => null),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => false),
        upsert: vi.fn(async () => undefined),
      } satisfies MSTeamsConversationStore,
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as MSTeamsMessageHandlerDeps["log"],
      mediaMaxBytes: 1024 * 1024,
      pollStore: {
        recordVote: vi.fn(async () => null),
      } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
      runtime: { error: vi.fn() } as unknown as RuntimeEnv,
      textLimit: 4000,
      tokenProvider: {
        getAccessToken: vi.fn(async () => "token"),
      },
    };

    return {
      deps,
      recordInboundSession,
      resolveAgentRoute,
    };
  }

  function buildActivity(overrides: Record<string, unknown> = {}) {
    return {
      attachments: [],
      channelData: { team: { id: "team-1" } },
      conversation: {
        conversationType: "channel",
        id: channelConversationId,
      },
      entities: [{ mentioned: { id: "bot-id" }, type: "mention" }],
      from: {
        aadObjectId: "user-aad",
        id: "user-id",
        name: "Test User",
      },
      id: "msg-1",
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      text: "hello",
      type: "message",
      ...overrides,
    };
  }

  it("appends thread suffix to session key for channel thread replies", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Thread reply: has replyToId pointing to the thread root
    await handler({
      activity: buildActivity({ replyToId: "thread-root-123" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).toContain("thread:");
    expect(sessionKey).toContain("thread-root-123");
  });

  it("does not append thread suffix for top-level channel messages", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    // Top-level channel message: no replyToId
    await handler({
      activity: buildActivity({ replyToId: undefined }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
    expect(sessionKey).toBe(`agent:main:msteams:channel:${channelConversationId}`);
  });

  it("produces different session keys for different threads in the same channel", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: buildActivity({ id: "msg-1", replyToId: "thread-A" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    await handler({
      activity: buildActivity({ id: "msg-2", replyToId: "thread-B" }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(2);
    const sessionKeyA = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    const sessionKeyB = recordInboundSession.mock.calls[1]?.[0]?.sessionKey;
    expect(sessionKeyA).not.toBe(sessionKeyB);
    expect(sessionKeyA).toContain("thread-a"); // Normalized lowercase
    expect(sessionKeyB).toContain("thread-b");
  });

  it("does not affect DM session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildActivity(),
        channelData: {},
        conversation: {
          conversationType: "personal",
          id: "a:dm-conversation",
        },
        entities: [],
        replyToId: "some-reply-id",
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });

  it("does not affect group chat session keys", async () => {
    const cfg: OpenClawConfig = {
      channels: { msteams: { groupPolicy: "open" } },
    } as OpenClawConfig;
    const { deps, recordInboundSession } = createDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);

    await handler({
      activity: {
        ...buildActivity(),
        channelData: {},
        conversation: {
          conversationType: "groupChat",
          id: "19:group-chat-id@unq.gbl.spaces",
        },
        entities: [{ mentioned: { id: "bot-id" }, type: "mention" }],
        replyToId: "some-reply-id",
      },
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const sessionKey = recordInboundSession.mock.calls[0]?.[0]?.sessionKey;
    expect(sessionKey).not.toContain("thread:");
  });
});
