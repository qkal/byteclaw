import { rm } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramInteractiveHandlerContext } from "./interactive-dispatch.js";
const {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getFileSpy,
  getChatSpy,
  getLoadConfigMock,
  getReadChannelAllowFromStoreMock,
  getOnHandler,
  listSkillCommandsForAgents,
  onSpy,
  replySpy,
  resolveExecApprovalSpy,
  sendMessageSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  wasSentByBot,
} = await import("./bot.create-telegram-bot.test-harness.js");

let loadSessionStore: typeof import("../../../src/config/sessions.js").loadSessionStore;
let createTelegramBotBase: typeof import("./bot.js").createTelegramBot;
let setTelegramBotRuntimeForTest: typeof import("./bot.js").setTelegramBotRuntimeForTest;
let createTelegramBot: (
  opts: Parameters<typeof import("./bot.js").createTelegramBot>[0],
) => ReturnType<typeof import("./bot.js").createTelegramBot>;

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const PUZZLE_EMOJI = "\u{1F9E9}";
const CROSS_MARK_EMOJI = "\u{274C}";
const INFO_EMOJI = "\u{2139}\u{FE0F}";
const CHECK_MARK_EMOJI = "\u{2705}";
const THUMBS_UP_EMOJI = "\u{1F44D}";
const FIRE_EMOJI = "\u{1F525}";
const PARTY_EMOJI = "\u{1F389}";
const EYES_EMOJI = "\u{1F440}";
const HEART_EMOJI = "\u{2764}\u{FE0F}";

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function waitForReplyCalls(count: number) {
  const done = createSignal();
  let seen = 0;
  replySpy.mockImplementation(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    seen += 1;
    if (seen >= count) {
      done.resolve();
    }
    return undefined;
  });
  return done.promise;
}

async function loadEnvelopeTimestampHelpers() {
  return await import("../../../test/helpers/envelope-timestamp.js");
}

async function loadInboundContextContract() {
  return await import("./test-support/inbound-context-contract.js");
}

