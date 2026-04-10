import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

interface LineRuntimeMocks {
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  pushFlexMessage: ReturnType<typeof vi.fn>;
  pushTemplateMessage: ReturnType<typeof vi.fn>;
  pushLocationMessage: ReturnType<typeof vi.fn>;
  pushTextMessageWithQuickReplies: ReturnType<typeof vi.fn>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  sendMessageLine: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
}

function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => ({ chatId: "c1", messageId: "m-text" }));
  const pushMessagesLine = vi.fn(async () => ({ chatId: "c1", messageId: "m-batch" }));
  const pushFlexMessage = vi.fn(async () => ({ chatId: "c1", messageId: "m-flex" }));
  const pushTemplateMessage = vi.fn(async () => ({ chatId: "c1", messageId: "m-template" }));
  const pushLocationMessage = vi.fn(async () => ({ chatId: "c1", messageId: "m-loc" }));
  const pushTextMessageWithQuickReplies = vi.fn(async () => ({
    chatId: "c1",
    messageId: "m-quick",
  }));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({ type: "buttons" }));
  const sendMessageLine = vi.fn(async () => ({ chatId: "c1", messageId: "m-media" }));
  const chunkMarkdownText = vi.fn((text: string) => [text]);
  const resolveTextChunkLimit = vi.fn(() => 123);
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const resolved = accountId ?? "default";
      const lineConfig = (cfg.channels?.line ?? {}) as {
        accounts?: Record<string, Record<string, unknown>>;
      };
      const accountConfig = resolved !== "default" ? (lineConfig.accounts?.[resolved] ?? {}) : {};
      return {
        accountId: resolved,
        config: { ...lineConfig, ...accountConfig },
      };
    },
  );

  const runtime = {
    channel: {
      line: {
        buildTemplateMessageFromPayload,
        createQuickReplyItems,
        pushFlexMessage,
        pushLocationMessage,
        pushMessageLine,
        pushMessagesLine,
        pushTemplateMessage,
        pushTextMessageWithQuickReplies,
        resolveLineAccount,
        sendMessageLine,
      },
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    mocks: {
      buildTemplateMessageFromPayload,
      chunkMarkdownText,
      createQuickReplyItems,
      pushFlexMessage,
      pushLocationMessage,
      pushMessageLine,
      pushMessagesLine,
      pushTemplateMessage,
      pushTextMessageWithQuickReplies,
      resolveLineAccount,
      resolveTextChunkLimit,
      sendMessageLine,
    },
    runtime,
  };
}

