import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFrozenTime, useRealTime } from "../../../test/helpers/plugins/frozen-time.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  getLoadConfigMock,
  getOnHandler,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = harness;
const { createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot.js");

let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

function setOpenChannelPostConfig() {
  loadConfig.mockReturnValue({
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: {
          "-100777111222": {
            enabled: true,
            requireMention: false,
          },
        },
      },
    },
  });
}

function getChannelPostHandler() {
  createTelegramBot({ testTimings: TELEGRAM_TEST_TIMINGS, token: "tok" });
  return getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;
}

function resolveFlushTimer(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
    (call: Parameters<typeof setTimeout>) => call[1] === TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
  );
  const flushTimer =
    flushTimerCallIndex !== -1
      ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (flushTimerCallIndex !== -1) {
    clearTimeout(
      setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

function createImageFetchSpy(params?: { body?: Uint8Array; contentType?: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(Buffer.from(params?.body ?? [0x89, 0x50, 0x4E, 0x47]), {
        headers: { "content-type": params?.contentType ?? "image/png" },
        status: 200,
      }),
  );
}

function createChannelPostContext(params: {
  messageId: number;
  date: number;
  title?: string;
  caption?: string;
  text?: string;
  mediaGroupId?: string;
  photoFileId?: string;
  getFileResult?: Record<string, unknown>;
}) {
  const {photoFileId} = params;
  return {
    channelPost: {
      chat: { id: -100_777_111_222, title: params.title ?? "Wake Channel", type: "channel" },
      date: params.date,
      message_id: params.messageId,
      ...(params.caption ? { caption: params.caption } : {}),
      ...(params.text ? { text: params.text } : {}),
      ...(params.mediaGroupId ? { media_group_id: params.mediaGroupId } : {}),
      ...(photoFileId ? { photo: [{ file_id: photoFileId }] } : {}),
    },
    getFile: async () =>
      params.getFileResult ?? (photoFileId ? { file_path: `photos/${photoFileId}.jpg` } : {}),
    me: { username: "openclaw_bot" },
  };
}

async function flushChannelPostMediaGroup(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  const flushTimer = resolveFlushTimer(setTimeoutSpy);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
}

async function queueChannelPostAlbum(
  handler: ReturnType<typeof getChannelPostHandler>,
  params: {
    caption: string;
    mediaGroupId: string;
    firstMessageId: number;
    secondMessageId: number;
    firstPhotoFileId?: string;
    secondPhotoFileId?: string;
    secondGetFileResult?: Record<string, unknown>;
  },
) {
  const first = handler(
    createChannelPostContext({
      caption: params.caption,
      date: 1_736_380_800,
      mediaGroupId: params.mediaGroupId,
      messageId: params.firstMessageId,
      photoFileId: params.firstPhotoFileId ?? "p1",
    }),
  );
  const second = handler(
    createChannelPostContext({
      date: 1_736_380_801,
      getFileResult: params.secondGetFileResult,
      mediaGroupId: params.mediaGroupId,
      messageId: params.secondMessageId,
      photoFileId: params.secondPhotoFileId ?? "p2",
    }),
  );
  await Promise.all([first, second]);
}

describe("createTelegramBot channel_post media", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
  });

  beforeEach(() => {
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
  });

  it("buffers channel_post media groups and processes them together", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = createImageFetchSpy();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "album caption",
        firstMessageId: 201,
        mediaGroupId: "channel-album-1",
        secondMessageId: 202,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string };
      expect(payload.Body).toContain("album caption");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("coalesces channel_post near-limit text fragments into one message", async () => {
    setOpenChannelPostConfig();

    useFrozenTime("2026-02-20T00:00:00.000Z");
    try {
      const handler = getChannelPostHandler();

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        channelPost: {
          chat: { id: -100_777_111_222, title: "Wake Channel", type: "channel" },
          date: 1_736_380_800,
          message_id: 301,
          text: part1,
        },
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
      });

      await handler({
        channelPost: {
          chat: { id: -100_777_111_222, title: "Wake Channel", type: "channel" },
          date: 1_736_380_801,
          message_id: 302,
          text: part2,
        },
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 100);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    } finally {
      useRealTime();
    }
  });

  it("drops oversized channel_post media instead of dispatching a placeholder message", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = createImageFetchSpy({
      body: new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]),
      contentType: "image/jpeg",
    });

    createTelegramBot({ mediaMaxMb: 0, token: "tok" });
    const handler = getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      createChannelPostContext({
        date: 1_736_380_800,
        messageId: 401,
        photoFileId: "oversized",
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("notifies users when media download fails for direct messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Promise.reject(new Error("MediaFetchError: Failed to fetch media")),
      );

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "u", id: 55, is_bot: false },
          message_id: 411,
          photo: [{ file_id: "p1" }],
        },
      });

      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        "⚠️ Failed to download media. Please try again.",
        {
          reply_parameters: {
            allow_sending_without_reply: true,
            message_id: 411,
          },
        },
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("processes remaining media group photos when one photo download fails", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();

    let fetchCallIndex = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCallIndex++;
      if (fetchCallIndex === 2) {
        throw new Error("MediaFetchError: Failed to fetch media");
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), {
        headers: { "content-type": "image/png" },
        status: 200,
      });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "partial album",
        firstMessageId: 401,
        mediaGroupId: "partial-album-1",
        secondMessageId: 402,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0]?.[0] as { Body?: string };
      expect(payload.Body).toContain("partial album");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("drops the media group when a non-recoverable media error occurs", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();

    const fetchSpy = createImageFetchSpy();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "fatal album",
        firstMessageId: 501,
        mediaGroupId: "fatal-album-1",
        secondGetFileResult: {},
        secondMessageId: 502,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
