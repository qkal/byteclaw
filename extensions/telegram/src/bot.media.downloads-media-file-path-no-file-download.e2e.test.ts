import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramBotDepsForTest } from "./bot.media.e2e-harness.js";
import { setNextSavedMediaPath } from "./bot.media.e2e-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandler,
  createBotHandlerWithOptions,
  mockTelegramFileDownload,
  mockTelegramPngDownload,
  watchTelegramFetch,
} from "./bot.media.test-utils.js";

describe("telegram inbound media", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "handles file_path media downloads and missing file_path safely",
    async () => {
      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({
        runtimeError,
        runtimeLog,
      });

      for (const scenario of [
        {
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.runtimeError).not.toHaveBeenCalled();
            expect(params.fetchSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                filePathHint: "photos/1.jpg",
                url: "https://api.telegram.org/file/bottok/photos/1.jpg",
              }),
            );
            expect(params.replySpy).toHaveBeenCalledTimes(1);
            const payload = params.replySpy.mock.calls[0][0];
            expect(payload.Body).toContain("<media:image>");
          },
          getFile: async () => ({ file_path: "photos/1.jpg" }),
          messageId: 1,
          name: "downloads via file_path",
          setupFetch: () =>
            mockTelegramFileDownload({
              bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
              contentType: "image/jpeg",
            }),
        },
        {
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.fetchSpy).not.toHaveBeenCalled();
            expect(params.replySpy).not.toHaveBeenCalled();
            expect(params.runtimeError).not.toHaveBeenCalled();
          },
          getFile: async () => ({}),
          messageId: 2,
          name: "skips when file_path is missing",
          setupFetch: () => watchTelegramFetch(),
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        const fetchSpy = scenario.setupFetch();

        await handler({
          getFile: scenario.getFile,
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            from: { first_name: "Ada", id: 777, is_bot: false },
            message_id: scenario.messageId,
            photo: [{ file_id: "fid" }], // 2025-01-09T00:00:00Z
          },
        });

        scenario.assert({ fetchSpy, replySpy, runtimeError });
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "keeps Telegram inbound media paths with triple-dash ids",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramFileDownload({
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
        contentType: "image/jpeg",
      });
      const inboundPath = "/tmp/media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.jpg";
      setNextSavedMediaPath({
        contentType: "image/jpeg",
        path: inboundPath,
        size: 4,
      });

      try {
        await handler({
          getFile: async () => ({ file_path: "photos/1.jpg" }),
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            from: { first_name: "Ada", id: 777, is_bot: false },
            message_id: 1001,
            photo: [{ file_id: "fid" }],
          },
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const payload = replySpy.mock.calls[0]?.[0] as { Body?: string; MediaPaths?: string[] };
        expect(payload.Body).toContain("<media:image>");
        expect(payload.MediaPaths).toContain(inboundPath);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it("prefers proxyFetch over global fetch", async () => {
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("global fetch should not be called");
    });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      headers: { get: () => "image/jpeg" },
      ok: true,
      status: 200,
      statusText: "OK",
    } as unknown as Response);

    const { handler } = await createBotHandlerWithOptions({
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtimeError,
      runtimeLog,
    });

    await handler({
      getFile: async () => ({ file_path: "photos/2.jpg" }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 2,
        photo: [{ file_id: "fid" }],
      },
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottok/photos/2.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );

    globalFetchSpy.mockRestore();
  });

  it("captures pin and venue location payload fields", async () => {
    const { handler, replySpy } = await createBotHandler();

    const cases = [
      {
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Meet here");
          expect(payload.Body).toContain("48.858844");
          expect(payload.LocationLat).toBe(48.858_844);
          expect(payload.LocationLon).toBe(2.294_351);
          expect(payload.LocationSource).toBe("pin");
          expect(payload.LocationIsLive).toBe(false);
        },
        message: {
          caption: "Meet here",
          chat: { id: 42, type: "private" as const },
          date: 1_736_380_800,
          location: {
            horizontal_accuracy: 12,
            latitude: 48.858_844,
            longitude: 2.294_351,
          },
          message_id: 5,
        },
      },
      {
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Eiffel Tower");
          expect(payload.LocationName).toBe("Eiffel Tower");
          expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
          expect(payload.LocationSource).toBe("place");
        },
        message: {
          chat: { id: 42, type: "private" as const },
          date: 1_736_380_800,
          message_id: 6,
          venue: {
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858_844, longitude: 2.294_351 },
            title: "Eiffel Tower",
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      replySpy.mockClear();
      await handler({
        getFile: async () => ({ file_path: "unused" }),
        me: { username: "openclaw_bot" },
        message: testCase.message,
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as Record<string, unknown>;
      testCase.assert(payload);
    }
  });
});