describe("linePlugin outbound.sendPayload", () => {
  it("preserves resolved accountId when pairing notifications push directly", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = {
      channels: {
        line: {
          accounts: {
            primary: {
              channelAccessToken: "token-primary",
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveLineAccount.mockReturnValue({
      accountId: "primary",
      channelAccessToken: "token-primary",
      config: {},
    });

    await linePlugin.pairing!.notifyApproval!({
      cfg,
      id: "line:user:1",
    });

    expect(mocks.pushMessageLine).toHaveBeenCalledWith(
      "line:user:1",
      "OpenClaw: your access has been approved.",
      {
        accountId: "primary",
        channelAccessToken: "token-primary",
      },
    );
  });

  it("sends flex message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          flexMessage: {
            altText: "Now playing",
            contents: { type: "bubble" },
          },
        },
      },
      text: "Now playing:",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: payload.text,
      to: "line:group:1",
    });

    expect(mocks.pushFlexMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:group:1", "Now playing:", {
      accountId: "default",
      cfg,
      verbose: false,
    });
  });

  it("sends template message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          templateMessage: {
            cancelData: "no",
            cancelLabel: "No",
            confirmData: "yes",
            confirmLabel: "Yes",
            text: "Continue?",
            type: "confirm",
          },
        },
      },
      text: "Choose one:",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: payload.text,
      to: "line:user:1",
    });

    expect(mocks.buildTemplateMessageFromPayload).toHaveBeenCalledTimes(1);
    expect(mocks.pushTemplateMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:user:1", "Choose one:", {
      accountId: "default",
      cfg,
      verbose: false,
    });
  });

  it("attaches quick replies when no text chunks are present", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
          quickReplies: ["One", "Two"],
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: "",
      to: "line:user:2",
    });

    expect(mocks.pushFlexMessage).not.toHaveBeenCalled();
    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:2",
      [
        {
          altText: "Card",
          contents: { type: "bubble" },
          quickReply: { items: ["One", "Two"] },
          type: "flex",
        },
      ],
      { accountId: "default", cfg, verbose: false },
    );
    expect(mocks.createQuickReplyItems).toHaveBeenCalledWith(["One", "Two"]);
  });

  it("sends media before quick-reply text so buttons stay visible", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
        },
      },
      mediaUrl: "https://example.com/img.jpg",
      text: "Hello",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: payload.text,
      to: "line:user:3",
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith(
      "line:user:3",
      "",
      expect.objectContaining({
        accountId: "default",
        cfg,
        mediaUrl: "https://example.com/img.jpg",
        verbose: false,
      }),
    );
    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
      "line:user:3",
      "Hello",
      ["One", "Two"],
      { accountId: "default", cfg, verbose: false },
    );
    const mediaOrder = mocks.sendMessageLine.mock.invocationCallOrder[0];
    const quickReplyOrder = mocks.pushTextMessageWithQuickReplies.mock.invocationCallOrder[0];
    expect(mediaOrder).toBeLessThan(quickReplyOrder);
  });

  it("keeps generic media payloads on the image-only send path", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload: {
        mediaUrl: "https://example.com/video.mp4",
      },
      text: "",
      to: "line:user:4",
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:4", "", {
      accountId: "default",
      cfg,
      mediaUrl: "https://example.com/video.mp4",
      verbose: false,
    });
  });

  it("uses LINE-specific media options for rich media payloads", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload: {
        channelData: {
          line: {
            mediaKind: "video",
            previewImageUrl: "https://example.com/preview.jpg",
            trackingId: "track-123",
          },
        },
        mediaUrl: "https://example.com/video.mp4",
      },
      text: "",
      to: "line:user:5",
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:5", "", {
      accountId: "default",
      cfg,
      durationMs: undefined,
      mediaKind: "video",
      mediaUrl: "https://example.com/video.mp4",
      previewImageUrl: "https://example.com/preview.jpg",
      trackingId: "track-123",
      verbose: false,
    });
  });

  it("uses configured text chunk limit for payloads", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: { textChunkLimit: 123 } } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
        },
      },
      text: "Hello world",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "primary",
      cfg,
      payload,
      text: payload.text,
      to: "line:user:3",
    });

    expect(mocks.resolveTextChunkLimit).toHaveBeenCalledWith(cfg, "line", "primary", {
      fallbackLimit: 5000,
    });
    expect(mocks.chunkMarkdownText).toHaveBeenCalledWith("Hello world", 123);
  });

  it("omits trackingId for non-user quick-reply inline video media", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          mediaKind: "video" as const,
          previewImageUrl: "https://example.com/preview.jpg",
          quickReplies: ["One"],
          trackingId: "track-group",
        },
      },
      mediaUrl: "https://example.com/video.mp4",
      text: "",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: payload.text,
      to: "line:group:C123",
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:group:C123",
      [
        {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          quickReply: { items: ["One"] },
          type: "video",
        },
      ],
      { accountId: "default", cfg, verbose: false },
    );
  });

  it("keeps trackingId for user quick-reply inline video media", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          mediaKind: "video" as const,
          previewImageUrl: "https://example.com/preview.jpg",
          quickReplies: ["One"],
          trackingId: "track-user",
        },
      },
      mediaUrl: "https://example.com/video.mp4",
      text: "",
    };

    await linePlugin.outbound!.sendPayload!({
      accountId: "default",
      cfg,
      payload,
      text: payload.text,
      to: "line:user:U123",
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:U123",
      [
        {
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          quickReply: { items: ["One"] },
          trackingId: "track-user",
          type: "video",
        },
      ],
      { accountId: "default", cfg, verbose: false },
    );
  });

  it("rejects quick-reply inline video media without previewImageUrl", async () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          mediaKind: "video" as const,
          quickReplies: ["One"],
        },
      },
      mediaUrl: "https://example.com/video.mp4",
      text: "",
    };

    await expect(
      linePlugin.outbound!.sendPayload!({
        accountId: "default",
        cfg,
        payload,
        text: payload.text,
        to: "line:user:U123",
      }),
    ).rejects.toThrow(/require previewimageurl/i);
  });
});

describe("linePlugin config.formatAllowFrom", () => {
  it("strips line:user: prefixes without lowercasing", () => {
    const formatted = linePlugin.config.formatAllowFrom!({
      allowFrom: ["line:user:UABC", "line:UDEF"],
      cfg: {} as OpenClawConfig,
    });
    expect(formatted).toEqual(["UABC", "UDEF"]);
  });
});

describe("linePlugin groups.resolveRequireMention", () => {
  it("uses account-level group settings when provided", () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);

    const cfg = {
      channels: {
        line: {
          accounts: {
            primary: {
              groups: {
                "group-1": { requireMention: true },
              },
            },
          },
          groups: {
            "*": { requireMention: false },
          },
        },
      },
    } as OpenClawConfig;

    const requireMention = linePlugin.groups!.resolveRequireMention!({
      accountId: "primary",
      cfg,
      groupId: "group-1",
    });

    expect(requireMention).toBe(true);
  });
});
