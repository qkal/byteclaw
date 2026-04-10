import { ChannelType, type Client, type Message } from "@buape/carbon";
import { MessageReferenceType, StickerFormatType } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchRemoteMedia = vi.fn();
const saveMediaBuffer = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: () => {},
  };
});

let __resetDiscordChannelInfoCacheForTest: typeof import("./message-utils.js").__resetDiscordChannelInfoCacheForTest;
let resolveDiscordChannelInfo: typeof import("./message-utils.js").resolveDiscordChannelInfo;
let resolveDiscordMessageChannelId: typeof import("./message-utils.js").resolveDiscordMessageChannelId;
let resolveDiscordMessageText: typeof import("./message-utils.js").resolveDiscordMessageText;
let resolveForwardedMediaList: typeof import("./message-utils.js").resolveForwardedMediaList;
let resolveMediaList: typeof import("./message-utils.js").resolveMediaList;

beforeAll(async () => {
  ({
    __resetDiscordChannelInfoCacheForTest,
    resolveDiscordChannelInfo,
    resolveDiscordMessageChannelId,
    resolveDiscordMessageText,
    resolveForwardedMediaList,
    resolveMediaList,
  } = await import("./message-utils.js"));
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

function expectDiscordCdnSsrFPolicy(policy: unknown) {
  expect(policy).toEqual(
    expect.objectContaining({
      allowRfc2544BenchmarkRange: true,
      hostnameAllowlist: expect.arrayContaining(DISCORD_CDN_HOSTNAMES),
    }),
  );
}

function expectSinglePngDownload(params: {
  result: unknown;
  expectedUrl: string;
  filePathHint: string;
  expectedPath: string;
  placeholder: "<media:image>" | "<media:sticker>";
}) {
  expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
  const call = fetchRemoteMedia.mock.calls[0]?.[0] as {
    url?: string;
    filePathHint?: string;
    maxBytes?: number;
    fetchImpl?: unknown;
    readIdleTimeoutMs?: number;
    requestInit?: { signal?: AbortSignal };
    ssrfPolicy?: unknown;
  };
  expect(call).toMatchObject({
    fetchImpl: undefined,
    filePathHint: params.filePathHint,
    maxBytes: 512,
    url: params.expectedUrl,
  });
  expectDiscordCdnSsrFPolicy(call.ssrfPolicy);
  expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
  expect(saveMediaBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "inbound", 512);
  expect(params.result).toEqual([
    {
      contentType: "image/png",
      path: params.expectedPath,
      placeholder: params.placeholder,
    },
  ]);
}

function expectAttachmentImageFallback(params: { result: unknown; attachment: { url: string } }) {
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(params.result).toEqual([
    {
      contentType: "image/png",
      path: params.attachment.url,
      placeholder: "<media:image>",
    },
  ]);
}

function asForwardedSnapshotMessage(params: {
  content: string;
  embeds: { title?: string; description?: string }[];
}) {
  return asMessage({
    content: "",
    rawData: {
      message_snapshots: [
        {
          message: {
            attachments: [],
            author: {
              discriminator: "0",
              id: "u2",
              username: "Bob",
            },
            content: params.content,
            embeds: params.embeds,
          },
        },
      ],
    },
  });
}

function asReferencedForwardMessage(params: {
  content?: string;
  embeds?: { title?: string; description?: string }[];
  attachments?: Record<string, unknown>[];
  messageReferenceType?: MessageReferenceType;
}) {
  return asMessage({
    content: "",
    messageReference: {
      channel_id: "c1",
      message_id: "m0",
      type: params.messageReferenceType ?? MessageReferenceType.Forward,
    },
    referencedMessage: asMessage({
      attachments: params.attachments ?? [],
      author: {
        discriminator: "0",
        id: "u2",
        username: "Bob",
      },
      channelId: "c1",
      content: params.content ?? "",
      embeds: params.embeds ?? [],
      id: "m0",
      stickers: [],
    }),
  });
}

describe("resolveDiscordMessageChannelId", () => {
  it.each([
    {
      expected: "123",
      name: "uses message.channelId when present",
      params: { message: asMessage({ channelId: " 123 " }) },
    },
    {
      expected: "234",
      name: "falls back to message.channel_id",
      params: { message: asMessage({ channel_id: " 234 " }) },
    },
    {
      expected: "456",
      name: "falls back to message.rawData.channel_id",
      params: { message: asMessage({ rawData: { channel_id: "456" } }) },
    },
    {
      expected: "789",
      name: "falls back to eventChannelId and coerces numeric values",
      params: { eventChannelId: 789, message: asMessage({}) },
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveDiscordMessageChannelId(params)).toBe(expected);
  });
});

describe("resolveForwardedMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads forwarded attachments", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "image.png",
      id: "att-1",
      url: "https://cdn.discordapp.com/attachments/1/image.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/image.png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
    );

    expectSinglePngDownload({
      expectedPath: "/tmp/image.png",
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      placeholder: "<media:image>",
      result,
    });
  });

  it("forwards fetchImpl to forwarded attachment downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const attachment = {
      content_type: "image/png",
      filename: "proxy.png",
      id: "att-proxy",
      url: "https://cdn.discordapp.com/attachments/1/proxy.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/proxy.png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "fallback.png",
      id: "att-fallback",
      url: "https://cdn.discordapp.com/attachments/1/fallback.png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
    );

    expectAttachmentImageFallback({ attachment, result });
  });

  it("downloads forwarded stickers", async () => {
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-1",
      name: "wave",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/sticker.png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { sticker_items: [sticker] } }],
        },
      }),
      512,
    );

    expectSinglePngDownload({
      expectedPath: "/tmp/sticker.png",
      expectedUrl: "https://media.discordapp.net/stickers/sticker-1.png",
      filePathHint: "wave.png",
      placeholder: "<media:sticker>",
      result,
    });
  });

  it("returns empty when no snapshots are present", async () => {
    const result = await resolveForwardedMediaList(asMessage({}), 512);

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("downloads forwarded referenced attachments when snapshots are absent", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "ref-image.png",
      id: "att-ref-1",
      url: "https://cdn.discordapp.com/attachments/1/ref-image.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/ref-image.png",
    });

    const result = await resolveForwardedMediaList(
      asReferencedForwardMessage({
        attachments: [attachment],
      }),
      512,
    );

    expectSinglePngDownload({
      expectedPath: "/tmp/ref-image.png",
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      placeholder: "<media:image>",
      result,
    });
  });

  it("skips snapshots without attachments", async () => {
    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { content: "hello" } }],
        },
      }),
      512,
    );

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("passes readIdleTimeoutMs to forwarded attachment downloads", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "forwarded-timeout.png",
      id: "att-timeout-forwarded",
      url: "https://cdn.discordapp.com/attachments/1/forwarded-timeout.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/forwarded-timeout.png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("passes readIdleTimeoutMs to forwarded sticker downloads", async () => {
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-timeout-forwarded",
      name: "timeout-forwarded",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/forwarded-sticker-timeout.png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { sticker_items: [sticker] } }],
        },
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });
});

