import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandlerWithOptions,
  describeStickerImageSpy,
  getCachedStickerSpy,
} from "./bot.media.test-utils.js";

describe("telegram stickers", () => {
  const STICKER_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  async function createStaticStickerHarness() {
    const proxyFetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from(new Uint8Array([0x52, 0x49, 0x46, 0x46])), {
        headers: { "content-type": "image/webp" },
        status: 200,
      }),
    );
    const handlerContext = await createBotHandlerWithOptions({
      proxyFetch: proxyFetch as unknown as typeof fetch,
    });
    return { proxyFetch, ...handlerContext };
  }

  beforeEach(() => {
    cacheStickerSpy.mockClear();
    getCachedStickerSpy.mockClear();
    describeStickerImageSpy.mockClear();
    // Re-seed defaults so per-test overrides do not leak when using mockClear.
    getCachedStickerSpy.mockReturnValue(undefined);
    describeStickerImageSpy.mockReturnValue(undefined);
  });

  // TODO #50185: re-enable once deterministic static sticker fetch injection is in place.
  it.skip(
    "downloads static sticker (WEBP) and includes sticker metadata",
    async () => {
      const { handler, proxyFetch, replySpy, runtimeError } = await createStaticStickerHarness();

      await handler({
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 777, is_bot: false },
          message_id: 100,
          sticker: {
            emoji: "🎉",
            file_id: "sticker_file_id_123",
            file_unique_id: "sticker_unique_123",
            height: 512,
            is_animated: false,
            is_video: false,
            set_name: "TestStickerPack",
            type: "regular",
            width: 512,
          },
        },
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(proxyFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/stickers/sticker.webp",
        expect.objectContaining({ redirect: "manual" }),
      );
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("<media:sticker>");
      expect(payload.Sticker?.emoji).toBe("🎉");
      expect(payload.Sticker?.setName).toBe("TestStickerPack");
      expect(payload.Sticker?.fileId).toBe("sticker_file_id_123");
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  // TODO #50185: re-enable with deterministic cache-refresh assertions in CI.
  it.skip(
    "refreshes cached sticker metadata on cache hit",
    async () => {
      const { handler, proxyFetch, replySpy, runtimeError } = await createStaticStickerHarness();

      getCachedStickerSpy.mockReturnValue({
        cachedAt: "2026-01-20T10:00:00.000Z",
        description: "Cached description",
        emoji: "😴",
        fileId: "old_file_id",
        fileUniqueId: "sticker_unique_456",
        setName: "OldSet",
      });

      await handler({
        getFile: async () => ({ file_path: "stickers/sticker.webp" }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 777, is_bot: false },
          message_id: 103,
          sticker: {
            emoji: "🔥",
            file_id: "new_file_id",
            file_unique_id: "sticker_unique_456",
            height: 512,
            is_animated: false,
            is_video: false,
            set_name: "NewSet",
            type: "regular",
            width: 512,
          },
        },
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(cacheStickerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          emoji: "🔥",
          fileId: "new_file_id",
          setName: "NewSet",
        }),
      );
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Sticker?.fileId).toBe("new_file_id");
      expect(payload.Sticker?.cachedDescription).toBe("Cached description");
      expect(proxyFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/file/bottok/stickers/sticker.webp",
        expect.objectContaining({ redirect: "manual" }),
      );
    },
    STICKER_TEST_TIMEOUT_MS,
  );

  it(
    "skips animated and video sticker formats that cannot be downloaded",
    async () => {
      const proxyFetch = vi.fn();
      const { handler, replySpy, runtimeError } = await createBotHandlerWithOptions({
        proxyFetch: proxyFetch as unknown as typeof fetch,
      });

      for (const scenario of [
        {
          filePath: "stickers/animated.tgs",
          messageId: 101,
          sticker: {
            emoji: "😎",
            file_id: "animated_sticker_id",
            file_unique_id: "animated_unique",
            height: 512,
            is_animated: true,
            is_video: false,
            set_name: "AnimatedPack",
            type: "regular",
            width: 512,
          },
        },
        {
          filePath: "stickers/video.webm",
          messageId: 102,
          sticker: {
            emoji: "🎬",
            file_id: "video_sticker_id",
            file_unique_id: "video_unique",
            height: 512,
            is_animated: false,
            is_video: true,
            set_name: "VideoPack",
            type: "regular",
            width: 512,
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        proxyFetch.mockClear();

        await handler({
          getFile: async () => ({ file_path: scenario.filePath }),
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            from: { first_name: "Ada", id: 777, is_bot: false },
            message_id: scenario.messageId,
            sticker: scenario.sticker,
          },
        });

        expect(proxyFetch).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
      }
    },
    STICKER_TEST_TIMEOUT_MS,
  );
});

describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const TEXT_FRAGMENT_FLUSH_MS = TELEGRAM_TEST_TIMINGS.textFragmentGapMs + 80;

  it(
    "buffers near-limit text and processes sequential parts as one message",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 42, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 777, is_bot: false },
          message_id: 10,
          text: part1,
        },
      });

      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 42, type: "private" },
          date: 1_736_380_801,
          from: { first_name: "Ada", id: 777, is_bot: false },
          message_id: 11,
          text: part2,
        },
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.waitFor(
        () => {
          expect(replySpy).toHaveBeenCalledTimes(1);
        },
        { interval: 5, timeout: TEXT_FRAGMENT_FLUSH_MS * 6 },
      );

      const payload = replySpy.mock.calls[0][0] as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
