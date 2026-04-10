import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendC2CImageMessage: vi.fn(),
  sendC2CMessage: vi.fn(),
  sendChannelMessage: vi.fn(),
  sendDmMessage: vi.fn(),
  sendGroupImageMessage: vi.fn(),
  sendGroupMessage: vi.fn(),
}));

const outboundMocks = vi.hoisted(() => ({
  sendDocument: vi.fn(async () => ({})),
  sendMedia: vi.fn(async () => ({})),
  sendPhoto: vi.fn(async () => ({})),
  sendVideoMsg: vi.fn(async () => ({})),
  sendVoice: vi.fn(async () => ({})),
}));

const runtimeMocks = vi.hoisted(() => ({
  chunkMarkdownText: vi.fn((text: string) => [text]),
}));

vi.mock("./api.js", () => ({
  sendC2CImageMessage: apiMocks.sendC2CImageMessage,
  sendC2CMessage: apiMocks.sendC2CMessage,
  sendChannelMessage: apiMocks.sendChannelMessage,
  sendDmMessage: apiMocks.sendDmMessage,
  sendGroupImageMessage: apiMocks.sendGroupImageMessage,
  sendGroupMessage: apiMocks.sendGroupMessage,
}));

vi.mock("./outbound.js", () => ({
  sendDocument: outboundMocks.sendDocument,
  sendMedia: outboundMocks.sendMedia,
  sendPhoto: outboundMocks.sendPhoto,
  sendVideoMsg: outboundMocks.sendVideoMsg,
  sendVoice: outboundMocks.sendVoice,
}));

vi.mock("./runtime.js", () => ({
  getQQBotRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: runtimeMocks.chunkMarkdownText,
      },
    },
  }),
}));

const imageSizeMocks = vi.hoisted(() => ({
  formatQQBotMarkdownImage: vi.fn(),
  getImageSize: vi.fn(),
  hasQQBotImageSize: vi.fn(),
}));

vi.mock("./utils/image-size.js", () => ({
  formatQQBotMarkdownImage: (...args: unknown[]) =>
    imageSizeMocks.formatQQBotMarkdownImage(...args),
  getImageSize: (...args: unknown[]) => imageSizeMocks.getImageSize(...args),
  hasQQBotImageSize: (...args: unknown[]) => imageSizeMocks.hasQQBotImageSize(...args),
}));

import {
  parseAndSendMediaTags,
  sendPlainReply,
  type ConsumeQuoteRefFn,
  type DeliverAccountContext,
  type DeliverEventContext,
  type SendWithRetryFn,
} from "./outbound-deliver.js";

function buildEvent(): DeliverEventContext {
  return {
    messageId: "msg-1",
    senderId: "user-1",
    type: "c2c",
  };
}

function buildAccountContext(markdownSupport: boolean): DeliverAccountContext {
  return {
    account: {
      accountId: "default",
      appId: "app-id",
      clientSecret: "secret",
      config: {},
      markdownSupport,
    } as DeliverAccountContext["account"],
    log: {
      error: vi.fn(),
      info: vi.fn(),
    },
    qualifiedTarget: "qqbot:c2c:user-1",
  };
}

const sendWithRetry: SendWithRetryFn = async (sendFn) => await sendFn("token");
const consumeQuoteRef: ConsumeQuoteRefFn = () => undefined;

describe("qqbot outbound deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.chunkMarkdownText.mockImplementation((text: string) => [text]);
    imageSizeMocks.getImageSize.mockResolvedValue(null);
    imageSizeMocks.formatQQBotMarkdownImage.mockImplementation((url: string) => `![img](${url})`);
    imageSizeMocks.hasQQBotImageSize.mockReturnValue(false);
  });

  it("sends plain replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello plain world",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello plain world",
      "msg-1",
      undefined,
    );
  });

  it("sends markdown replies through the shared text chunk sender", async () => {
    await sendPlainReply(
      {},
      "hello markdown world",
      buildEvent(),
      buildAccountContext(true),
      sendWithRetry,
      consumeQuoteRef,
      [],
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenCalledWith(
      "app-id",
      "token",
      "user-1",
      "hello markdown world",
      "msg-1",
      undefined,
    );
  });

  it("routes media-tag text segments through the shared chunk sender", async () => {
    await parseAndSendMediaTags(
      "before<qqimg>https://example.com/a.png</qqimg>after",
      buildEvent(),
      buildAccountContext(false),
      sendWithRetry,
      consumeQuoteRef,
    );

    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      1,
      "app-id",
      "token",
      "user-1",
      "before",
      "msg-1",
      undefined,
    );
    expect(apiMocks.sendC2CMessage).toHaveBeenNthCalledWith(
      2,
      "app-id",
      "token",
      "user-1",
      "after",
      "msg-1",
      undefined,
    );
    expect(outboundMocks.sendPhoto).toHaveBeenCalledTimes(1);
  });

  describe("private-network image URL degradation", () => {
    it("sends markdown reply with fallback dimensions when getImageSize returns null", async () => {
      imageSizeMocks.getImageSize.mockResolvedValue(null);

      await sendPlainReply(
        {},
        "Look at this: ![photo](https://10.0.0.1/internal.png)",
        buildEvent(),
        buildAccountContext(true),
        sendWithRetry,
        consumeQuoteRef,
        [],
      );

      // GetImageSize was called with the private-network URL
      expect(imageSizeMocks.getImageSize).toHaveBeenCalledWith("https://10.0.0.1/internal.png");
      // FormatQQBotMarkdownImage was called with null size (triggers default dimensions)
      expect(imageSizeMocks.formatQQBotMarkdownImage).toHaveBeenCalledWith(
        "https://10.0.0.1/internal.png",
        null,
      );
      // Message was still sent (not crashed)
      expect(apiMocks.sendC2CMessage).toHaveBeenCalled();
    });

    it("sends markdown reply with fallback when getImageSize throws", async () => {
      imageSizeMocks.getImageSize.mockRejectedValue(new Error("SSRF blocked"));

      await sendPlainReply(
        {},
        "Check ![img](https://169.254.169.254/latest/meta-data/)",
        buildEvent(),
        buildAccountContext(true),
        sendWithRetry,
        consumeQuoteRef,
        [],
      );

      // FormatQQBotMarkdownImage still called with null (catch path in outbound-deliver)
      expect(imageSizeMocks.formatQQBotMarkdownImage).toHaveBeenCalledWith(
        "https://169.254.169.254/latest/meta-data/",
        null,
      );
      expect(apiMocks.sendC2CMessage).toHaveBeenCalled();
    });
  });
});
