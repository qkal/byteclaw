import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingTypedRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import * as dedup from "./dedup.js";
import { monitorSingleAccount } from "./monitor.account.js";
import {
  type FeishuDriveCommentNoticeEvent,
  resolveDriveCommentEventTurn,
} from "./monitor.comment.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const handleFeishuCommentEventMock = vi.hoisted(() => vi.fn(async () => {}));
const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
const TEST_DOC_TOKEN = "doxxxxxxx";

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-handler.js", () => ({
  handleFeishuCommentEvent: handleFeishuCommentEventMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildMonitorConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function buildMonitorAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // Pragma: allowlist secret
    domain: "feishu",
    config: {
      connectionMode: "websocket",
      enabled: true,
    },
  } as ResolvedFeishuAccount;
}

function createFeishuMonitorRuntime(params?: {
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
}): PluginRuntime {
  return {
    channel: {
      debounce: {
        createInboundDebouncer: params?.createInboundDebouncer ?? createInboundDebouncer,
        resolveInboundDebounceMs: params?.resolveInboundDebounceMs ?? resolveInboundDebounceMs,
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? hasControlCommand,
      },
    },
  } as unknown as PluginRuntime;
}

function makeDriveCommentEvent(
  overrides: Partial<FeishuDriveCommentNoticeEvent> = {},
): FeishuDriveCommentNoticeEvent {
  return {
    comment_id: "7623358762119646411",
    event_id: "10d9d60b990db39f96a4c2fd357fb877",
    is_mentioned: true,
    notice_meta: {
      file_token: TEST_DOC_TOKEN,
      file_type: "docx",
      from_user_id: {
        open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
      },
      notice_type: "add_comment",
      to_user_id: {
        open_id: "ou_bot",
      },
    },
    reply_id: "7623358762136374451",
    timestamp: "1774951528000",
    type: "drive.notice.comment_add_v1",
    ...overrides,
  };
}