describe("resolveMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads stickers", async () => {
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-2",
      name: "hello",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/sticker-2.png",
    });

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expectSinglePngDownload({
      expectedPath: "/tmp/sticker-2.png",
      expectedUrl: "https://media.discordapp.net/stickers/sticker-2.png",
      filePathHint: "hello.png",
      placeholder: "<media:sticker>",
      result,
    });
  });

  it("forwards fetchImpl to sticker downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-proxy",
      name: "proxy-sticker",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/sticker-proxy.png",
    });

    await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "main-fallback.png",
      id: "att-main-fallback",
      url: "https://cdn.discordapp.com/attachments/1/main-fallback.png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expectAttachmentImageFallback({ attachment, result });
  });

  it("falls back to URL when saveMediaBuffer fails", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "photo.png",
      id: "att-save-fail",
      url: "https://cdn.discordapp.com/attachments/1/photo.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockRejectedValueOnce(new Error("disk full"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        contentType: "image/png",
        path: attachment.url,
        placeholder: "<media:image>",
      },
    ]);
  });

  it("preserves downloaded attachments alongside failed ones", async () => {
    const goodAttachment = {
      content_type: "image/png",
      filename: "good.png",
      id: "att-good",
      url: "https://cdn.discordapp.com/attachments/1/good.png",
    };
    const badAttachment = {
      content_type: "application/pdf",
      filename: "bad.pdf",
      id: "att-bad",
      url: "https://cdn.discordapp.com/attachments/1/bad.pdf",
    };

    fetchRemoteMedia
      .mockResolvedValueOnce({
        buffer: Buffer.from("image"),
        contentType: "image/png",
      })
      .mockRejectedValueOnce(new Error("network timeout"));
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/good.png",
    });

    const result = await resolveMediaList(
      asMessage({
        attachments: [goodAttachment, badAttachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        contentType: "image/png",
        path: "/tmp/good.png",
        placeholder: "<media:image>",
      },
      {
        contentType: "application/pdf",
        path: badAttachment.url,
        placeholder: "<media:document>",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-fallback",
      name: "fallback",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        contentType: "image/png",
        path: "https://media.discordapp.net/stickers/sticker-fallback.png",
        placeholder: "<media:sticker>",
      },
    ]);
  });

  it("passes readIdleTimeoutMs to fetchRemoteMedia for attachments", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "timeout.png",
      id: "att-timeout",
      url: "https://cdn.discordapp.com/attachments/1/timeout.png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/timeout.png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("passes readIdleTimeoutMs to fetchRemoteMedia for stickers", async () => {
    const sticker = {
      format_type: StickerFormatType.PNG,
      id: "sticker-timeout",
      name: "timeout",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/sticker-timeout.png",
    });

    await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("times out slow attachment downloads and returns fallback", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "slow.png",
      id: "att-total-timeout",
      url: "https://cdn.discordapp.com/attachments/1/slow.png",
    };
    vi.useFakeTimers();
    fetchRemoteMedia.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves
        }),
    );

    try {
      const resultPromise = resolveMediaList(
        asMessage({
          attachments: [attachment],
        }),
        512,
        { totalTimeoutMs: 100 },
      );

      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toEqual([
        {
          contentType: "image/png",
          path: attachment.url,
          placeholder: "<media:image>",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes abortSignal to fetchRemoteMedia and falls back when aborted", async () => {
    const attachment = {
      content_type: "image/png",
      filename: "abort.png",
      id: "att-abort",
      url: "https://cdn.discordapp.com/attachments/1/abort.png",
    };
    const abortController = new AbortController();
    fetchRemoteMedia.mockImplementationOnce(
      (params: { requestInit?: { signal?: AbortSignal } }) =>
        new Promise((_, reject) => {
          const signal = params.requestInit?.signal;
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          if (signal?.aborted) {
            reject(abortError);
            return;
          }
          signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    );

    const resultPromise = resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
      { abortSignal: abortController.signal },
    );
    abortController.abort();

    await expect(resultPromise).resolves.toEqual([
      {
        contentType: "image/png",
        path: attachment.url,
        placeholder: "<media:image>",
      },
    ]);
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: expect.objectContaining({ signal: abortController.signal }),
      }),
    );
  });
});

