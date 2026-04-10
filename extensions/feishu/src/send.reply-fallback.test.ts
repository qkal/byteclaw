import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuSendTargetMock = vi.hoisted(() => vi.fn());
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "preserve"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));

vi.mock("./send-target.js", () => ({
  resolveFeishuSendTarget: resolveFeishuSendTargetMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        convertMarkdownTables: convertMarkdownTablesMock,
        resolveMarkdownTableMode: resolveMarkdownTableModeMock,
      },
    },
  }),
  setFeishuRuntime: vi.fn(),
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

let sendCardFeishu: typeof import("./send.js").sendCardFeishu;
let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

describe("Feishu reply fallback for withdrawn/deleted targets", () => {
  const replyMock = vi.fn();
  const createMock = vi.fn();

  async function expectFallbackResult(
    send: () => Promise<{ messageId?: string }>,
    expectedMessageId: string,
  ) {
    const result = await send();
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe(expectedMessageId);
  }

  beforeAll(async () => {
    ({ sendCardFeishu, sendMessageFeishu } = await import("./send.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuSendTargetMock.mockReturnValue({
      client: {
        im: {
          message: {
            create: createMock,
            reply: replyMock,
          },
        },
      },
      receiveId: "ou_target",
      receiveIdType: "open_id",
    });
  });

  it("falls back to create for withdrawn post replies", async () => {
    replyMock.mockResolvedValue({
      code: 230_011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_new" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          replyToMessageId: "om_parent",
          text: "hello",
          to: "user:ou_target",
        }),
      "om_new",
    );
  });

  it("falls back to create for withdrawn card replies", async () => {
    replyMock.mockResolvedValue({
      code: 231_003,
      msg: "The message is not found",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_card_new" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          card: { schema: "2.0" },
          cfg: {} as never,
          replyToMessageId: "om_parent",
          to: "user:ou_target",
        }),
      "om_card_new",
    );
  });

  it("still throws for non-withdrawn reply failures", async () => {
    replyMock.mockResolvedValue({
      code: 999_999,
      msg: "unknown failure",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        replyToMessageId: "om_parent",
        text: "hello",
        to: "user:ou_target",
      }),
    ).rejects.toThrow("Feishu reply failed");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("falls back to create when reply throws a withdrawn SDK error", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230_011 });
    replyMock.mockRejectedValue(sdkError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_thrown_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          replyToMessageId: "om_parent",
          text: "hello",
          to: "user:ou_target",
        }),
      "om_thrown_fallback",
    );
  });

  it("falls back to create when card reply throws a not-found AxiosError", async () => {
    const axiosError = Object.assign(new Error("Request failed"), {
      response: { data: { code: 231_003, msg: "The message is not found" }, status: 200 },
    });
    replyMock.mockRejectedValue(axiosError);
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_axios_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendCardFeishu({
          card: { schema: "2.0" },
          cfg: {} as never,
          replyToMessageId: "om_parent",
          to: "user:ou_target",
        }),
      "om_axios_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors for text messages", async () => {
    const sdkError = Object.assign(new Error("rate limited"), { code: 99_991_400 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        replyToMessageId: "om_parent",
        text: "hello",
        to: "user:ou_target",
      }),
    ).rejects.toThrow("rate limited");

    expect(createMock).not.toHaveBeenCalled();
  });

  it("fails thread replies instead of falling back to a top-level send", async () => {
    replyMock.mockResolvedValue({
      code: 230_011,
      msg: "The message was withdrawn.",
    });

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        replyInThread: true,
        replyToMessageId: "om_parent",
        text: "hello",
        to: "chat:oc_group_1",
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reply_in_thread: true,
      }),
      path: { message_id: "om_parent" },
    });
  });

  it("fails thrown withdrawn thread replies instead of falling back to create", async () => {
    const sdkError = Object.assign(new Error("request failed"), { code: 230_011 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendMessageFeishu({
        cfg: {} as never,
        replyInThread: true,
        replyToMessageId: "om_parent",
        text: "hello",
        to: "chat:oc_group_1",
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("still falls back for non-thread replies to withdrawn targets", async () => {
    replyMock.mockResolvedValue({
      code: 230_011,
      msg: "The message was withdrawn.",
    });
    createMock.mockResolvedValue({
      code: 0,
      data: { message_id: "om_non_thread_fallback" },
    });

    await expectFallbackResult(
      () =>
        sendMessageFeishu({
          cfg: {} as never,
          replyInThread: false,
          replyToMessageId: "om_parent",
          text: "hello",
          to: "user:ou_target",
        }),
      "om_non_thread_fallback",
    );
  });

  it("re-throws non-withdrawn thrown errors for card messages", async () => {
    const sdkError = Object.assign(new Error("permission denied"), { code: 99_991_401 });
    replyMock.mockRejectedValue(sdkError);

    await expect(
      sendCardFeishu({
        card: { schema: "2.0" },
        cfg: {} as never,
        replyToMessageId: "om_parent",
        to: "user:ou_target",
      }),
    ).rejects.toThrow("permission denied");

    expect(createMock).not.toHaveBeenCalled();
  });
});
