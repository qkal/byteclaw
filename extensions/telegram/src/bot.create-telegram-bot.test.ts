import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
const harness = await import("./bot.create-telegram-bot.test-harness.js");
const EYES_EMOJI = "\u{1F440}";
const {
  answerCallbackQuerySpy,
  botCtorSpy,
  commandSpy,
  dispatchReplyWithBufferedBlockDispatcher,
  getLoadWebMediaMock,
  getChatSpy,
  getLoadConfigMock,
  getLoadSessionStoreMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  makeForumGroupMessageCtx,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendAnimationSpy,
  sendChatActionSpy,
  sendMessageSpy,
  sendPhotoSpy,
  sequentializeSpy,
  setSessionStoreEntriesForTest,
  setMessageReactionSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  throttlerSpy,
  useSpy,
} = harness;
const { resolveTelegramFetch } = await import("./fetch.js");
const {
  createTelegramBot: createTelegramBotBase,
  getTelegramSequentialKey,
  setTelegramBotRuntimeForTest,
} = await import("./bot.js");
let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();
const loadSessionStore = getLoadSessionStoreMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

const ORIGINAL_TZ = process.env.TZ;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

describe("createTelegramBot", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });
  beforeEach(() => {
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  // GroupPolicy tests

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });
  it("uses wrapped fetch when global fetch is available", () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      createTelegramBot({ token: "tok" });
      const fetchImpl = resolveTelegramFetch();
      expect(fetchImpl).toBeTypeOf("function");
      expect(fetchImpl).not.toBe(fetchSpy);
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("applies global and per-account timeoutSeconds", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open", timeoutSeconds: 60 },
      },
    });
    createTelegramBot({ token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
    botCtorSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          accounts: {
            foo: { timeoutSeconds: 61 },
          },
          allowFrom: ["*"],
          dmPolicy: "open",
          timeoutSeconds: 60,
        },
      },
    });
    createTelegramBot({ accountId: "foo", token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 61 }),
      }),
    );
  });
  it("sequentializes updates by chat and thread", () => {
    createTelegramBot({ token: "tok" });
    expect(sequentializeSpy).toHaveBeenCalledTimes(1);
    expect(middlewareUseSpy).toHaveBeenCalledWith(sequentializeSpy.mock.results[0]?.value);
    expect(harness.sequentializeKey).toBe(getTelegramSequentialKey);
  });

  it("preserves same-chat reply order when a debounced run is still active", async () => {
    const DEBOUNCE_MS = 4321;
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
    });

    sequentializeSpy.mockImplementationOnce(() => {
      const lanes = new Map<string, Promise<void>>();
      return async (ctx: Record<string, unknown>, next: () => Promise<void>) => {
        const key = harness.sequentializeKey?.(ctx) ?? "default";
        const previous = lanes.get(key) ?? Promise.resolve();
        const current = previous.then(async () => {
          await next();
        });
        lanes.set(
          key,
          current.catch(() => undefined),
        );
        try {
          await current;
        } finally {
          if (lanes.get(key) === current) {
            lanes.delete(key);
          }
        }
      };
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });

    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = String(ctx.Body ?? "");
      startedBodies.push(body);
      if (body.includes("first")) {
        await firstRunGate;
      }
      return { text: `reply:${body}` };
    });

    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      const middlewares = middlewareUseSpy.mock.calls
        .map((call) => call[0])
        .filter(
          (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
            typeof fn === "function",
        );
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await handler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const extractLatestDebounceFlush = () => {
      const debounceCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      expect(debounceCallIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(
        setTimeoutSpy.mock.results[debounceCallIndex]?.value as ReturnType<typeof setTimeout>,
      );
      return setTimeoutSpy.mock.calls[debounceCallIndex]?.[0] as (() => Promise<void>) | undefined;
    };

    try {
      createTelegramBot({ token: "tok" });

      await runMiddlewareChain({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 42 },
          message_id: 101,
          text: "first",
        },
        update: { update_id: 101 },
      });

      const flushFirst = extractLatestDebounceFlush();
      const firstFlush = flushFirst?.();

      await vi.waitFor(() => {
        expect(startedBodies).toHaveLength(1);
        expect(startedBodies[0]).toContain("first");
      });

      await runMiddlewareChain({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_801,
          from: { first_name: "Ada", id: 42 },
          message_id: 102,
          text: "second",
        },
        update: { update_id: 102 },
      });

      const flushSecond = extractLatestDebounceFlush();
      const secondFlush = flushSecond?.();
      await Promise.resolve();

      expect(startedBodies).toHaveLength(1);
      expect(sendMessageSpy).not.toHaveBeenCalled();

      releaseFirstRun();
      await Promise.all([firstFlush, secondFlush]);

      await vi.waitFor(() => {
        expect(startedBodies).toHaveLength(2);
        expect(sendMessageSpy).toHaveBeenCalledTimes(2);
      });

      expect(startedBodies[0]).toContain("first");
      expect(startedBodies[1]).toContain("second");
      expect(sendMessageSpy.mock.calls.map((call) => call[1])).toEqual([
        expect.stringContaining("first"),
        expect.stringContaining("second"),
      ]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("routes callback_query payloads as messages and answers callbacks", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "cmd:option_a",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-1",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 10,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });
  it("preserves native command source for prefixed callback_query payloads", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      commands: { native: true, text: false },
    });

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        data: "tgcmd:/fast status",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-native-1",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 10,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandBody).toBe("/fast status");
    expect(payload.CommandSource).toBe("native");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-native-1");
  });
  it("reloads callback model routing bindings without recreating the bot", async () => {
    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    let boundAgentId = "agent-a";
    loadConfig.mockImplementation(() => ({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
        },
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId: boundAgentId,
          match: { accountId: "default", channel: "telegram" },
        },
      ],
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
    }));

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const sendModelCallback = async (id: number) => {
      await callbackHandler({
        callbackQuery: {
          data: "mdl_prov",
          from: { first_name: "Ada", id: 9, username: "ada_bot" },
          id: `cbq-model-${id}`,
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800 + id,
            message_id: id,
          },
        },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
      });
    };

    buildModelsProviderDataMock.mockClear();
    await sendModelCallback(1);
    expect(buildModelsProviderDataMock).toHaveBeenCalled();
    expect(buildModelsProviderDataMock.mock.calls.at(-1)?.[1]).toBe("agent-a");

    boundAgentId = "agent-b";
    await sendModelCallback(2);
    expect(buildModelsProviderDataMock.mock.calls.at(-1)?.[1]).toBe("agent-b");
  });
  it("wraps inbound message with Telegram envelope", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      createTelegramBot({ token: "tok" });
      expect(onSpy).toHaveBeenCalledWith("message", expect.any(Function));
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      const message = {
        chat: { id: 1234, type: "private" },
        text: "hello world",
        date: 1_736_380_800, // 2025-01-09T00:00:00Z
        from: {
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada_bot",
        },
      };
      await handler({
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
        message,
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
      const timestampPattern = escapeRegExp(expectedTimestamp);
      expect(payload.Body).toMatch(
        new RegExp(
          `^\\[Telegram Ada Lovelace \\(@ada_bot\\) id:1234 (\\+\\d+[smhd] )?${timestampPattern}\\]`,
        ),
      );
      expect(payload.Body).toContain("hello world");
    });
  });
  it("handles pairing DM flows for new and already-pending requests", async () => {
    const cases = [
      {
        expectedSendCount: 1,
        messages: ["hello"],
        name: "new unknown sender",
        pairingUpsertResults: [{ code: "PAIRCODE", created: true }],
      },
      {
        expectedSendCount: 1,
        messages: ["hello", "hello again"],
        name: "already pending request",
        pairingUpsertResults: [
          { code: "PAIRCODE", created: true },
          { code: "PAIRCODE", created: false },
        ],
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "pairing" } },
      });
      readChannelAllowFromStore.mockResolvedValue([]);
      upsertChannelPairingRequest.mockClear();
      let pairingUpsertCall = 0;
      upsertChannelPairingRequest.mockImplementation(async () => {
        const result =
          testCase.pairingUpsertResults[
            Math.min(pairingUpsertCall, testCase.pairingUpsertResults.length - 1)
          ];
        pairingUpsertCall += 1;
        return result;
      });

      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const senderId = Number(`${Date.now()}${index}`.slice(-9));
      for (const text of testCase.messages) {
        await handler({
          getFile: async () => ({ download: async () => new Uint8Array() }),
          me: { username: "openclaw_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            from: { id: senderId, username: "random" },
            text,
          },
        });
      }

      expect(replySpy, testCase.name).not.toHaveBeenCalled();
      expect(sendMessageSpy, testCase.name).toHaveBeenCalledTimes(testCase.expectedSendCount);
      expect(sendMessageSpy.mock.calls[0]?.[0], testCase.name).toBe(1234);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText, testCase.name).toContain(`Your Telegram user id: ${senderId}`);
      expect(pairingText, testCase.name).toContain("Pairing code:");
      expect(pairingText, testCase.name).toContain("openclaw pairing approve telegram");
      expect(sendMessageSpy.mock.calls[0]?.[2], testCase.name).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    }
  });

  it("ignores private self-authored message updates instead of issuing a pairing challenge", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { first_name: "OpenClaw", id: 7, is_bot: true, username: "openclaw_bot" },
      message: {
        chat: { first_name: "Harold", id: 1234, type: "private" },
        date: 1_736_380_800,
        from: { first_name: "OpenClaw", id: 7, is_bot: true, username: "openclaw_bot" },
        message_id: 1884,
        pinned_message: {
          chat: { first_name: "Harold", id: 1234, type: "private" },
          date: 1_736_380_799,
          from: { first_name: "OpenClaw", id: 7, is_bot: true, username: "openclaw_bot" },
          message_id: 1883,
          text: "Binding: Review pull request 54118 (openclaw)",
        },
      },
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks unauthorized DM media before download and sends pairing reply", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}01`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: getFileSpy,
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { id: senderId, username: "random" },
          message_id: 410,
          photo: [{ file_id: "p1" }],
        },
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores group self-authored message updates instead of re-processing bot output", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { first_name: "OpenClaw", id: 7, is_bot: true, username: "openclaw_bot" },
      message: {
        chat: { id: -1_001_234, title: "OpenClaw Ops", type: "supergroup" },
        date: 1_736_380_800,
        from: { first_name: "OpenClaw", id: 7, is_bot: true, username: "openclaw_bot" },
        message_id: 1884,
        text: "approval card update",
      },
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks unauthorized DM media before download and sends pairing reply", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}01`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: getFileSpy,
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { id: senderId, username: "random" },
          message_id: 411,
          photo: [{ file_id: "p1" }],
        },
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("blocks DM media downloads completely when dmPolicy is disabled", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "disabled" } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: getFileSpy,
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { id: 999, username: "random" },
          message_id: 411,
          photo: [{ file_id: "p1" }],
        },
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("blocks unauthorized DM media groups before any photo download", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}02`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ testTimings: TELEGRAM_TEST_TIMINGS, token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: getFileSpy,
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          from: { id: senderId, username: "random" },
          media_group_id: "dm-album-1",
          message_id: 412,
          photo: [{ file_id: "p1" }],
        },
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("triggers typing cue via onReplyStart", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.typingCallbacks?.onReplyStart?.();
        return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
      },
    );
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 999, username: "random" },
        text: "hi",
      },
    });
    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing", undefined);
  });

  it("dedupes duplicate updates for callback_query, message, and channel_post", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
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

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const channelPostHandler = getOnHandler("channel_post") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        data: "ping",
        from: { id: 789, username: "testuser" },
        id: "cb-1",
        message: {
          chat: { id: 123, type: "private" },
          date: 1_736_380_800,
          message_id: 9001,
        },
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
      update: { update_id: 222 },
    });
    await callbackHandler({
      callbackQuery: {
        data: "ping",
        from: { id: 789, username: "testuser" },
        id: "cb-1",
        message: {
          chat: { id: 123, type: "private" },
          date: 1_736_380_800,
          message_id: 9001,
        },
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
      update: { update_id: 222 },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await messageHandler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, type: "private" },
        date: 1_736_380_800,
        from: { id: 456, username: "testuser" },
        message_id: 42,
        text: "hello",
      },
      update: { update_id: 111 },
    });
    await messageHandler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, type: "private" },
        date: 1_736_380_800,
        from: { id: 456, username: "testuser" },
        message_id: 42,
        text: "hello",
      },
      update: { update_id: 111 },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await channelPostHandler({
      channelPost: {
        chat: { id: -100_777_111_222, title: "Wake Channel", type: "channel" },
        date: 1_736_380_800,
        from: { first_name: "wakebot", id: 98_765, is_bot: true, username: "wake_bot" },
        message_id: 777,
        text: "wake check",
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
    });
    await channelPostHandler({
      channelPost: {
        chat: { id: -100_777_111_222, title: "Wake Channel", type: "channel" },
        date: 1_736_380_800,
        from: { first_name: "wakebot", id: 98_765, is_bot: true, username: "wake_bot" },
        message_id: 777,
        text: "wake check",
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not persist update offset past pending updates", async () => {
    // For this test we need sequentialize(...) to behave like a normal middleware and call next().
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();
    loadConfig.mockReturnValue({
      channels: { telegram: { allowFrom: ["*"], dmPolicy: "open" } },
    });

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 100,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    let releaseUpdate101: (() => void) | undefined;
    const update101Gate = new Promise<void>((resolve) => {
      releaseUpdate101 = resolve;
    });

    // Start processing update 101 but keep it pending (simulates an update queued behind sequentialize()).
    const p101 = runMiddlewareChain({ update: { update_id: 101 } }, async () => update101Gate);
    // Let update 101 enter the chain and mark itself pending before 102 completes.
    await Promise.resolve();

    // Complete update 102 while 101 is still pending. The persisted watermark must not jump to 102.
    await runMiddlewareChain({ update: { update_id: 102 } }, async () => {});

    const persistedValues = onUpdateId.mock.calls.map((call) => Number(call[0]));
    const maxPersisted = persistedValues.length > 0 ? Math.max(...persistedValues) : -Infinity;
    expect(maxPersisted).toBeLessThan(101);

    releaseUpdate101?.();
    await p101;

    // Once the pending update finishes, the watermark can safely catch up.
    const persistedAfterDrain = onUpdateId.mock.calls.map((call) => Number(call[0]));
    const maxPersistedAfterDrain =
      persistedAfterDrain.length > 0 ? Math.max(...persistedAfterDrain) : -Infinity;
    expect(maxPersistedAfterDrain).toBe(102);
  });
  it("allows distinct callback_query ids without update_id", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      callbackQuery: {
        data: "ping",
        from: { id: 789, username: "testuser" },
        id: "cb-1",
        message: {
          chat: { id: 123, type: "private" },
          date: 1_736_380_800,
          message_id: 9001,
        },
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
    });

    await handler({
      callbackQuery: {
        data: "ping",
        from: { id: 789, username: "testuser" },
        id: "cb-2",
        message: {
          chat: { id: 123, type: "private" },
          date: 1_736_380_800,
          message_id: 9001,
        },
      },
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
    });

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  const groupPolicyCases: {
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }[] = [
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
            groupPolicy: "disabled",
          },
        },
      },
      expectedReplyCount: 0,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "@openclaw_bot hello",
      },
      name: "blocks all group messages when groupPolicy is 'disabled'",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
            groupPolicy: "allowlist",
          },
        },
      },
      expectedReplyCount: 0,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "notallowed" },
        text: "@openclaw_bot hello",
      },
      name: "blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
            groupPolicy: "allowlist",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "hello",
      },
      name: "allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["@testuser"],
            groupPolicy: "allowlist",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      expectedReplyCount: 0,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        text: "hello",
      },
      name: "blocks group messages when allowFrom is configured with @username entries (numeric IDs required)",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["TG:77112533"],
            groupPolicy: "allowlist",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 77_112_533, username: "mneves" },
        text: "hello",
      },
      name: "allows group messages from tg:-prefixed allowFrom entries case-insensitively",
    },
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: {
              "-100123456789": {
                allowFrom: [],
                requireMention: false,
              },
            },
          },
        },
      },
      expectedReplyCount: 0,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "random" },
        text: "hello",
      },
      name: "blocks group messages when per-group allowFrom override is explicitly empty",
    },
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "random" },
        text: "hello",
      },
      name: "allows all group messages when groupPolicy is 'open'",
    },
  ];

  it("applies groupPolicy cases", async () => {
    for (const [index, testCase] of groupPolicyCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          date: 1_736_380_800 + index,
          message_id: 1000 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });

  it("routes DMs by telegram accountId binding", async () => {
    const config = {
      bindings: [
        {
          agentId: "opie",
          match: { accountId: "opie", channel: "telegram" },
        },
      ],
      channels: {
        telegram: {
          accounts: {
            opie: {
              allowFrom: ["*"],
              botToken: "tok-opie",
              dmPolicy: "open",
            },
          },
          allowFrom: ["*"],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ accountId: "opie", token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, type: "private" },
        date: 1_736_380_800,
        from: { id: 999, username: "testuser" },
        message_id: 42,
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toBe("agent:opie:main");
  });

  it("reloads DM routing bindings between messages without recreating the bot", async () => {
    let boundAgentId = "agent-a";
    const configForAgent = (agentId: string) => ({
      agents: {
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId,
          match: { accountId: "opie", channel: "telegram" },
        },
      ],
      channels: {
        telegram: {
          accounts: {
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
            },
          },
        },
      },
    });
    loadConfig.mockImplementation(() => configForAgent(boundAgentId));

    createTelegramBot({ accountId: "opie", token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const sendDm = async (messageId: number, text: string) => {
      await handler({
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1_736_380_800 + messageId,
          from: { id: 999, username: "testuser" },
          message_id: messageId,
          text,
        },
      });
    };

    await sendDm(42, "hello one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await sendDm(43, "hello two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:agent-b:");
  });

  it("reloads topic agent overrides between messages without recreating the bot", async () => {
    let topicAgentId = "topic-a";
    loadConfig.mockImplementation(() => ({
      agents: {
        list: [{ id: "topic-a" }, { id: "topic-b" }],
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              topics: {
                "99": {
                  agentId: topicAgentId,
                },
              },
            },
          },
        },
      },
    }));

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const sendTopicMessage = async (messageId: number) => {
      await handler({
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: -1_001_234_567_890, is_forum: true, title: "Forum Group", type: "supergroup" },
          date: 1_736_380_800 + messageId,
          from: { id: 12_345, username: "testuser" },
          message_id: messageId,
          message_thread_id: 99,
          text: "hello",
        },
      });
    };

    await sendTopicMessage(301);
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:topic-a:");

    topicAgentId = "topic-b";
    await sendTopicMessage(302);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:topic-b:");
  });

  it("routes non-default account DMs to the per-account fallback session without explicit bindings", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          accounts: {
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
            },
          },
        },
      },
    });

    createTelegramBot({ accountId: "opie", token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, type: "private" },
        date: 1_736_380_800,
        from: { id: 999, username: "testuser" },
        message_id: 42,
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toContain("agent:main:telegram:opie:");
  });

  it("applies group mention overrides and fallback behavior", async () => {
    const cases: {
      config: Record<string, unknown>;
      message: Record<string, unknown>;
      me?: Record<string, unknown>;
    }[] = [
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: {
                "*": { requireMention: true },
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 123, title: "Dev Chat", type: "group" },
          date: 1_736_380_800,
          text: "hello",
        },
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: {
                "*": { requireMention: true },
                "-1001234567890": {
                  requireMention: true,
                  topics: {
                    "99": { requireMention: false },
                  },
                },
              },
            },
          },
        },
        message: {
          chat: {
            id: -1_001_234_567_890,
            is_forum: true,
            title: "Forum Group",
            type: "supergroup",
          },
          date: 1_736_380_800,
          message_thread_id: 99,
          text: "hello",
        },
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: 456, title: "Ops", type: "group" },
          date: 1_736_380_800,
          text: "hello",
        },
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: true } },
            },
          },
        },
        me: {},
        message: {
          chat: { id: 789, title: "No Me", type: "group" },
          date: 1_736_380_800,
          text: "hello",
        },
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        me: testCase.me,
        message: testCase.message,
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    }
  });

  it("routes forum topics to parent or topic-specific bindings", async () => {
    const cases: {
      config: Record<string, unknown>;
      expectedSessionKeyFragment: string;
      text: string;
    }[] = [
      {
        config: {
          agents: {
            list: [{ id: "forum-agent" }],
          },
          bindings: [
            {
              agentId: "forum-agent",
              match: {
                channel: "telegram",
                peer: { id: "-1001234567890", kind: "group" },
              },
            },
          ],
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        expectedSessionKeyFragment: "agent:forum-agent:",
        text: "hello from topic",
      },
      {
        config: {
          agents: {
            list: [{ id: "topic-agent" }, { id: "group-agent" }],
          },
          bindings: [
            {
              agentId: "topic-agent",
              match: {
                channel: "telegram",
                peer: { id: "-1001234567890:topic:99", kind: "group" },
              },
            },
            {
              agentId: "group-agent",
              match: {
                channel: "telegram",
                peer: { id: "-1001234567890", kind: "group" },
              },
            },
          ],
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        expectedSessionKeyFragment: "agent:topic-agent:",
        text: "hello from topic 99",
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          chat: {
            id: -1_001_234_567_890,
            is_forum: true,
            title: "Forum Group",
            type: "supergroup",
          },
          date: 1_736_380_800,
          from: { id: 999, username: "testuser" },
          message_id: 42,
          message_thread_id: 99,
          text: testCase.text,
        },
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.SessionKey).toContain(testCase.expectedSessionKeyFragment);
    }
  });

  it("sends GIF replies as animations", async () => {
    replySpy.mockResolvedValueOnce({
      mediaUrl: "https://example.com/fun",
      text: "caption",
    });
    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
    });
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        from: { first_name: "Ada" },
        message_id: 5,
        text: "hello world",
      },
    });

    expect(sendAnimationSpy).toHaveBeenCalledTimes(1);
    expect(sendAnimationSpy).toHaveBeenCalledWith("1234", expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
      reply_to_message_id: undefined,
    });
    expect(sendPhotoSpy).not.toHaveBeenCalled();
    expect(loadWebMedia).toHaveBeenCalledTimes(1);
    expect(loadWebMedia.mock.calls[0]?.[0]).toBe("https://example.com/fun");
  });

  function resetHarnessSpies() {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    setMessageReactionSpy.mockClear();
    setMyCommandsSpy.mockClear();
  }
  function getMessageHandler() {
    createTelegramBot({ token: "tok" });
    return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  }
  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
  }) {
    const handler = getMessageHandler();
    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: params.me ?? { username: "openclaw_bot" },
      message: params.message,
    });
  }

  it("accepts mentionPatterns matches with and without unrelated mentions", async () => {
    const cases = [
      {
        assertEnvelope: true,
        message: {
          chat: { id: 7, title: "Test Group", type: "group" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 9 },
          message_id: 1,
          text: "bert: introduce yourself",
        },
        name: "plain mention pattern text",
      },
      {
        assertEnvelope: false,
        message: {
          chat: { id: 7, title: "Test Group", type: "group" },
          date: 1_736_380_801,
          entities: [{ length: 6, offset: 12, type: "mention" }],
          from: { first_name: "Ada", id: 9 },
          message_id: 3,
          text: "bert: hello @alice",
        },
        name: "mention pattern plus another @mention",
      },
    ] as const;

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue({
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
        identity: { name: "Bert" },
        messages: { groupChat: { mentionPatterns: [String.raw`\bbert\b`] } },
      });

      await dispatchMessage({
        message: testCase.message,
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.WasMentioned, testCase.name).toBe(true);
      if (testCase.assertEnvelope) {
        expect(payload.SenderName).toBe("Ada");
        expect(payload.SenderId).toBe("9");
        const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
        const timestampPattern = escapeRegExp(expectedTimestamp);
        expect(payload.Body).toMatch(
          new RegExp(`^\\[Telegram Test Group id:7 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
        );
      }
    }
  });
  it("keeps group envelope headers stable (sender identity is separate)", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 42, title: "Ops", type: "group" },
        date: 1_736_380_800,
        from: {
          first_name: "Ada",
          id: 99,
          last_name: "Lovelace",
          username: "ada",
        },
        message_id: 2,
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
  });
  it("reacts to mention-gated group messages when ackReaction is enabled", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
      messages: {
        ackReaction: EYES_EMOJI,
        ackReactionScope: "group-mentions",
        groupChat: { mentionPatterns: [String.raw`\bbert\b`] },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 7, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { first_name: "Ada", id: 9 },
        message_id: 123,
        text: "bert hello",
      },
    });

    expect(setMessageReactionSpy).toHaveBeenCalledWith(7, 123, [
      { emoji: EYES_EMOJI, type: "emoji" },
    ]);
  });
  it("clears native commands when disabled", () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      commands: { native: false },
    });

    createTelegramBot({ token: "tok" });

    expect(setMyCommandsSpy).toHaveBeenCalledWith([]);
  });
  it("handles requireMention when mentions do and do not resolve", async () => {
    const cases = [
      {
        config: { messages: { groupChat: { mentionPatterns: [String.raw`\bbert\b`] } } },
        expectedReplyCount: 0,
        expectedWasMentioned: undefined,
        me: { username: "openclaw_bot" },
        name: "mention pattern configured but no match",
      },
      {
        config: { messages: { groupChat: { mentionPatterns: [] } } },
        expectedReplyCount: 1,
        expectedWasMentioned: false,
        me: {},
        name: "mention detection unavailable",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue({
        ...testCase.config,
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
      });

      await dispatchMessage({
        me: testCase.me,
        message: {
          chat: { id: 7, title: "Test Group", type: "group" },
          date: 1_736_380_800 + index,
          from: { first_name: "Ada", id: 9 },
          message_id: 2 + index,
          text: "hello everyone",
        },
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
      if (testCase.expectedWasMentioned != null) {
        const payload = replySpy.mock.calls[0][0];
        expect(payload.WasMentioned, testCase.name).toBe(testCase.expectedWasMentioned);
      }
    }
  });
  it("includes reply-to context when a Telegram reply is received", async () => {
    resetHarnessSpies();

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        reply_to_message: {
          from: { first_name: "Ada" },
          message_id: 9001,
          text: "Can you summarize this?",
        },
        text: "Sure, see below",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("Can you summarize this?");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("blocks group messages for restrictive group config edge cases", async () => {
    const blockedCases = [
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "allowlist",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
          date: 1_736_380_800,
          from: { id: 123_456_789, username: "testuser" },
          text: "hello",
        },
        name: "allowlist policy with no groupAllowFrom",
      },
      {
        config: {
          channels: {
            telegram: {
              groups: {
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 456, title: "Ops", type: "group" },
          date: 1_736_380_800,
          text: "@openclaw_bot hello",
        },
        name: "groups map without wildcard",
      },
    ] as const;

    for (const testCase of blockedCases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({ message: testCase.message });
      expect(replySpy.mock.calls.length, testCase.name).toBe(0);
    }
  });
  it("blocks group sender not in groupAllowFrom even when sender is paired in DM store", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupAllowFrom: ["222222222"],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: false } },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    await dispatchMessage({
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "hello",
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupAllowFrom: ["  TG:123456789  "],
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "/status",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("handles forum topic metadata and typing thread fallbacks", async () => {
    const forumCases = [
      {
        assertTopicMetadata: true,
        expectedTypingThreadId: 99,
        name: "topic-scoped forum message",
        threadId: 99,
      },
      {
        assertTopicMetadata: false,
        expectedTypingThreadId: 1,
        name: "General topic forum message",
        threadId: undefined,
      },
    ] as const;

    for (const testCase of forumCases) {
      resetHarnessSpies();
      sendChatActionSpy.mockClear();
      let dispatchCall:
        | {
            ctx: {
              SessionKey?: unknown;
              From?: unknown;
              MessageThreadId?: unknown;
              IsForum?: unknown;
            };
          }
        | undefined;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        dispatchCall = params as typeof dispatchCall;
        await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
        return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
      });
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      const payload = dispatchCall?.ctx;
      expect(payload).toBeDefined();
      if (!payload) {
        continue;
      }
      if (testCase.assertTopicMetadata) {
        expect(payload.SessionKey).toContain("telegram:group:-1001234567890:topic:99");
        expect(payload.From).toBe("telegram:group:-1001234567890:topic:99");
        expect(payload.MessageThreadId).toBe(99);
        expect(payload.IsForum).toBe(true);
      }
      expect(sendChatActionSpy).toHaveBeenCalledWith(-1_001_234_567_890, "typing", {
        message_thread_id: testCase.expectedTypingThreadId,
      });
    }
  });

  it("routes General-topic forum messages via getChat when Telegram omits forum metadata", async () => {
    resetHarnessSpies();
    sendChatActionSpy.mockClear();
    getChatSpy.mockResolvedValue({
      id: -1_001_234_567_890,
      is_forum: true,
      title: "Forum Group",
      type: "supergroup",
    });
    let dispatchCall:
      | {
          ctx: {
            SessionKey?: unknown;
            From?: unknown;
            MessageThreadId?: unknown;
            IsForum?: unknown;
          };
        }
      | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      dispatchCall = params as typeof dispatchCall;
      await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
      return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
    });
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const handler = getMessageHandler();
    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: -1_001_234_567_890, title: "Forum Group", type: "supergroup" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        text: "hello",
      },
    });

    expect(getChatSpy).toHaveBeenCalledOnce();
    expect(getChatSpy).toHaveBeenCalledWith(-1_001_234_567_890);
    expect(dispatchCall?.ctx).toEqual(
      expect.objectContaining({
        From: "telegram:group:-1001234567890:topic:1",
        IsForum: true,
        MessageThreadId: 1,
        SessionKey: expect.stringContaining("telegram:group:-1001234567890:topic:1"),
      }),
    );
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1_001_234_567_890, "typing", {
      message_thread_id: 1,
    });
  });
  it("threads forum replies only when a topic id exists", async () => {
    const threadCases = [
      { expectedMessageThreadId: undefined, name: "General topic reply", threadId: undefined },
      { expectedMessageThreadId: 99, name: "topic reply", threadId: 99 },
    ] as const;

    for (const testCase of threadCases) {
      resetHarnessSpies();
      replySpy.mockResolvedValue({ text: "response" });
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      expect(sendMessageSpy.mock.calls.length, testCase.name).toBe(1);
      const sendParams = sendMessageSpy.mock.calls[0]?.[2] as { message_thread_id?: number };
      if (testCase.expectedMessageThreadId == null) {
        expect(sendParams?.message_thread_id, testCase.name).toBeUndefined();
      } else {
        expect(sendParams?.message_thread_id, testCase.name).toBe(testCase.expectedMessageThreadId);
      }
    }
  });

  const allowFromEdgeCases: {
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }[] = [
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
            groupPolicy: "disabled",
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: 123_456_789, type: "private" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "hello",
      },
      name: "allows direct messages regardless of groupPolicy",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["  TG:123456789  "],
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: 123_456_789, type: "private" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "hello",
      },
      name: "allows direct messages with tg/Telegram-prefixed allowFrom entries",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: 777_777_777, type: "private" },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        text: "hello",
      },
      name: "matches direct message allowFrom against sender user id when chat id differs",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: 123_456_789, type: "private" },
        date: 1_736_380_800,
        text: "hello",
      },
      name: "falls back to direct message chat id when sender user id is missing",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["*"],
            groupPolicy: "allowlist",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      expectedReplyCount: 1,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "random" },
        text: "hello",
      },
      name: "allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'",
    },
    {
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
            groupPolicy: "allowlist",
          },
        },
      },
      expectedReplyCount: 0,
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        text: "hello",
      },
      name: "blocks group messages with no sender ID when groupPolicy is 'allowlist'",
    },
  ];

  it("applies allowFrom edge cases", async () => {
    for (const [index, testCase] of allowFromEdgeCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          date: 1_736_380_900 + index,
          message_id: 2000 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });
  it("sends replies without native reply threading", async () => {
    replySpy.mockResolvedValue({ text: "a".repeat(4500) });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 5, type: "private" },
        date: 1_736_380_800,
        message_id: 101,
        text: "hi",
      },
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect(
        (call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id,
      ).toBeUndefined();
    }
  });
  it("prefixes final replies with responsePrefix", async () => {
    replySpy.mockResolvedValue({ text: "final reply" });
    loadConfig.mockReturnValue({
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
      messages: { responsePrefix: "PFX" },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 5, type: "private" },
        date: 1_736_380_800,
        text: "hi",
      },
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe("PFX final reply");
  });
  it("honors threaded replies for replyToMode=first/all", async () => {
    for (const [mode, messageId] of [
      ["first", 101],
      ["all", 102],
    ] as const) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      replySpy.mockResolvedValue({
        replyToId: String(messageId),
        text: "a".repeat(4500),
      });

      createTelegramBot({ replyToMode: mode, token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 5, type: "private" },
          date: 1_736_380_800,
          message_id: messageId,
          text: "hi",
        },
      });

      expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
      for (const [index, call] of sendMessageSpy.mock.calls.entries()) {
        const actual = (call[2] as { reply_to_message_id?: number } | undefined)
          ?.reply_to_message_id;
        if (mode === "all" || index === 0) {
          expect(actual).toBe(messageId);
        } else {
          expect(actual).toBeUndefined();
        }
      }
    }
  });
  it("honors routed group activation from session store", async () => {
    const storePath = "/tmp/openclaw-telegram-group-activation.json";
    const routedGroupEntry = {
      chatType: "group",
      groupActivation: "always",
      sessionId: "agent:ops:telegram:group:123",
      updatedAt: 0,
    } as const;
    setSessionStoreEntriesForTest({
      "agent:ops:telegram:group:123": routedGroupEntry,
    });
    loadSessionStore.mockImplementation(() => ({
      "agent:ops:telegram:group:123": routedGroupEntry,
    }));
    const config = {
      bindings: [
        {
          agentId: "ops",
          match: {
            channel: "telegram",
            peer: { id: "123", kind: "group" },
          },
        },
      ],
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
      session: { store: storePath },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, title: "Routing", type: "group" },
        date: 1_736_380_800,
        from: { id: 999, username: "ops" },
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("applies topic skill filters and system prompts", async () => {
    let dispatchCall:
      | {
          ctx: {
            GroupSystemPrompt?: unknown;
          };
          replyOptions?: {
            skillFilter?: unknown;
          };
        }
      | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      dispatchCall = params as typeof dispatchCall;
      return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
    });
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              skills: ["group-skill"],
              systemPrompt: "Group prompt",
              topics: {
                "99": {
                  skills: [],
                  systemPrompt: "Topic prompt",
                },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    const payload = dispatchCall?.ctx;
    expect(payload).toBeDefined();
    if (!payload) {
      return;
    }
    expect(payload.GroupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    expect(dispatchCall?.replyOptions?.skillFilter).toEqual([]);
  });
  it("threads native command replies inside topics", async () => {
    commandSpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
      commands: { native: true },
    });

    createTelegramBot({ token: "tok" });
    expect(commandSpy).toHaveBeenCalled();
    const handler = commandSpy.mock.calls[0][1] as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      ...makeForumGroupMessageCtx({ text: "/status", threadId: 99 }),
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("reloads native command routing bindings between invocations without recreating the bot", async () => {
    commandSpy.mockClear();
    replySpy.mockClear();

    let boundAgentId = "agent-a";
    loadConfig.mockImplementation(() => ({
      agents: {
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId: boundAgentId,
          match: { accountId: "default", channel: "telegram" },
        },
      ],
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      commands: { native: true },
    }));

    createTelegramBot({ token: "tok" });
    const statusHandler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!statusHandler) {
      throw new Error("status command handler missing");
    }

    const invokeStatus = async (messageId: number) => {
      await statusHandler({
        match: "",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800 + messageId,
          from: { id: 9, username: "ada_bot" },
          message_id: messageId,
          text: "/status",
        },
      });
    };

    await invokeStatus(401);
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await invokeStatus(402);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:agent-b:");
  });
  it("skips tool summaries for native slash commands", async () => {
    commandSpy.mockClear();
    replySpy.mockImplementation(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      commands: { native: true },
    });

    createTelegramBot({ token: "tok" });
    const verboseHandler = commandSpy.mock.calls.find((call) => call[0] === "verbose")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!verboseHandler) {
      throw new Error("verbose command handler missing");
    }

    await verboseHandler({
      match: "on",
      message: {
        chat: { id: 12_345, type: "private" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        message_id: 42,
        text: "/verbose on",
      },
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("final reply");
  });
  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const ctx = {
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 123, type: "private" },
        date: 1_736_380_800,
        from: { id: 456, username: "testuser" },
        message_id: 42,
        text: "hello",
      },
      update: { update_id: 111 },
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
});
