import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const getDefaultMediaLocalRootsMock = vi.hoisted(() => vi.fn(() => []));
const dispatchChannelMessageActionMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const sendPollMock = vi.hoisted(() => vi.fn());
const getAgentScopedMediaLocalRootsForSourcesMock = vi.hoisted(() =>
  vi.fn<(params: { cfg: unknown; agentId?: string; mediaSources?: readonly string[] }) => string[]>(
    () => ["/tmp/agent-roots"],
  ),
);
const createAgentScopedHostMediaReadFileMock = vi.hoisted(() =>
  vi.fn<(params: { cfg: unknown; agentId?: string }) => (filePath: string) => Promise<Buffer>>(
    () => async () => Buffer.from("capability"),
  ),
);
const resolveAgentScopedOutboundMediaAccessMock = vi.hoisted(() =>
  vi.fn<
    (params: { cfg: unknown; agentId?: string; mediaSources?: readonly string[] }) => {
      localRoots: string[];
      readFile: (filePath: string) => Promise<Buffer>;
    }
  >((params) => ({
    localRoots: getAgentScopedMediaLocalRootsForSourcesMock({
      agentId: params.agentId,
      cfg: params.cfg,
      mediaSources: params.mediaSources ?? [],
    }),
    readFile: createAgentScopedHostMediaReadFileMock({
      agentId: params.agentId,
      cfg: params.cfg,
    }),
  })),
);
const appendAssistantMessageToSessionTranscriptMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, sessionFile: "x" })),
);

const mocks = {
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
  createAgentScopedHostMediaReadFile: createAgentScopedHostMediaReadFileMock,
  dispatchChannelMessageAction: dispatchChannelMessageActionMock,
  getAgentScopedMediaLocalRootsForSources: getAgentScopedMediaLocalRootsForSourcesMock,
  getDefaultMediaLocalRoots: getDefaultMediaLocalRootsMock,
  resolveAgentScopedOutboundMediaAccess: resolveAgentScopedOutboundMediaAccessMock,
  sendMessage: sendMessageMock,
  sendPoll: sendPollMock,
};

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: mocks.dispatchChannelMessageAction,
}));

vi.mock("./message.js", () => ({
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
}));

vi.mock("../../media/read-capability.js", () => ({
  createAgentScopedHostMediaReadFile: mocks.createAgentScopedHostMediaReadFile,
  resolveAgentScopedOutboundMediaAccess: mocks.resolveAgentScopedOutboundMediaAccess,
}));

vi.mock("../../media/local-roots.js", async () => {
  const actual = await vi.importActual<typeof import("../../media/local-roots.js")>(
    "../../media/local-roots.js",
  );
  return {
    ...actual,
    getAgentScopedMediaLocalRootsForSources: mocks.getAgentScopedMediaLocalRootsForSources,
    getDefaultMediaLocalRoots: mocks.getDefaultMediaLocalRoots,
  };
});

vi.mock("../../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
}));

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");

let executePollAction: OutboundSendServiceModule["executePollAction"];
let executeSendAction: OutboundSendServiceModule["executeSendAction"];

