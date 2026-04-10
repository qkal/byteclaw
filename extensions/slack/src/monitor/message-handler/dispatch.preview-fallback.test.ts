import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const SAME_TEXT = "same reply";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});
let mockedDispatchSequence: {
  kind: "tool" | "block" | "final";
  payload: { text: string };
}[] = [];

const noop = () => {};
const noopAsync = async () => {};

function createDraftStreamStub() {
  return {
    channelId: () => "C123",
    clear: noopAsync,
    flush: noopAsync,
    forceNewMessage: noop,
    messageId: () => "171234.567",
    stop: noop,
    update: noop,
  };
}

function createPreparedSlackMessage() {
  return {
    account: {
      accountId: "default",
      config: {},
    },
    ackReactionPromise: null,
    ackReactionValue: "eyes",
    channelConfig: null,
    ctx: {
      allowFrom: [],
      app: { client: {} },
      botToken: "xoxb-test",
      cfg: {},
      channelHistories: new Map(),
      historyLimit: 0,
      removeAckAfterReply: false,
      runtime: {},
      setSlackThreadStatus: async () => undefined,
      teamId: "T1",
      textLimit: 4000,
      typingReaction: "",
    },
    ctxPayload: {
      MessageThreadId: THREAD_TS,
    },
    historyKey: "history-key",
    isDirectMessage: false,
    isRoomish: false,
    message: {
      channel: "C123",
      thread_ts: THREAD_TS,
      ts: "171234.111",
      user: "U123",
    },
    preview: "",
    replyTarget: "channel:C123",
    replyToMode: "all",
    route: {
      accountId: "default",
      agentId: "agent-1",
      mainSessionKey: "main",
    },
  } as never;
}

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_TIMING: {
    doneHoldMs: 0,
    errorHoldMs: 0,
  },
  createStatusReactionController: () => ({
    clear: async () => {},
    restoreInitial: async () => {},
    setDone: async () => {},
    setError: async () => {},
    setQueued: async () => {},
    setThinking: async () => {},
    setTool: async () => {},
  }),
  logAckFailure: () => {},
  logTypingFailure: () => {},
  removeAckReactionAfterReply: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    onModelSelected: undefined,
    typingCallbacks: {
      onIdle: vi.fn(),
    },
  }),
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => false,
  resolveChannelStreamingNativeTransport: () => false,
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
    opts?: { text?: string },
  ) => {
    const text = (opts?.text ?? payload.text ?? "").trim();
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    return {
      hasContent: text.length > 0 || mediaUrls.length > 0,
      hasMedia: mediaUrls.length > 0,
      hasText: text.length > 0,
      mediaUrls,
      text,
      trimmedText: text,
    };
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (message: string) => message,
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: async () => {},
  removeSlackReaction: async () => {},
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: createSlackDraftStreamMock,
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value.trim(),
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: () => {},
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  buildStatusFinalPreviewText: () => "status",
  resolveSlackStreamingConfig: () => ({
    draftMode: "append",
    mode: "partial",
    nativeStreaming: false,
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  startSlackStream: async () => ({
    stopped: false,
    threadTs: THREAD_TS,
  }),
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    isThreadReply: true,
    statusThreadTs: THREAD_TS,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: async () => {},
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    markSent: () => {},
    nextThreadTs: () => THREAD_TS,
  }),
  deliverReplies: deliverRepliesMock,
  readSlackReplyBlocks: () => undefined,
  resolveSlackThreadTs: () => THREAD_TS,
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: {
    deliver: (payload: unknown, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  }) => ({
    dispatcher: {
      deliver: params.deliver,
    },
    markDispatchIdle: () => {},
    replyOptions: {},
  }),
  dispatchInboundMessage: async (params: {
    dispatcher: {
      deliver: (
        payload: { text: string },
        info: { kind: "tool" | "block" | "final" },
      ) => Promise<void>;
    };
  }) => {
    for (const entry of mockedDispatchSequence) {
      await params.dispatcher.deliver(entry.payload, { kind: entry.kind });
    }
    return {
      counts: {
        final: mockedDispatchSequence.filter((entry) => entry.kind === "final").length,
      },
      queuedFinal: false,
    };
  },
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: finalizeSlackPreviewEditMock,
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

describe("dispatchPreparedSlackMessage preview fallback", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    createSlackDraftStreamMock.mockReset();
    deliverRepliesMock.mockReset();
    finalizeSlackPreviewEditMock.mockReset();
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];

    createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
    finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
  });

  it("falls back to normal delivery when preview finalize fails", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: FINAL_REPLY_TEXT })],
        replyThreadTs: THREAD_TS,
      }),
    );
  });

  it("keeps same-content tool and final payloads distinct after preview fallback", async () => {
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: SAME_TEXT } },
      { kind: "final", payload: { text: SAME_TEXT } },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [expect.objectContaining({ text: SAME_TEXT })],
        replyThreadTs: THREAD_TS,
      }),
    );
    expect(deliverRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [expect.objectContaining({ text: SAME_TEXT })],
        replyThreadTs: THREAD_TS,
      }),
    );
  });
});
