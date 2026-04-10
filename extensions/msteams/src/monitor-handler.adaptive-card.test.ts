import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    capturedCtxPayload: params.ctxPayload,
    counts: {},
    queuedFinal: false,
  })),
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
  };
});

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    markDispatchIdle: vi.fn(),
    replyOptions: {},
  }),
}));

function createDeps(): MSTeamsMessageHandlerDeps {
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
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          accountId: "default",
          agentId: "default",
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
        }),
      },
      session: {
        recordInboundSession: vi.fn(async () => undefined),
      },
      text: {
        hasControlCommand: () => false,
      },
    },
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: vi.fn() },
  } as unknown as PluginRuntime);

  return {
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    appId: "test-app",
    cfg: {} as OpenClawConfig,
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
}

function createActivityHandler() {
  const messageHandlers: ((context: unknown, next: () => Promise<void>) => Promise<void>)[] = [];
  const run = vi.fn(async (context: unknown) => {
    const activityType = (context as MSTeamsTurnContext).activity?.type;
    if (activityType !== "message") {
      return;
    }
    for (const handler of messageHandlers) {
      await handler(context, async () => {});
    }
  });

  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
    onMembersAdded: () => handler,
    onMessage: (nextHandler) => {
      messageHandlers.push(nextHandler);
      return handler;
    },
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };

  return { handler, run };
}

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  it("forwards adaptive card invoke values to the agent as message text", async () => {
    const deps = createDeps();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const payload = {
      action: {
        data: {
          environment: "prod",
          intent: "deploy",
        },
        type: "Action.Submit",
      },
      trigger: "button-click",
    };

    await registered.run({
      activity: {
        attachments: [],
        channelData: {},
        channelId: "msteams",
        conversation: {
          conversationType: "personal",
          id: "19:personal-chat;messageid=abc123",
        },
        from: {
          aadObjectId: "user-aad",
          id: "user-bf",
          name: "User",
        },
        id: "invoke-1",
        name: "adaptiveCard/action",
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        serviceUrl: "https://service.example.test",
        type: "invoke",
        value: payload,
      },
      sendActivities: async () => [],
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
    } as unknown as MSTeamsTurnContext);

    expect(run).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    expect(
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0],
    ).toMatchObject({
      ctxPayload: {
        BodyForAgent: JSON.stringify(payload),
        CommandBody: JSON.stringify(payload),
        RawBody: JSON.stringify(payload),
        SenderId: "user-aad",
        SessionKey: "msteams:direct:user-aad",
      },
    });
  });
});