describe("executeSendAction", () => {
  function pluginActionResult(messageId: string) {
    return {
      continuePrompt: "",
      model: "gpt-5.4",
      ok: true,
      output: "",
      sessionId: "s1",
      usage: {},
      value: { messageId },
    };
  }

  function expectMirrorWrite(
    expected: Partial<{
      agentId: string;
      sessionKey: string;
      text: string;
      idempotencyKey: string;
      mediaUrls: string[];
    }>,
  ) {
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining(expected),
    );
  }

  async function executePluginMirroredSend(params: {
    mirror?: Partial<{
      sessionKey: string;
      agentId?: string;
      idempotencyKey?: string;
    }>;
    mediaUrls?: string[];
  }) {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        mirror: {
          sessionKey: "agent:main:demo-outbound:channel:123",
          ...params.mirror,
        },
        params: { message: "hello", to: "channel:123" },
      },
      mediaUrls: params.mediaUrls,
      message: "hello",
      to: "channel:123",
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ executePollAction, executeSendAction } = await import("./outbound-send-service.js"));
    mocks.dispatchChannelMessageAction.mockClear();
    mocks.sendMessage.mockClear();
    mocks.sendPoll.mockClear();
    mocks.getDefaultMediaLocalRoots.mockClear();
    mocks.getAgentScopedMediaLocalRootsForSources.mockClear();
    mocks.createAgentScopedHostMediaReadFile.mockClear();
    mocks.resolveAgentScopedOutboundMediaAccess.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      mediaUrl: null,
      to: "channel:123",
      via: "direct",
    });

    await executeSendAction({
      ctx: {
        agentId: "work",
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: {},
      },
      message: "hello",
      to: "channel:123",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "demo-outbound",
        content: "hello",
        to: "channel:123",
      }),
    );
  });

  it("uses plugin poll action when available", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: {},
      },
      resolveCorePoll: () => ({
        maxSelections: 1,
        options: ["Pizza", "Sushi"],
        question: "Lunch?",
        to: "channel:123",
      }),
    });

    expect(result.handledBy).toBe("plugin");
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("does not invoke shared poll parsing before plugin poll dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("poll-plugin"));
    const resolveCorePoll = vi.fn(() => {
      throw new Error("shared poll fallback should not run");
    });

    const result = await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: {
          pollDurationSeconds: 90,
          pollOption: ["Pizza", "Sushi"],
          pollPublic: true,
          pollQuestion: "Lunch?",
        },
      },
      resolveCorePoll,
    });

    expect(result.handledBy).toBe("plugin");
    expect(resolveCorePoll).not.toHaveBeenCalled();
    expect(mocks.sendPoll).not.toHaveBeenCalled();
  });

  it("passes agent-scoped media local roots to plugin dispatch", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        agentId: "agent-1",
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: { message: "hello", to: "channel:123" },
      },
      message: "hello",
      to: "channel:123",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      agentId: "agent-1",
      cfg: {},
      mediaSources: [],
    });
    expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: ["/tmp/agent-roots"],
        mediaReadFile: mocks.createAgentScopedHostMediaReadFile.mock.results[0]?.value,
      }),
    );
  });

  it("passes concrete media sources when widening plugin dispatch roots", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(pluginActionResult("msg-plugin"));

    await executeSendAction({
      ctx: {
        agentId: "agent-1",
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: {
          media: "/Users/peter/Pictures/photo.png",
          message: "hello",
          to: "channel:123",
        },
      },
      mediaUrl: "/Users/peter/Pictures/photo.png",
      message: "hello",
      to: "channel:123",
    });

    expect(mocks.getAgentScopedMediaLocalRootsForSources).toHaveBeenCalledWith({
      agentId: "agent-1",
      cfg: {},
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });
  });

  it("passes mirror idempotency keys through plugin-handled sends", async () => {
    await executePluginMirroredSend({
      mirror: {
        idempotencyKey: "idem-plugin-send-1",
      },
    });

    expectMirrorWrite({
      idempotencyKey: "idem-plugin-send-1",
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
    });
  });

  it("falls back to message and media params for plugin-handled mirror writes", async () => {
    await executePluginMirroredSend({
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      mirror: {
        agentId: "agent-9",
      },
    });

    expectMirrorWrite({
      agentId: "agent-9",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      sessionKey: "agent:main:demo-outbound:channel:123",
      text: "hello",
    });
  });

  it("skips plugin dispatch during dry-run sends and forwards gateway + silent to sendMessage", async () => {
    mocks.sendMessage.mockResolvedValue({
      channel: "demo-outbound",
      mediaUrl: null,
      to: "channel:123",
      via: "gateway",
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        dryRun: true,
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          timeoutMs: 5000,
          token: "tok",
          url: "http://127.0.0.1:18789",
        },
        params: { message: "hello", to: "channel:123" },
        silent: true,
      },
      message: "hello",
      to: "channel:123",
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "hello",
        dryRun: true,
        gateway: expect.objectContaining({
          timeoutMs: 5000,
          token: "tok",
          url: "http://127.0.0.1:18789",
        }),
        silent: true,
        to: "channel:123",
      }),
    );
  });

  it("forwards poll args to sendPoll on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      durationHours: null,
      durationSeconds: null,
      maxSelections: 1,
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
      to: "channel:123",
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        accountId: "acc-1",
        cfg: {},
        channel: "demo-outbound",
        dryRun: false,
        params: {},
      },
      resolveCorePoll: () => ({
        durationSeconds: 300,
        isAnonymous: true,
        maxSelections: 1,
        options: ["Pizza", "Sushi"],
        question: "Lunch?",
        threadId: "thread-1",
        to: "channel:123",
      }),
    });

    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc-1",
        channel: "demo-outbound",
        durationSeconds: 300,
        isAnonymous: true,
        maxSelections: 1,
        options: ["Pizza", "Sushi"],
        question: "Lunch?",
        threadId: "thread-1",
        to: "channel:123",
      }),
    );
  });

  it("skips plugin dispatch during dry-run polls and forwards durationHours + silent", async () => {
    mocks.sendPoll.mockResolvedValue({
      channel: "demo-outbound",
      durationHours: 6,
      durationSeconds: null,
      maxSelections: 1,
      options: ["Pizza", "Sushi"],
      question: "Lunch?",
      to: "channel:123",
      via: "gateway",
    });

    await executePollAction({
      ctx: {
        cfg: {},
        channel: "demo-outbound",
        dryRun: true,
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          timeoutMs: 5000,
          token: "tok",
          url: "http://127.0.0.1:18789",
        },
        params: {},
        silent: true,
      },
      resolveCorePoll: () => ({
        durationHours: 6,
        maxSelections: 1,
        options: ["Pizza", "Sushi"],
        question: "Lunch?",
        to: "channel:123",
      }),
    });

    expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
    expect(mocks.sendPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        durationHours: 6,
        gateway: expect.objectContaining({
          timeoutMs: 5000,
          token: "tok",
          url: "http://127.0.0.1:18789",
        }),
        question: "Lunch?",
        silent: true,
        to: "channel:123",
      }),
    );
  });
});