const ORIGINAL_TZ = process.env.TZ;
describe("createTelegramBot", () => {
  beforeAll(async () => {
    ({ loadSessionStore } = await import("../../../src/config/sessions.js"));
    ({ createTelegramBot: createTelegramBotBase, setTelegramBotRuntimeForTest } =
      await import("./bot.js"));
  });
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  beforeEach(() => {
    setMyCommandsSpy.mockClear();
    clearPluginInteractiveHandlers();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: { allowFrom: ["*"], dmPolicy: "open" },
      },
    });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();

    createTelegramBot({
      config: {
        channels: {
          telegram: {
            allowFrom: [],
            capabilities: { inlineButtons: "allowlist" },
            dmPolicy: "pairing",
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "cmd:option_b",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-2",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 11,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
  });

  it("blocks DM model-selection callbacks for unpaired users when inline buttons are DM-scoped", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-callback-authz-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            capabilities: { inlineButtons: "dm" },
            dmPolicy: "pairing",
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      readChannelAllowFromStore.mockResolvedValueOnce([]);

      createTelegramBot({
        config,
        token: "tok",
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          data: "mdl_sel_openai/gpt-5.4",
          from: { first_name: "Mallory", id: 999, username: "mallory" },
          id: "cbq-model-authz-bypass-1",
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            message_id: 19,
          },
        },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).not.toHaveBeenCalled();
      expect(loadSessionStore(storePath, { skipCache: true })).toEqual({});
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-authz-bypass-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("allows callback_query in groups when group policy authorizes the sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({
      config: {
        channels: {
          telegram: {
            allowFrom: [],
            capabilities: { inlineButtons: "allowlist" },
            dmPolicy: "open",
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "commands_page_2",
        from: { first_name: "Ada", id: 42, username: "ada_bot" },
        id: "cbq-group-1",
        message: {
          chat: { id: -100_999, title: "Test Group", type: "supergroup" },
          date: 1_736_380_800,
          message_id: 20,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    // The callback should be processed (not silently blocked)
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-group-1");
  });

  it("clears approval buttons without re-editing callback message text", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
          execApprovals: {
            approvers: ["9"],
            enabled: true,
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-approve-style",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 21,
          text: [
            `${PUZZLE_EMOJI} Yep-needs approval again.`,
            "",
            "Run:",
            "/approve 138e9b8c allow-once",
            "",
            "Pending command:",
            "```shell",
            "npm view diver name version description",
            "```",
          ].join("\n"),
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, replyMarkup] = editMessageReplyMarkupSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(21);
    expect(replyMarkup).toEqual({ reply_markup: { inline_keyboard: [] } });
    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      allowPluginFallback: true,
      approvalId: "138e9b8c",
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              approvers: ["9"],
              enabled: true,
              target: "dm",
            }),
          }),
        }),
      }),
      decision: "allow-once",
      senderId: "9",
    });
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-style");
  });

  it("allows approval callbacks when exec approvals are enabled even without generic inlineButtons capability", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          botToken: "tok",
          capabilities: ["vision"],
          dmPolicy: "open",
          execApprovals: {
            approvers: ["9"],
            enabled: true,
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-approve-capability-free",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-capability-free");
  });

  it("resolves plugin approval callbacks through the shared approval resolver", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
          execApprovals: {
            approvers: ["9"],
            enabled: true,
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve plugin:138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-plugin-approve",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      allowPluginFallback: true,
      approvalId: "plugin:138e9b8c",
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            execApprovals: expect.objectContaining({
              approvers: ["9"],
              enabled: true,
              target: "dm",
            }),
          }),
        }),
      }),
      decision: "allow-once",
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve");
  });

  it("blocks approval callbacks from telegram users who are not exec approvers", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
          execApprovals: {
            approvers: ["999"],
            enabled: true,
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-approve-blocked",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 22,
          text: "Run: /approve 138e9b8c allow-once",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(resolveExecApprovalSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-blocked");
  });

  it("does not leak raw approval callback errors back into Telegram chat", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("gateway secret detail"));

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
          execApprovals: {
            approvers: ["9"],
            enabled: true,
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-approve-error",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 25,
          text: "Approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toBe(
      `${CROSS_MARK_EMOJI} Failed to submit approval. Please try again or contact an admin.`,
    );
  });

  it("allows exec approval callbacks from target-only Telegram recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-approve-target",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 23,
          text: "Approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      allowPluginFallback: false,
      approvalId: "138e9b8c",
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      decision: "allow-once",
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-approve-target");
  });

  it("does not allow target-only recipients to use legacy plugin fallback ids", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();
    resolveExecApprovalSpy.mockClear();
    replySpy.mockClear();
    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve 138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-legacy-plugin-fallback-blocked",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 25,
          text: "Legacy plugin approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(resolveExecApprovalSpy).toHaveBeenCalledWith({
      allowPluginFallback: false,
      approvalId: "138e9b8c",
      cfg: expect.objectContaining({
        approvals: expect.objectContaining({
          exec: expect.objectContaining({
            enabled: true,
            mode: "targets",
          }),
        }),
      }),
      decision: "allow-once",
      senderId: "9",
    });
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      `${CROSS_MARK_EMOJI} Failed to submit approval. Please try again or contact an admin.`,
      undefined,
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-legacy-plugin-fallback-blocked");
  });

  it("keeps plugin approval callback buttons for target-only recipients", async () => {
    onSpy.mockClear();
    editMessageReplyMarkupSpy.mockClear();
    editMessageTextSpy.mockClear();

    loadConfig.mockReturnValue({
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "telegram", to: "9" }],
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          capabilities: ["vision"],
          dmPolicy: "open",
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "/approve plugin:138e9b8c allow-once",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-plugin-approve-blocked",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 24,
          text: "Plugin approval required.",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-approve-blocked");
  });

  it("edits commands list for pagination callbacks", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "commands_page_2:main",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-3",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 12,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      agentIds: ["main"],
      cfg: expect.any(Object),
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const [chatId, messageId, text, params] = editMessageTextSpy.mock.calls[0] ?? [];
    expect(chatId).toBe(1234);
    expect(messageId).toBe(12);
    expect(String(text)).toContain(`${INFO_EMOJI} Commands (2/`);
    expect(params).toEqual({
      reply_markup: {
        inline_keyboard: [
          [
            { callback_data: "commands_page_1:main", text: "◀ Prev" },
            { callback_data: "commands_page_noop:main", text: "2/5" },
            { callback_data: "commands_page_3:main", text: "Next ▶" },
          ],
        ],
      },
    });
  });

  it("falls back to default agent for pagination callbacks without agent suffix", async () => {
    onSpy.mockClear();
    listSkillCommandsForAgents.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "commands_page_2",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-no-suffix",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 14,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      agentIds: ["main"],
      cfg: expect.any(Object),
    });
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks pagination callbacks when allowlist rejects sender", async () => {
    onSpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      config: {
        channels: {
          telegram: {
            allowFrom: [],
            capabilities: { inlineButtons: "allowlist" },
            dmPolicy: "pairing",
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "commands_page_2",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-4",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 13,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageTextSpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-4");
  });

  it("routes compact model callbacks by inferring provider", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const modelId = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const storePath = `/tmp/openclaw-telegram-model-compact-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: `bedrock/${modelId}`,
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      session: {
        store: storePath,
      },
    } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        config,
        token: "tok",
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          data: `mdl_sel/${modelId}`,
          from: { first_name: "Ada", id: 9, username: "ada_bot" },
          id: "cbq-model-compact-1",
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            message_id: 14,
          },
        },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("resets overrides when selecting the configured default model", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-default-${process.pid}-${Date.now()}.json`;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-opus-4-6",
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      session: {
        store: storePath,
      },
    };

    await rm(storePath, { force: true });
    try {
      loadConfig.mockReturnValue(config);
      createTelegramBot({
        config,
        token: "tok",
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          data: "mdl_sel_anthropic/claude-opus-4-6",
          from: { first_name: "Ada", id: 9, username: "ada_bot" },
          id: "cbq-model-default-1",
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            message_id: 16,
          },
        },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
        `${CHECK_MARK_EMOJI} Model reset to default`,
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-default-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("formats non-default model selection confirmations with Telegram HTML parse mode", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    const storePath = `/tmp/openclaw-telegram-model-html-${process.pid}-${Date.now()}.json`;

    await rm(storePath, { force: true });
    try {
      const config = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {},
              "openai/gpt-5.4": {},
            },
          },
        },
        channels: {
          telegram: {
            allowFrom: ["*"],
            dmPolicy: "open",
          },
        },
        session: {
          store: storePath,
        },
      } satisfies NonNullable<Parameters<typeof createTelegramBot>[0]["config"]>;

      loadConfig.mockReturnValue(config);
      createTelegramBot({
        config,
        token: "tok",
      });
      const callbackHandler = onSpy.mock.calls.find(
        (call) => call[0] === "callback_query",
      )?.[1] as (ctx: Record<string, unknown>) => Promise<void>;
      expect(callbackHandler).toBeDefined();

      await callbackHandler({
        callbackQuery: {
          data: "mdl_sel_openai/gpt-5.4",
          from: { first_name: "Ada", id: 9, username: "ada_bot" },
          id: "cbq-model-html-1",
          message: {
            chat: { id: 1234, type: "private" },
            date: 1_736_380_800,
            message_id: 17,
          },
        },
        getFile: async () => ({ download: async () => new Uint8Array() }),
        me: { username: "openclaw_bot" },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
      expect(editMessageTextSpy).toHaveBeenCalledWith(
        1234,
        17,
        `${CHECK_MARK_EMOJI} Model changed to <b>openai/gpt-5.4</b>\n\nThis model will be used for your next message.`,
        expect.objectContaining({ parse_mode: "HTML" }),
      );

      const entry = Object.values(loadSessionStore(storePath, { skipCache: true }))[0];
      expect(entry?.providerOverride).toBe("openai");
      expect(entry?.modelOverride).toBe("gpt-5.4");
      expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-html-1");
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("rejects ambiguous compact model callbacks and returns provider list", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({
      config: {
        agents: {
          defaults: {
            model: "anthropic/shared-model",
            models: {
              "anthropic/shared-model": {},
              "openai/shared-model": {},
            },
          },
        },
        channels: {
          telegram: {
            allowFrom: ["*"],
            dmPolicy: "open",
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        data: "mdl_sel/shared-model",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-model-compact-2",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 15,
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain(
      'Could not resolve model "shared-model".',
    );
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-model-compact-2");
  });

  it("includes sender identity in group envelope headers", async () => {
    onSpy.mockClear();
    replySpy.mockClear();

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

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
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
    const { expectChannelInboundContextContract: expectInboundContextContract } =
      await loadInboundContextContract();
    const { escapeRegExp, formatEnvelopeTimestamp } = await loadEnvelopeTimestampHelpers();
    expectInboundContextContract(payload);
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("uses quote text when a Telegram partial reply is received", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        quote: {
          text: "summarize this",
        },
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
    expect(payload.Body).toContain("[Quoting Ada id:9001]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("includes replied image media in inbound context for text replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
    );
    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_800,
          reply_to_message: {
            from: { first_name: "Ada" },
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
          },
          text: "what is in this image?",
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as {
        MediaPath?: string;
        MediaPaths?: string[];
        ReplyToBody?: string;
      };
      expect(payload.ReplyToBody).toBe("<media:image>");
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not fetch reply media for unauthorized DM replies", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    sendMessageSpy.mockClear();
    readChannelAllowFromStore.mockResolvedValue([]);
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: [],
          dmPolicy: "pairing",
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({}),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        from: { first_name: "Eve", id: 999 },
        reply_to_message: {
          from: { first_name: "Ada" },
          message_id: 9001,
          photo: [{ file_id: "reply-photo-1" }],
        },
        text: "hey",
      },
    });

    expect(getFileSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("defers reply media download until debounce flush", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    getFileSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const replyDelivered = waitForReplyCalls(1);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 42 },
          message_id: 101,
          reply_to_message: {
            from: { first_name: "Ada" },
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
          },
          text: "first",
        },
      });
      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_801,
          from: { first_name: "Ada", id: 42 },
          message_id: 102,
          reply_to_message: {
            from: { first_name: "Ada" },
            message_id: 9001,
            photo: [{ file_id: "reply-photo-1" }],
          },
          text: "second",
        },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(getFileSpy).not.toHaveBeenCalled();

      const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
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
      expect(flushTimer).toBeTypeOf("function");
      await flushTimer?.();
      await replyDelivered;

      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledWith("reply-photo-1");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("isolates inbound debounce by DM topic thread id", async () => {
    const DEBOUNCE_MS = 4321;
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          allowFrom: ["*"],
          dmPolicy: "open",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const repliesDelivered = waitForReplyCalls(2);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_800,
          from: { first_name: "Ada", id: 42 },
          message_id: 201,
          message_thread_id: 100,
          text: "topic-100",
        },
      });
      await handler({
        getFile: async () => ({}),
        me: { username: "openclaw_bot" },
        message: {
          chat: { id: 7, type: "private" },
          date: 1_736_380_801,
          from: { first_name: "Ada", id: 42 },
          message_id: 202,
          message_thread_id: 200,
          text: "topic-200",
        },
      });

      expect(replySpy).not.toHaveBeenCalled();

      const debounceTimerIndexes = setTimeoutSpy.mock.calls
        .map((call, index) => ({ delay: call[1], index }))
        .filter((entry) => entry.delay === DEBOUNCE_MS)
        .map((entry) => entry.index);
      expect(debounceTimerIndexes.length).toBeGreaterThanOrEqual(2);

      for (const index of debounceTimerIndexes) {
        clearTimeout(setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>);
      }
      for (const index of debounceTimerIndexes) {
        const flushTimer = setTimeoutSpy.mock.calls[index]?.[0] as (() => unknown) | undefined;
        await flushTimer?.();
      }

      await repliesDelivered;
      const threadIds = replySpy.mock.calls
        .map(
          (call: [unknown, ...unknown[]]) =>
            (call[0] as { MessageThreadId?: number }).MessageThreadId,
        )
        .toSorted((a: number | undefined, b: number | undefined) => (a ?? 0) - (b ?? 0));
      expect(threadIds).toEqual([100, 200]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("handles quote-only replies without reply metadata", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        quote: {
          text: "summarize this",
        },
        text: "Sure, see below",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting unknown sender]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBeUndefined();
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("unknown sender");
  });

  it("uses external_reply quote text for partial replies", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        external_reply: {
          from: { first_name: "Ada" },
          message_id: 9002,
          quote: {
            text: "summarize this",
          },
          text: "Can you summarize this?",
        },
        text: "Sure, see below",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Quoting Ada id:9002]");
    expect(payload.Body).toContain('"summarize this"');
    expect(payload.ReplyToId).toBe("9002");
    expect(payload.ReplyToBody).toBe("summarize this");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("propagates forwarded origin from external_reply targets", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: 7, type: "private" },
        date: 1_736_380_800,
        external_reply: {
          forward_origin: {
            date: 500,
            sender_user: {
              first_name: "Bob",
              id: 999,
              is_bot: false,
              last_name: "Smith",
              username: "bobsmith",
            },
            type: "user",
          },
          from: { first_name: "Ada" },
          message_id: 9003,
          quote: {
            text: "forwarded snippet",
          },
          text: "forwarded text",
        },
        text: "Thoughts?",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToForwardedFrom).toBe("Bob Smith (@bobsmith)");
    expect(payload.ReplyToForwardedFromType).toBe("user");
    expect(payload.ReplyToForwardedFromId).toBe("999");
    expect(payload.ReplyToForwardedFromUsername).toBe("bobsmith");
    expect(payload.ReplyToForwardedFromTitle).toBe("Bob Smith");
    expect(payload.ReplyToForwardedDate).toBe(500_000);
    expect(payload.Body).toContain(
      "[Forwarded from Bob Smith (@bobsmith) at 1970-01-01T00:08:20.000Z]",
    );
  });

  it("redacts forwarded origin inside reply targets when context visibility is allowlist", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          contextVisibility: "allowlist",
          groupPolicy: "allowlist",
          groups: {
            "-1007": {
              allowFrom: ["1"],
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: -1007, title: "Ops", type: "group" },
        date: 1_736_380_800,
        from: { first_name: "Ada", id: 1, is_bot: false, username: "ada" },
        message_id: 9004,
        reply_to_message: {
          forward_origin: {
            date: 500,
            sender_user: {
              first_name: "Bob",
              id: 999,
              is_bot: false,
              last_name: "Smith",
              username: "bobsmith",
            },
            type: "user",
          },
          from: { first_name: "Ada", id: 1, is_bot: false, username: "ada" },
          message_id: 9003,
          text: "forwarded text",
        },
        text: "Thoughts?",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.ReplyToId).toBe("9003");
    expect(payload.ReplyToBody).toBe("forwarded text");
    expect(payload.ReplyToSender).toBe("Ada");
    expect(payload.ReplyToForwardedFrom).toBeUndefined();
    expect(payload.ReplyToForwardedFromType).toBeUndefined();
    expect(payload.ReplyToForwardedFromId).toBeUndefined();
    expect(payload.ReplyToForwardedFromUsername).toBeUndefined();
    expect(payload.ReplyToForwardedDate).toBeUndefined();
    expect(payload.Body).not.toContain("[Forwarded from Bob Smith (@bobsmith)");
  });

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { id: 999, username: "openclaw_bot" },
      message: {
        chat: { id: 456, title: "Ops Chat", type: "group" },
        date: 1_736_380_800,
        reply_to_message: {
          from: { first_name: "OpenClaw", id: 999 },
          message_id: 42,
          text: "original reply",
        },
        text: "following up",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
  });

  it("inherits group allowlist + requireMention in topics", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              requireMention: false,
              topics: {
                "99": {},
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: {
          id: -1_001_234_567_890,
          is_forum: true,
          title: "Forum Group",
          type: "supergroup",
        },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        message_thread_id: 99,
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: {
          id: -1_001_234_567_890,
          is_forum: true,
          title: "Forum Group",
          type: "supergroup",
        },
        date: 1_736_380_800,
        from: { id: 123_456_789, username: "testuser" },
        message_thread_id: 99,
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("allows group messages for per-group groupPolicy open override (global groupPolicy allowlist)", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "random" },
        text: "hello",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks control commands from unauthorized senders in per-group open groups", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-100123456789": {
              groupPolicy: "open",
              requireMention: false,
            },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
      message: {
        chat: { id: -100_123_456_789, title: "Test Group", type: "group" },
        date: 1_736_380_800,
        from: { id: 999_999, username: "random" },
        text: "/status",
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes plugin-owned callback namespaces before synthetic command fallback", async () => {
    onSpy.mockClear();
    replySpy.mockClear();
    editMessageTextSpy.mockClear();
    sendMessageSpy.mockClear();
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      handler: (async ({ respond, callback }: TelegramInteractiveHandlerContext) => {
        await respond.editMessage({
          text: `Handled ${callback.payload}`,
        });
        return { handled: true };
      }) as never,
      namespace: "codexapp",
    });

    createTelegramBot({
      config: {
        channels: {
          telegram: {
            allowFrom: ["*"],
            dmPolicy: "open",
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        data: "codexapp:resume:thread-1",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-codex-1",
        message: {
          chat: { id: 1234, type: "private" },
          date: 1_736_380_800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(editMessageTextSpy).toHaveBeenCalledWith(1234, 11, "Handled resume:thread-1", undefined);
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("routes Telegram #General callback payloads as topic 1 when Telegram omits topic metadata", async () => {
    onSpy.mockClear();
    getChatSpy.mockResolvedValue({ id: -100_123_456_789, is_forum: true, type: "supergroup" });
    const handler = vi.fn(
      async ({ respond, conversationId, threadId }: TelegramInteractiveHandlerContext) => {
        expect(conversationId).toBe("-100123456789:topic:1");
        expect(threadId).toBe(1);
        await respond.editMessage({
          text: `Handled ${conversationId}`,
        });
        return { handled: true };
      },
    );
    registerPluginInteractiveHandler("codex-plugin", {
      channel: "telegram",
      handler: handler as never,
      namespace: "codexapp",
    });

    createTelegramBot({
      config: {
        channels: {
          telegram: {
            allowFrom: ["*"],
            dmPolicy: "open",
          },
        },
      },
      token: "tok",
    });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        data: "codexapp:resume:thread-1",
        from: { first_name: "Ada", id: 9, username: "ada_bot" },
        id: "cbq-codex-general",
        message: {
          chat: { id: -100_123_456_789, title: "Forum Group", type: "supergroup" },
          date: 1_736_380_800,
          message_id: 11,
          text: "Select a thread",
        },
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
      me: { username: "openclaw_bot" },
    });

    expect(getChatSpy).toHaveBeenCalledWith(-100_123_456_789);
    expect(handler).toHaveBeenCalledOnce();
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      -100_123_456_789,
      11,
      "Handled -100123456789:topic:1",
      undefined,
    );
  });
  it("sets command target session key for dm topic commands", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
      commands: { native: true },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      match: "",
      message: {
        chat: { id: 12_345, type: "private" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        message_id: 42,
        message_thread_id: 99,
        text: "/status",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandTargetSessionKey).toBe("agent:main:main:thread:12345:99");
  });

  it("allows native DM commands for paired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
      commands: { native: true },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      match: "",
      message: {
        chat: { id: 12_345, type: "private" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        message_id: 42,
        text: "/status",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(
      sendMessageSpy.mock.calls.some(
        (call) => call[1] === "You are not authorized to use this command.",
      ),
    ).toBe(false);
  });

  it("keeps native DM commands on the startup-resolved config when fresh reads contain SecretRefs", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    const startupConfig = {
      channels: {
        telegram: {
          botToken: "resolved-token",
          dmPolicy: "pairing" as const,
        },
      },
      commands: { native: true },
    };

    createTelegramBot({
      config: startupConfig,
      token: "tok",
    });
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
          dmPolicy: "pairing",
        },
      },
      commands: { native: true },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["12345"]);

    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      match: "",
      message: {
        chat: { id: 12_345, type: "private" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        message_id: 42,
        text: "/status",
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks native DM commands for unpaired users", async () => {
    onSpy.mockClear();
    sendMessageSpy.mockClear();
    commandSpy.mockClear();
    replySpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
        },
      },
      commands: { native: true },
    });
    readChannelAllowFromStore.mockResolvedValueOnce([]);

    createTelegramBot({ token: "tok" });
    const handler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error("status command handler missing");
    }

    await handler({
      match: "",
      message: {
        chat: { id: 12_345, type: "private" },
        date: 1_736_380_800,
        from: { id: 12_345, username: "testuser" },
        message_id: 42,
        text: "/status",
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      12_345,
      "You are not authorized to use this command.",
      {},
    );
  });

  it("registers message_reaction handler", () => {
    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler).toBeDefined();
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9, username: "ada_bot" },
      },
      update: { update_id: 500 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${THUMBS_UP_EMOJI} by Ada (@ada_bot) on msg 42`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
      }),
    );
  });

  it.each([
    {
      channelConfig: { dmPolicy: "disabled", reactionNotifications: "all" },
      expectedEnqueueCalls: 0,
      name: "blocks reaction when dmPolicy is disabled",
      reaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      updateId: 510,
    },
    {
      channelConfig: { dmPolicy: "pairing", reactionNotifications: "all" },
      expectedEnqueueCalls: 0,
      name: "blocks reaction in pairing mode for non-paired sender (default dmPolicy)",
      reaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      updateId: 514,
    },
    {
      channelConfig: {
        allowFrom: ["12345"],
        dmPolicy: "allowlist",
        reactionNotifications: "all",
      },
      expectedEnqueueCalls: 0,
      name: "blocks reaction in allowlist mode for unauthorized direct sender",
      reaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      updateId: 511,
    },
    {
      channelConfig: { allowFrom: ["9"], dmPolicy: "allowlist", reactionNotifications: "all" },
      expectedEnqueueCalls: 1,
      name: "allows reaction in allowlist mode for authorized direct sender",
      reaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      updateId: 512,
    },
    {
      channelConfig: {
        dmPolicy: "open",
        groupAllowFrom: ["12345"],
        groupPolicy: "allowlist",
        reactionNotifications: "all",
      },
      expectedEnqueueCalls: 0,
      name: "blocks reaction in group allowlist mode for unauthorized sender",
      reaction: {
        chat: { id: 9999, type: "supergroup" },
        date: 1_736_380_800,
        message_id: 77,
        new_reaction: [{ emoji: FIRE_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      updateId: 513,
    },
  ])("$name", async ({ updateId, channelConfig, reaction, expectedEnqueueCalls }) => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: channelConfig,
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: reaction,
      update: { update_id: updateId },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(expectedEnqueueCalls);
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 501 },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 43,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 502 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 99,
        new_reaction: [{ emoji: PARTY_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 503 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 99`,
      expect.any(Object),
    );
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 99,
        new_reaction: [{ emoji: PARTY_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 503 },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 99,
        new_reaction: [{ emoji: PARTY_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 503 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 99,
        new_reaction: [{ emoji: PARTY_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Bot", id: 9, is_bot: true },
      },
      update: { update_id: 503 },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [],
        old_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 504 },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("enqueues one event per added emoji reaction", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 42,
        new_reaction: [
          { emoji: THUMBS_UP_EMOJI, type: "emoji" },
          { emoji: FIRE_EMOJI, type: "emoji" },
          { emoji: PARTY_EMOJI, type: "emoji" },
        ],
        old_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 505 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.map((call) => call[0])).toEqual([
      `Telegram reaction added: ${FIRE_EMOJI} by Ada on msg 42`,
      `Telegram reaction added: ${PARTY_EMOJI} by Ada on msg 42`,
    ]);
  });

  it("routes forum group reactions to the general topic (thread id not available on reactions)", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // MessageReactionUpdated does not include message_thread_id in the Bot API,
    // So forum reactions always route to the general topic (1).
    await handler({
      messageReaction: {
        chat: { id: 5678, is_forum: true, type: "supergroup" },
        date: 1_736_380_800,
        message_id: 100,
        new_reaction: [{ emoji: FIRE_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Bob", id: 10, username: "bob_user" },
      },
      update: { update_id: 505 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${FIRE_EMOJI} by Bob (@bob_user) on msg 100`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:5678:100:10"),
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
      }),
    );
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 5678, is_forum: true, type: "supergroup" },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { first_name: "Bob", id: 10 },
        date: 1_736_380_800,
        old_reaction: [],
        new_reaction: [{ emoji: EYES_EMOJI, type: "emoji" }],
      },
      update: { update_id: 506 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${EYES_EMOJI} by Bob on msg 101`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:5678:101:10"),
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
      }),
    );
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 9999, type: "group" },
        date: 1_736_380_800,
        message_id: 200,
        new_reaction: [{ emoji: HEART_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Charlie", id: 11 },
      },
      update: { update_id: 507 },
    });

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventSpy).toHaveBeenCalledWith(
      `Telegram reaction added: ${HEART_EMOJI} by Charlie on msg 200`,
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:9999:200:11"),
        sessionKey: expect.stringContaining("telegram:group:9999"),
      }),
    );
    // Verify session key does NOT contain :topic:
    const eventOptions = enqueueSystemEventSpy.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    const sessionKey = eventOptions.sessionKey ?? "";
    expect(sessionKey).not.toContain(":topic:");
  });

  it("blocks reaction in own mode when cache is warm and message not sent by bot", async () => {
    onSpy.mockClear();
    enqueueSystemEventSpy.mockClear();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      messageReaction: {
        chat: { id: 1234, type: "private" },
        date: 1_736_380_800,
        message_id: 99,
        new_reaction: [{ emoji: THUMBS_UP_EMOJI, type: "emoji" }],
        old_reaction: [],
        user: { first_name: "Ada", id: 9 },
      },
      update: { update_id: 601 },
    });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });
});