function makeOpenApiClient(params: {
  documentTitle?: string;
  documentUrl?: string;
  isWholeComment?: boolean;
  batchCommentId?: string;
  quoteText?: string;
  rootReplyText?: string;
  targetReplyText?: string;
  includeTargetReplyInBatch?: boolean;
  repliesSequence?: { reply_id: string; text: string }[][];
}) {
  const remainingReplyBatches = [...(params.repliesSequence ?? [])];
  return {
    request: vi.fn(async (request: { method: "GET" | "POST"; url: string; data: unknown }) => {
      if (request.url === "/open-apis/drive/v1/metas/batch_query") {
        return {
          code: 0,
          data: {
            metas: [
              {
                doc_token: TEST_DOC_TOKEN,
                title: params.documentTitle ?? "Comment event handling request",
                url: params.documentUrl ?? `https://www.larksuite.com/docx/${TEST_DOC_TOKEN}`,
              },
            ],
          },
        };
      }
      if (request.url.includes("/comments/batch_query")) {
        return {
          code: 0,
          data: {
            items: [
              {
                comment_id: params.batchCommentId ?? "7623358762119646411",
                is_whole: params.isWholeComment,
                quote: params.quoteText ?? "im.message.receive_v1 message trigger implementation",
                reply_list: {
                  replies: [
                    {
                      content: {
                        elements: [
                          {
                            text_run: {
                              content:
                                params.rootReplyText ??
                                "Also send it to the agent after receiving the comment event",
                            },
                            type: "text_run",
                          },
                        ],
                      },
                      reply_id: "7623358762136374451",
                    },
                    ...(params.includeTargetReplyInBatch
                      ? [
                          {
                            content: {
                              elements: [
                                {
                                  text_run: {
                                    content:
                                      params.targetReplyText ?? "Please follow up on this comment",
                                  },
                                  type: "text_run",
                                },
                              ],
                            },
                            reply_id: "7623359125036043462",
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          },
        };
      }
      if (request.url.includes("/replies")) {
        const replyBatch = remainingReplyBatches.shift();
        const items = replyBatch?.map((reply) => ({
          content: {
            elements: [
              {
                text_run: {
                  content: reply.text,
                },
                type: "text_run",
              },
            ],
          },
          reply_id: reply.reply_id,
        })) ?? [
          {
            content: {
              elements: [
                {
                  text_run: {
                    content:
                      params.rootReplyText ??
                      "Also send it to the agent after receiving the comment event",
                  },
                  type: "text_run",
                },
              ],
            },
            reply_id: "7623358762136374451",
          },
          {
            content: {
              elements: [
                {
                  text_run: {
                    content: params.targetReplyText ?? "Please follow up on this comment",
                  },
                  type: "text_run",
                },
              ],
            },
            reply_id: "7623359125036043462",
          },
        ];
        return {
          code: 0,
          data: {
            has_more: false,
            items,
          },
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    }),
  };
}

async function setupCommentMonitorHandler(): Promise<(data: unknown) => Promise<void>> {
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    account: buildMonitorAccount(),
    botOpenIdSource: {
      botOpenId: "ou_bot",
      kind: "prefetched",
    },
    cfg: buildMonitorConfig(),
    runtime: createNonExitingTypedRuntimeEnv<RuntimeEnv>(),
  });

  const handler = handlers["drive.notice.comment_add_v1"];
  if (!handler) {
    throw new Error("missing drive.notice.comment_add_v1 handler");
  }
  return handler;
}

describe("resolveDriveCommentEventTurn", () => {
  it("builds a real comment-turn prompt for add_comment notices", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent(),
    });

    expect(turn).not.toBeNull();
    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.messageId).toBe("drive-comment:10d9d60b990db39f96a4c2fd357fb877");
    expect(turn?.fileType).toBe("docx");
    expect(turn?.fileToken).toBe(TEST_DOC_TOKEN);
    expect(turn?.prompt).toContain(
      'The user added a comment in "Comment event handling request": Also send it to the agent after receiving the comment event',
    );
    expect(turn?.prompt).toContain(
      "This is a Feishu document comment-thread event, not a Feishu IM conversation.",
    );
    expect(turn?.prompt).toContain("Prefer plain text suitable for a comment thread.");
    expect(turn?.prompt).toContain("Do not include internal reasoning");
    expect(turn?.prompt).toContain("Do not narrate your plan or execution process");
    expect(turn?.prompt).toContain("reply only with the user-facing result itself");
    expect(turn?.prompt).toContain("comment_id: 7623358762119646411");
    expect(turn?.prompt).toContain("reply_id: 7623358762136374451");
    expect(turn?.prompt).toContain("The system will automatically reply with your final answer");
  });

  it("preserves whole-document comment metadata for downstream delivery mode selection", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: true,
      isWholeComment: true,
    });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent(),
    });

    expect(turn?.isWholeComment).toBe(true);
    expect(turn?.prompt).toContain("This is a whole-document comment.");
    expect(turn?.prompt).toContain("Whole-document comments do not support direct replies.");
  });

  it("does not trust whole-comment metadata from a mismatched batch_query item", async () => {
    const client = makeOpenApiClient({
      batchCommentId: "different_comment_id",
      includeTargetReplyInBatch: true,
      isWholeComment: true,
    });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent(),
    });

    expect(turn?.isWholeComment).toBeUndefined();
    expect(turn?.prompt).not.toContain("This is a whole-document comment.");
  });

  it("preserves sender user_id for downstream allowlist checks", async () => {
    const client = makeOpenApiClient({ includeTargetReplyInBatch: true });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: {
            open_id: "ou_509d4d7ace4a9addec2312676ffcba9b",
            user_id: "on_comment_user_1",
          },
        },
      }),
    });

    expect(turn?.senderId).toBe("ou_509d4d7ace4a9addec2312676ffcba9b");
    expect(turn?.senderUserId).toBe("on_comment_user_1");
  });

  it("falls back to the replies API to resolve add_reply text", async () => {
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: false,
      targetReplyText: "Please follow up on this comment",
    });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          notice_type: "add_reply",
        },
        reply_id: "7623359125036043462",
      }),
    });

    expect(turn?.prompt).toContain(
      'The user added a reply in "Comment event handling request": Please follow up on this comment',
    );
    expect(turn?.prompt).toContain(
      "Original comment: Also send it to the agent after receiving the comment event",
    );
    expect(turn?.prompt).toContain(`file_token: ${TEST_DOC_TOKEN}`);
    expect(turn?.prompt).toContain("Event type: add_reply");
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: expect.stringContaining(
          `/comments/7623358762119646411/replies?file_type=docx&page_size=100&user_id_type=open_id`,
        ),
      }),
    );
  });

  it("retries comment reply lookup when the requested reply is not immediately visible", async () => {
    const waitMs = vi.fn(async () => {});
    const client = makeOpenApiClient({
      includeTargetReplyInBatch: false,
      repliesSequence: [
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623358762999999999", text: "Earlier assistant summary" },
        ],
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623358762999999999", text: "Earlier assistant summary" },
        ],
        [
          {
            reply_id: "7623358762136374451",
            text: "Also send it to the agent after receiving the comment event",
          },
          { reply_id: "7623359125999999999", text: "Insert a sentence below this paragraph" },
        ],
      ],
    });

    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => client as never,
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          notice_type: "add_reply",
        },
        reply_id: "7623359125999999999",
      }),
      waitMs,
    });

    expect(turn?.targetReplyText).toBe("Insert a sentence below this paragraph");
    expect(turn?.prompt).toContain("Insert a sentence below this paragraph");
    expect(waitMs).toHaveBeenCalledTimes(2);
    expect(waitMs).toHaveBeenNthCalledWith(1, 1000);
    expect(waitMs).toHaveBeenNthCalledWith(2, 1000);
    expect(
      client.request.mock.calls.filter(
        ([request]: [{ method: string; url: string }]) =>
          request.method === "GET" && request.url.includes("/replies"),
      ),
    ).toHaveLength(3);
  });

  it("ignores self-authored comment notices", async () => {
    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: "ou_bot",
      cfg: buildMonitorConfig(),
      createClient: () => makeOpenApiClient({}) as never,
      event: makeDriveCommentEvent({
        notice_meta: {
          ...makeDriveCommentEvent().notice_meta,
          from_user_id: { open_id: "ou_bot" },
        },
      }),
    });

    expect(turn).toBeNull();
  });

  it("skips comment notices when bot open_id is unavailable", async () => {
    const turn = await resolveDriveCommentEventTurn({
      accountId: "default",
      botOpenId: undefined,
      cfg: buildMonitorConfig(),
      createClient: () => makeOpenApiClient({}) as never,
      event: makeDriveCommentEvent(),
    });

    expect(turn).toBeNull();
  });
});

