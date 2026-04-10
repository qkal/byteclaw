import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  replyMessageMock,
  showLoadingAnimationMock,
  getProfileMock,
  MessagingApiClientMock,
  loadConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
} = vi.hoisted(() => {
  const pushMessageMock = vi.fn();
  const replyMessageMock = vi.fn();
  const showLoadingAnimationMock = vi.fn();
  const getProfileMock = vi.fn();
  const MessagingApiClientMock = vi.fn(function  MessagingApiClientMock() {
    return {
      getProfile: getProfileMock,
      pushMessage: pushMessageMock,
      replyMessage: replyMessageMock,
      showLoadingAnimation: showLoadingAnimationMock,
    };
  });
  const loadConfigMock = vi.fn(() => ({}));
  const resolveLineAccountMock = vi.fn(() => ({ accountId: "default" }));
  const resolveLineChannelAccessTokenMock = vi.fn(() => "line-token");
  const recordChannelActivityMock = vi.fn();
  const logVerboseMock = vi.fn();
  return {
    MessagingApiClientMock,
    getProfileMock,
    loadConfigMock,
    logVerboseMock,
    pushMessageMock,
    recordChannelActivityMock,
    replyMessageMock,
    resolveLineAccountMock,
    resolveLineChannelAccessTokenMock,
    showLoadingAnimationMock,
  };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
  };
});

let sendModule: typeof import("./send.js");

describe("LINE send helpers", () => {
  beforeEach(async () => {
    vi.resetModules();
    pushMessageMock.mockReset();
    replyMessageMock.mockReset();
    showLoadingAnimationMock.mockReset();
    getProfileMock.mockReset();
    MessagingApiClientMock.mockReset();
    loadConfigMock.mockReset();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();

    MessagingApiClientMock.mockImplementation(function () {
      return {
        getProfile: getProfileMock,
        pushMessage: pushMessageMock,
        replyMessage: replyMessageMock,
        showLoadingAnimation: showLoadingAnimationMock,
      };
    });
    loadConfigMock.mockReturnValue({});
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    pushMessageMock.mockResolvedValue({});
    replyMessageMock.mockResolvedValue({});
    showLoadingAnimationMock.mockResolvedValue({});
    sendModule = await import("./send.js");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("limits quick reply items to 13", () => {
    const labels = Array.from({ length: 20 }, (_, index) => `Option ${index + 1}`);
    const quickReply = sendModule.createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("pushes images via normalized LINE target", async () => {
    const result = await sendModule.pushImageMessage(
      "line:user:U123",
      "https://example.com/original.jpg",
      undefined,
      { verbose: true },
    );

    expect(pushMessageMock).toHaveBeenCalledWith({
      messages: [
        {
          originalContentUrl: "https://example.com/original.jpg",
          previewImageUrl: "https://example.com/original.jpg",
          type: "image",
        },
      ],
      to: "U123",
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      accountId: "default",
      channel: "line",
      direction: "outbound",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: pushed image to U123");
    expect(result).toEqual({ chatId: "U123", messageId: "push" });
  });

  it("replies when reply token is provided", async () => {
    const result = await sendModule.sendMessageLine("line:group:C1", "Hello", {
      mediaUrl: "https://example.com/media.jpg",
      replyToken: "reply-token",
      verbose: true,
    });

    expect(replyMessageMock).toHaveBeenCalledTimes(1);
    expect(pushMessageMock).not.toHaveBeenCalled();
    expect(replyMessageMock).toHaveBeenCalledWith({
      messages: [
        {
          originalContentUrl: "https://example.com/media.jpg",
          previewImageUrl: "https://example.com/media.jpg",
          type: "image",
        },
        {
          text: "Hello",
          type: "text",
        },
      ],
      replyToken: "reply-token",
    });
    expect(logVerboseMock).toHaveBeenCalledWith("line: replied to C1");
    expect(result).toEqual({ chatId: "C1", messageId: "reply" });
  });

  it("sends video with explicit image preview URL", async () => {
    await sendModule.sendMessageLine("line:user:U100", "Video", {
      mediaKind: "video",
      mediaUrl: "https://example.com/video.mp4",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-1",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      messages: [
        {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-1",
          type: "video",
        },
        {
          text: "Video",
          type: "text",
        },
      ],
      to: "U100",
    });
  });

  it("throws when video preview URL is missing", async () => {
    await expect(
      sendModule.sendMessageLine("line:user:U200", "Video", {
        mediaKind: "video",
        mediaUrl: "https://example.com/video.mp4",
      }),
    ).rejects.toThrow(/require previewimageurl/i);
  });

  it("omits trackingId for non-user destinations", async () => {
    await sendModule.sendMessageLine("line:group:C100", "Video", {
      mediaKind: "video",
      mediaUrl: "https://example.com/video.mp4",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-group",
    });

    expect(pushMessageMock).toHaveBeenCalledWith({
      messages: [
        {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          type: "video",
        },
        {
          text: "Video",
          type: "text",
        },
      ],
      to: "C100",
    });
  });

  it("throws when push messages are empty", async () => {
    await expect(sendModule.pushMessagesLine("U123", [])).rejects.toThrow(
      "Message must be non-empty for LINE sends",
    );
  });

  it("logs HTTP body when push fails", async () => {
    const err = new Error("LINE push failed") as Error & {
      status: number;
      statusText: string;
      body: string;
    };
    err.status = 400;
    err.statusText = "Bad Request";
    err.body = "invalid flex payload";
    pushMessageMock.mockRejectedValueOnce(err);

    await expect(
      sendModule.pushMessagesLine("U999", [{ text: "hello", type: "text" }]),
    ).rejects.toThrow("LINE push failed");

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: push message failed (400 Bad Request): invalid flex payload",
    );
  });

  it("caches profile results by default", async () => {
    getProfileMock.mockResolvedValue({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });

    const first = await sendModule.getUserProfile("U-cache");
    const second = await sendModule.getUserProfile("U-cache");

    expect(first).toEqual({
      displayName: "Peter",
      pictureUrl: "https://example.com/peter.jpg",
    });
    expect(second).toEqual(first);
    expect(getProfileMock).toHaveBeenCalledTimes(1);
  });

  it("continues when loading animation is unsupported", async () => {
    showLoadingAnimationMock.mockRejectedValueOnce(new Error("unsupported"));

    await expect(sendModule.showLoadingAnimation("line:room:R1")).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("line: loading animation failed (non-fatal)"),
    );
  });

  it("pushes quick-reply text and caps to 13 buttons", async () => {
    await sendModule.pushTextMessageWithQuickReplies(
      "U-quick",
      "Pick one",
      Array.from({ length: 20 }, (_, index) => `Choice ${index + 1}`),
    );

    expect(pushMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageMock.mock.calls[0] as [
      { messages: { quickReply?: { items: unknown[] } }[] },
    ];
    expect(firstCall[0].messages[0].quickReply?.items).toHaveLength(13);
  });
});
