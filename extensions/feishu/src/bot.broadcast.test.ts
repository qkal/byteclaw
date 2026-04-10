import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const { mockCreateFeishuReplyDispatcher, mockCreateFeishuClient, mockResolveAgentRoute } =
  vi.hoisted(() => ({
    mockCreateFeishuClient: vi.fn(),
    mockCreateFeishuReplyDispatcher: vi.fn(() => ({
      dispatcher: {
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        sendToolResult: vi.fn(),
        waitForIdle: vi.fn(),
      },
      markDispatchIdle: vi.fn(),
      replyOptions: {},
    })),
    mockResolveAgentRoute: vi.fn(),
  }));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv() {
  return {
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  };
}

describe("broadcast dispatch", () => {
  const finalizeInboundContextCalls: Record<string, unknown>[] = [];
  const mockFinalizeInboundContext: PluginRuntime["channel"]["reply"]["finalizeInboundContext"] = (
    ctx,
  ) => {
    finalizeInboundContextCalls.push(ctx);
    return {
      ...ctx,
      CommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : false,
    };
  };
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ counts: { final: 1 }, queuedFinal: false });
  const mockWithReplyDispatcher: PluginRuntime["channel"]["reply"]["withReplyDispatcher"] = async ({
    dispatcher,
    run,
    onSettled,
  }) => {
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
  };
  const resolveEnvelopeFormatOptionsMock: PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"] =
    () => ({}) satisfies EnvelopeFormatOptions;
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    contentType: "video/mp4",
    path: "/tmp/inbound-clip.mp4",
  });
  const runtimeStub = {
    channel: {
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
      },
      media: {
        saveMediaBuffer: mockSaveMediaBuffer,
      },
      pairing: {
        buildPairingReply: vi.fn(() => "Pairing response"),
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
      },
      reply: {
        dispatchReplyFromConfig: mockDispatchReplyFromConfig,
        finalizeInboundContext:
          mockFinalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        resolveEnvelopeFormatOptions: resolveEnvelopeFormatOptionsMock,
        withReplyDispatcher:
          mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
      },
      routing: {
        resolveAgentRoute: (params: unknown) => mockResolveAgentRoute(params),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
      },
    },
    media: {
      detectMime: vi.fn(async () => "application/octet-stream"),
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as PluginRuntime;

  function createBroadcastConfig(): ClawdbotConfig {
    return {
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    };
  }

  function createBroadcastEvent(options: {
    messageId: string;
    text: string;
    botMentioned?: boolean;
  }): FeishuMessageEvent {
    return {
      message: {
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        content: JSON.stringify({ text: options.text }),
        message_id: options.messageId,
        message_type: "text",
        ...(options.botMentioned
          ? {
              mentions: [
                {
                  id: { open_id: "bot-open-id" },
                  key: "@_user_1",
                  name: "Bot",
                  tenant_key: "",
                },
              ],
            }
          : {}),
      },
      sender: { sender_id: { open_id: "ou-sender" } },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    finalizeInboundContextCalls.length = 0;
    mockResolveAgentRoute.mockReturnValue({
      accountId: "default",
      agentId: "main",
      channel: "feishu",
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    setFeishuRuntime(runtimeStub);
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      botMentioned: true,
      messageId: "msg-broadcast-mentioned",
      text: "hello @bot",
    });

    await handleFeishuMessage({
      botOpenId: "bot-open-id",
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    const sessionKeys = finalizeInboundContextCalls.map((call) => call.SessionKey);
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-not-mentioned",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      botOpenId: "ou_known_bot",
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot identity is unknown (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-unknown-bot-id",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-no-broadcast",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-sender" } },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(finalizeInboundContextCalls).toContainEqual(
      expect.objectContaining({
        SessionKey: "agent:main:feishu:group:oc-broadcast-group",
      }),
    );
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-multi-account-dedup",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-sender" } },
    };

    await handleFeishuMessage({
      accountId: "account-A",
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    finalizeInboundContextCalls.length = 0;

    await handleFeishuMessage({
      accountId: "account-B",
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      message: {
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        message_id: "msg-broadcast-unknown-agent",
        message_type: "text",
      },
      sender: { sender_id: { open_id: "ou-sender" } },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey = String(finalizeInboundContextCalls[0]?.SessionKey ?? "");
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
