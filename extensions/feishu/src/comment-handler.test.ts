import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const createFeishuCommentReplyDispatcherMock = vi.hoisted(() => vi.fn());
const maybeCreateDynamicAgentMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn(() => ({ request: vi.fn() })));
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.comment.js", () => ({
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./comment-dispatcher.js", () => ({
  createFeishuCommentReplyDispatcher: createFeishuCommentReplyDispatcherMock,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: maybeCreateDynamicAgentMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        dmPolicy: "open",
        enabled: true,
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

function buildResolvedRoute(matchedBy: "binding.channel" | "default" = "binding.channel") {
  return {
    accountId: "default",
    agentId: "main",
    channel: "feishu",
    lastRoutePolicy: "session" as const,
    mainSessionKey: "agent:main:feishu",
    matchedBy,
    sessionKey: "agent:main:feishu:direct:ou_sender",
  };
}

function createTestRuntime(overrides?: {
  readAllowFromStore?: () => Promise<unknown[]>;
  upsertPairingRequest?: () => Promise<{ code: string; created: boolean }>;
  resolveAgentRoute?: () => ReturnType<typeof buildResolvedRoute>;
  dispatchReplyFromConfig?: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  withReplyDispatcher?: PluginRuntime["channel"]["reply"]["withReplyDispatcher"];
}) {
  const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
  const dispatchReplyFromConfig =
    overrides?.dispatchReplyFromConfig ??
    vi.fn(async () => ({
      counts: { block: 0, final: 1, tool: 0 },
      queuedFinal: true,
    }));
  const withReplyDispatcher =
    overrides?.withReplyDispatcher ??
    vi.fn(
      async ({
        run,
        onSettled,
      }: {
        run: () => Promise<unknown>;
        onSettled?: () => Promise<void> | void;
      }) => {
        try {
          return await run();
        } finally {
          await onSettled?.();
        }
      },
    );
  const recordInboundSession = vi.fn(async () => {});

  return {
    channel: {
      pairing: {
        buildPairingReply: vi.fn((code: string) => `Pairing code: ${code}`),
        readAllowFromStore: vi.fn(overrides?.readAllowFromStore ?? (async () => [])),
        upsertPairingRequest: vi.fn(
          overrides?.upsertPairingRequest ??
            (async () => ({
              code: "TESTCODE",
              created: true,
            })),
        ),
      },
      reply: {
        dispatchReplyFromConfig,
        finalizeInboundContext,
        withReplyDispatcher,
      },
      routing: {
        buildAgentSessionKey: vi.fn(
          ({
            agentId,
            channel,
            peer,
          }: {
            agentId: string;
            channel: string;
            peer?: { kind?: string; id?: string };
          }) => `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn(overrides?.resolveAgentRoute ?? (() => buildResolvedRoute())),
      },
      session: {
        recordInboundSession,
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
      },
    },
  } as unknown as PluginRuntime;
}

describe("handleFeishuCommentEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeCreateDynamicAgentMock.mockResolvedValue({ created: false });
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      commentId: "comment_1",
      documentTitle: "Project review",
      eventId: "evt_1",
      fileToken: "doc_token_1",
      fileType: "docx",
      isMentioned: true,
      isWholeComment: false,
      messageId: "drive-comment:evt_1",
      noticeType: "add_comment",
      preview: "prompt body",
      prompt: "prompt body",
      replyId: "reply_1",
      rootCommentText: "root comment",
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      targetReplyText: "latest reply",
      timestamp: "1774951528000",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "r1",
    });

    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      markDispatchIdle: vi.fn(),
      replyOptions: {},
    });
  });

  it("records a comment-thread inbound context with a routable Feishu origin", async () => {
    await handleFeishuCommentEvent({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildConfig(),
      event: { event_id: "evt_1" },
      runtime: {
        error: vi.fn(),
        log: vi.fn(),
      } as never,
    });

    const runtime = (await import("./runtime.js")).getFeishuRuntime();
    const finalizeInboundContext = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    const recordInboundSession = runtime.channel.session.recordInboundSession as ReturnType<
      typeof vi.fn
    >;
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        From: "feishu:ou_sender",
        MessageSid: "drive-comment:evt_1",
        OriginatingChannel: "feishu",
        OriginatingTo: "comment:docx:doc_token_1:comment_1",
        Surface: "feishu-comment",
        To: "comment:docx:doc_token_1:comment_1",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("allows comment senders matched by user_id allowlist entries", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildConfig({
        channels: {
          feishu: {
            allowFrom: ["on_sender_user"],
            dmPolicy: "allowlist",
            enabled: true,
          },
        },
      }),
      event: { event_id: "evt_1" },
      runtime: {
        error: vi.fn(),
        log: vi.fn(),
      } as never,
    });

    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge in the comment thread when dmPolicy=pairing", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildConfig({
        channels: {
          feishu: {
            allowFrom: [],
            dmPolicy: "pairing",
            enabled: true,
          },
        },
      }),
      event: { event_id: "evt_1" },
      runtime: {
        error: vi.fn(),
        log: vi.fn(),
      } as never,
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        comment_id: "comment_1",
        file_token: "doc_token_1",
        file_type: "docx",
        is_whole_comment: false,
      }),
    );
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("passes whole-comment metadata to the comment reply dispatcher", async () => {
    resolveDriveCommentEventTurnMock.mockResolvedValueOnce({
      commentId: "comment_whole",
      documentTitle: "Project review",
      eventId: "evt_whole",
      fileToken: "doc_token_1",
      fileType: "docx",
      isMentioned: false,
      isWholeComment: true,
      messageId: "drive-comment:evt_whole",
      noticeType: "add_reply",
      preview: "prompt body",
      prompt: "prompt body",
      replyId: "reply_whole",
      rootCommentText: "root comment",
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      targetReplyText: "reply text",
      timestamp: "1774951528000",
    });

    await handleFeishuCommentEvent({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildConfig(),
      event: { event_id: "evt_whole" },
      runtime: {
        error: vi.fn(),
        log: vi.fn(),
      } as never,
    });

    expect(createFeishuCommentReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: "comment_whole",
        fileToken: "doc_token_1",
        fileType: "docx",
        isWholeComment: true,
      }),
    );
  });
});