describe("drive.notice.comment_add_v1 monitor handler", () => {
  beforeEach(() => {
    handlers = {};
    handleFeishuCommentEventMock.mockClear();
    createEventDispatcherMock.mockReset();
    createFeishuClientMock.mockReset().mockReturnValue(makeOpenApiClient({}) as never);
    createFeishuThreadBindingManagerMock.mockReset().mockImplementation(() => ({
      stop: vi.fn(),
    }));
    vi.spyOn(dedup, "tryBeginFeishuMessageProcessing").mockReturnValue(true);
    vi.spyOn(dedup, "recordProcessedFeishuMessage").mockResolvedValue(true);
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(false);
    setFeishuRuntime(createFeishuMonitorRuntime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches comment notices through handleFeishuCommentEvent", async () => {
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).toHaveBeenCalledTimes(1);
    expect(handleFeishuCommentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        botOpenId: "ou_bot",
        event: expect.objectContaining({
          comment_id: "7623358762119646411",
          event_id: "10d9d60b990db39f96a4c2fd357fb877",
        }),
      }),
    );
  });

  it("drops duplicate comment events before dispatch", async () => {
    vi.spyOn(dedup, "hasProcessedFeishuMessage").mockResolvedValue(true);
    const onComment = await setupCommentMonitorHandler();

    await onComment(makeDriveCommentEvent());

    expect(handleFeishuCommentEventMock).not.toHaveBeenCalled();
  });
});