describe("Discord media SSRF policy", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("passes Discord CDN hostname allowlist with RFC2544 enabled", async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/a.png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [{ filename: "a.png", id: "a1", url: "https://cdn.discordapp.com/a.png" }],
      }),
      1024,
    );

    const policy = fetchRemoteMedia.mock.calls[0]?.[0]?.ssrfPolicy;
    expectDiscordCdnSsrFPolicy(policy);
  });

  it("merges provided ssrfPolicy with Discord CDN defaults", async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      path: "/tmp/b.png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [{ filename: "b.png", id: "b1", url: "https://cdn.discordapp.com/b.png" }],
      }),
      1024,
      {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedHostnames: ["assets.example.com"],
          hostnameAllowlist: ["assets.example.com"],
        },
      },
    );

    const policy = fetchRemoteMedia.mock.calls[0]?.[0]?.ssrfPolicy;
    expect(policy).toEqual(
      expect.objectContaining({
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        allowedHostnames: expect.arrayContaining(["assets.example.com"]),
        hostnameAllowlist: expect.arrayContaining(["assets.example.com", ...DISCORD_CDN_HOSTNAMES]),
      }),
    );
  });
});

describe("resolveDiscordMessageText", () => {
  it("includes forwarded message snapshots in body text", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "forwarded hello",
        embeds: [],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded hello");
  });

  it("falls back to referenced forward message text when snapshots are absent", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        content: "forwarded from referenced message",
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded from referenced message");
  });

  it("does not treat ordinary replies as forwarded context", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        content: "quoted reply content",
        messageReferenceType: MessageReferenceType.Default,
      }),
      { includeForwarded: true },
    );

    expect(text).toBe("");
  });

  it("resolves user mentions in content", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello <@123> and <@456>!",
        mentionedUsers: [
          { discriminator: "0", globalName: "Alice Wonderland", id: "123", username: "alice" },
          { discriminator: "0", id: "456", username: "bob" },
        ],
      }),
    );
    expect(text).toBe("Hello @Alice Wonderland and @bob!");
  });

  it("leaves content unchanged if no mentions present", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello world",
        mentionedUsers: [],
      }),
    );
    expect(text).toBe("Hello world");
  });

  it("uses sticker placeholders when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        stickers: [
          {
            format_type: StickerFormatType.PNG,
            id: "sticker-3",
            name: "party",
          },
        ],
      }),
    );

    expect(text).toBe("<media:sticker> (1 sticker)");
  });

  it("uses embed title when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ title: "Breaking" }],
      }),
    );

    expect(text).toBe("Breaking");
  });

  it("uses embed description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ description: "Details" }],
      }),
    );

    expect(text).toBe("Details");
  });

  it("joins embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ description: "Details", title: "Breaking" }],
      }),
    );

    expect(text).toBe("Breaking\nDetails");
  });

  it("prefers message content over embed fallback text", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "hello from content",
        embeds: [{ description: "Details", title: "Breaking" }],
      }),
    );

    expect(text).toBe("hello from content");
  });

  it("joins forwarded snapshot embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "",
        embeds: [{ description: "Forwarded details", title: "Forwarded title" }],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("Forwarded title\nForwarded details");
  });
});

describe("resolveDiscordChannelInfo", () => {
  beforeEach(() => {
    __resetDiscordChannelInfoCacheForTest();
  });

  it("caches channel lookups between calls", async () => {
    const fetchChannel = vi.fn().mockResolvedValue({
      name: "dm",
      type: ChannelType.DM,
    });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "cache-channel-1");
    const second = await resolveDiscordChannelInfo(client, "cache-channel-1");

    expect(first).toEqual({
      name: "dm",
      ownerId: undefined,
      parentId: undefined,
      topic: undefined,
      type: ChannelType.DM,
    });
    expect(second).toEqual(first);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("negative-caches missing channels", async () => {
    const fetchChannel = vi.fn().mockResolvedValue(null);
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "missing-channel");
    const second = await resolveDiscordChannelInfo(client, "missing-channel");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });
});