describe("telegram media groups", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const MEDIA_GROUP_FLUSH_MS = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 40;

  it(
    "uses custom apiRoot for buffered media-group downloads",
    async () => {
      const originalLoadConfig = telegramBotDepsForTest.loadConfig;
      telegramBotDepsForTest.loadConfig = (() => ({
        channels: {
          telegram: {
            allowFrom: ["*"],
            apiRoot: "http://127.0.0.1:8081/custom-bot-api",
            dmPolicy: "open",
          },
        },
      })) as typeof telegramBotDepsForTest.loadConfig;

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        await Promise.all([
          handler({
            getFile: async () => ({ file_path: "photos/photo1.jpg" }),
            me: { username: "openclaw_bot" },
            message: {
              caption: "Album",
              chat: { id: 42, type: "private" as const },
              date: 1_736_380_800,
              from: { first_name: "Ada", id: 777, is_bot: false },
              media_group_id: "album-custom-api-root",
              message_id: 1,
              photo: [{ file_id: "photo1" }],
            },
          }),
          handler({
            getFile: async () => ({ file_path: "photos/photo2.jpg" }),
            me: { username: "openclaw_bot" },
            message: {
              chat: { id: 42, type: "private" as const },
              date: 1_736_380_801,
              from: { first_name: "Ada", id: 777, is_bot: false },
              media_group_id: "album-custom-api-root",
              message_id: 2,
              photo: [{ file_id: "photo2" }],
            },
          }),
        ]);

        await vi.waitFor(
          () => {
            expect(replySpy).toHaveBeenCalledTimes(1);
          },
          { interval: 2, timeout: MEDIA_GROUP_FLUSH_MS * 4 },
        );

        expect(runtimeError).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            url: "http://127.0.0.1:8081/custom-bot-api/file/bottok/photos/photo1.jpg",
          }),
        );
        expect(fetchSpy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            url: "http://127.0.0.1:8081/custom-bot-api/file/bottok/photos/photo2.jpg",
          }),
        );
      } finally {
        telegramBotDepsForTest.loadConfig = originalLoadConfig;
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "handles same-group buffering and separate-group independence",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        for (const scenario of [
          {
            assert: (replySpy: ReturnType<typeof vi.fn>) => {
              const payload = replySpy.mock.calls[0]?.[0];
              expect(payload?.Body).toContain("Here are my photos");
              expect(payload?.MediaPaths).toHaveLength(2);
            },
            expectedReplyCount: 1,
            messages: [
              {
                caption: "Here are my photos",
                chat: { id: 42, type: "private" as const },
                date: 1736380800,
                filePath: "photos/photo1.jpg",
                from: { first_name: "Ada", id: 777, is_bot: false },
                media_group_id: "album123",
                message_id: 1,
                photo: [{ file_id: "photo1" }],
              },
              {
                chat: { id: 42, type: "private" as const },
                date: 1736380801,
                filePath: "photos/photo2.jpg",
                from: { first_name: "Ada", id: 777, is_bot: false },
                media_group_id: "album123",
                message_id: 2,
                photo: [{ file_id: "photo2" }],
              },
            ],
          },
          {
            assert: () => {},
            expectedReplyCount: 2,
            messages: [
              {
                caption: "Album A",
                chat: { id: 42, type: "private" as const },
                date: 1736380800,
                filePath: "photos/photoA1.jpg",
                from: { first_name: "Ada", id: 777, is_bot: false },
                media_group_id: "albumA",
                message_id: 11,
                photo: [{ file_id: "photoA1" }],
              },
              {
                caption: "Album B",
                chat: { id: 42, type: "private" as const },
                date: 1736380801,
                filePath: "photos/photoB1.jpg",
                from: { first_name: "Ada", id: 777, is_bot: false },
                media_group_id: "albumB",
                message_id: 12,
                photo: [{ file_id: "photoB1" }],
              },
            ],
          },
        ]) {
          replySpy.mockClear();
          runtimeError.mockClear();

          await Promise.all(
            scenario.messages.map((message) =>
              handler({
                getFile: async () => ({ file_path: message.filePath }),
                me: { username: "openclaw_bot" },
                message,
              }),
            ),
          );

          expect(replySpy).not.toHaveBeenCalled();
          await vi.waitFor(
            () => {
              expect(replySpy).toHaveBeenCalledTimes(scenario.expectedReplyCount);
            },
            { interval: 2, timeout: MEDIA_GROUP_FLUSH_MS * 4 },
          );

          expect(runtimeError).not.toHaveBeenCalled();
          scenario.assert(replySpy);
        }
      } finally {
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("telegram forwarded bursts", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const FORWARD_BURST_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "coalesces forwarded text + forwarded attachment into a single processing turn with default debounce config",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        await handler({
          getFile: async () => ({}),
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 42, type: "private" },
            date: 1_736_380_800,
            forward_origin: { date: 1_736_380_700, sender_user_name: "A", type: "hidden_user" },
            from: { first_name: "N", id: 777, is_bot: false },
            message_id: 21,
            text: "Look at this",
          },
        });

        await handler({
          getFile: async () => ({ file_path: "photos/fwd1.jpg" }),
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 42, type: "private" },
            date: 1_736_380_801,
            forward_origin: { date: 1_736_380_701, sender_user_name: "A", type: "hidden_user" },
            from: { first_name: "N", id: 777, is_bot: false },
            message_id: 22,
            photo: [{ file_id: "fwd_photo_1" }],
          },
        });

        await vi.waitFor(() => {
          expect(replySpy).toHaveBeenCalledTimes(1);
        });

        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replySpy.mock.calls[0][0];
        expect(payload.Body).toContain("Look at this");
        expect(payload.MediaPaths).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    FORWARD_BURST_TEST_TIMEOUT_MS,
  );
});
