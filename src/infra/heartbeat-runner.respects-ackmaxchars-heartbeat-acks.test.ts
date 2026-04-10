import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  seedMainSessionStore,
  withTempHeartbeatSandbox,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce ack handling", () => {
  const WHATSAPP_GROUP = "120363140186826074@g.us";
  const TELEGRAM_GROUP = "-1001234567890";

  function createHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat: Record<string, unknown>;
    channels: Record<string, unknown>;
    messages?: Record<string, unknown>;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: params.heartbeat as never,
          workspace: params.tmpDir,
        },
      },
      channels: params.channels as never,
      ...(params.messages ? { messages: params.messages as never } : {}),
      session: { store: params.storePath },
    };
  }

  function makeWhatsAppDeps(
    params: {
      sendWhatsApp?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
      webAuthExists?: () => Promise<boolean>;
      hasActiveWebListener?: () => boolean;
    } = {},
  ) {
    return {
      ...(params.sendWhatsApp ? { whatsapp: params.sendWhatsApp as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      hasActiveWebListener: params.hasActiveWebListener ?? (() => true),
      nowMs: params.nowMs ?? (() => 0),
      webAuthExists: params.webAuthExists ?? (async () => true),
    } satisfies HeartbeatDeps;
  }

  function makeTelegramDeps(
    params: {
      sendTelegram?: ReturnType<typeof vi.fn>;
      getQueueSize?: () => number;
      nowMs?: () => number;
    } = {},
  ) {
    return {
      ...(params.sendTelegram ? { telegram: params.sendTelegram as unknown } : {}),
      getQueueSize: params.getQueueSize ?? (() => 0),
      nowMs: params.nowMs ?? (() => 0),
    } satisfies HeartbeatDeps;
  }

  function createMessageSendSpy(extra: Record<string, unknown> = {}) {
    return vi.fn().mockResolvedValue({
      messageId: "m1",
      toJid: "jid",
      ...extra,
    });
  }

  async function runTelegramHeartbeatWithDefaults(params: {
    tmpDir: string;
    storePath: string;
    replySpy: HeartbeatReplySpy;
    replyText: string;
    messages?: Record<string, unknown>;
    telegramOverrides?: Record<string, unknown>;
  }) {
    const cfg = createHeartbeatConfig({
      channels: {
        telegram: {
          allowFrom: ["*"],
          heartbeat: { showOk: false },
          token: "test-token",
          ...params.telegramOverrides,
        },
      },
      heartbeat: { every: "5m", target: "telegram" },
      storePath: params.storePath,
      tmpDir: params.tmpDir,
      ...(params.messages ? { messages: params.messages } : {}),
    });

    await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
    });

    params.replySpy.mockResolvedValue({ text: params.replyText });
    const sendTelegram = createMessageSendSpy();
    await runHeartbeatOnce({
      cfg,
      deps: {
        ...makeTelegramDeps({ sendTelegram }),
        getReplyFromConfig: params.replySpy,
      },
    });
    return sendTelegram;
  }

  function createWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): OpenClawConfig {
    return createHeartbeatConfig({
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          ...(params.visibility ? { heartbeat: params.visibility } : {}),
        },
      },
      heartbeat: {
        every: "5m",
        target: "whatsapp",
        ...params.heartbeat,
      },
      storePath: params.storePath,
      tmpDir: params.tmpDir,
    });
  }

  async function createSeededWhatsAppHeartbeatConfig(params: {
    tmpDir: string;
    storePath: string;
    heartbeat?: Record<string, unknown>;
    visibility?: Record<string, unknown>;
  }): Promise<OpenClawConfig> {
    const cfg = createWhatsAppHeartbeatConfig(params);
    await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: WHATSAPP_GROUP,
    });
    return cfg;
  }

  it("respects ackMaxChars for heartbeat acks", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        heartbeat: { ackMaxChars: 0 },
        storePath,
        tmpDir,
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK 🦞" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalled();
    });
  });

  it("sends HEARTBEAT_OK when visibility.showOk is true", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        storePath,
        tmpDir,
        visibility: { showOk: true },
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(sendWhatsApp).toHaveBeenCalledWith(WHATSAPP_GROUP, "HEARTBEAT_OK", expect.any(Object));
    });
  });

  it.each([
    {
      expectedCalls: 0,
      replyText: "HEARTBEAT_OK",
      title: "does not deliver HEARTBEAT_OK to telegram when showOk is false",
    },
    {
      expectedCalls: 0,
      messages: { responsePrefix: "[openclaw]" },
      replyText: "[openclaw] HEARTBEAT_OK all good",
      title: "strips responsePrefix before HEARTBEAT_OK detection and suppresses short ack text",
    },
    {
      expectedCalls: 1,
      expectedText: "History check complete",
      messages: { responsePrefix: "Hi" },
      replyText: "History check complete",
      title: "does not strip alphanumeric responsePrefix from larger words",
    },
  ])("$title", async ({ replyText, messages, expectedCalls, expectedText }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sendTelegram = await runTelegramHeartbeatWithDefaults({
        messages,
        replySpy,
        replyText,
        storePath,
        tmpDir,
      });

      expect(sendTelegram).toHaveBeenCalledTimes(expectedCalls);
      if (expectedText) {
        expect(sendTelegram).toHaveBeenCalledWith(TELEGRAM_GROUP, expectedText, expect.any(Object));
      }
    });
  });

  it("skips heartbeat LLM calls when visibility disables all output", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createWhatsAppHeartbeatConfig({
        storePath,
        tmpDir,
        visibility: { showAlerts: false, showOk: false, useIndicator: false },
      });

      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
      });

      const sendWhatsApp = createMessageSendSpy();

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(replySpy).not.toHaveBeenCalled();
      expect(sendWhatsApp).not.toHaveBeenCalled();
      expect(result).toEqual({ reason: "alerts-disabled", status: "skipped" });
    });
  });

  it("skips delivery for markup-wrapped HEARTBEAT_OK", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        storePath,
        tmpDir,
      });

      replySpy.mockResolvedValue({ text: "<b>HEARTBEAT_OK</b>" });
      const sendWhatsApp = createMessageSendSpy();

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({ sendWhatsApp }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("does not regress updatedAt when restoring heartbeat sessions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const originalUpdatedAt = 1000;
      const bumpedUpdatedAt = 2000;
      const cfg = createWhatsAppHeartbeatConfig({
        storePath,
        tmpDir,
      });

      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: WHATSAPP_GROUP,
        updatedAt: originalUpdatedAt,
      });

      replySpy.mockImplementationOnce(async () => {
        const raw = await fs.readFile(storePath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, { updatedAt?: number } | undefined>;
        if (parsed[sessionKey]) {
          parsed[sessionKey] = {
            ...parsed[sessionKey],
            updatedAt: bumpedUpdatedAt,
          };
        }
        await fs.writeFile(storePath, JSON.stringify(parsed, null, 2));
        return { text: "" };
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps(),
          getReplyFromConfig: replySpy,
        },
      });

      const finalStore = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { updatedAt?: number } | undefined
      >;
      expect(finalStore[sessionKey]?.updatedAt).toBe(bumpedUpdatedAt);
    });
  });

  it("skips WhatsApp delivery when not linked or running", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = await createSeededWhatsAppHeartbeatConfig({
        storePath,
        tmpDir,
      });

      replySpy.mockResolvedValue({ text: "Heartbeat alert" });
      const sendWhatsApp = createMessageSendSpy();

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeWhatsAppDeps({
            hasActiveWebListener: () => false,
            sendWhatsApp,
            webAuthExists: async () => false,
          }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(res.status).toBe("skipped");
      expect(res).toMatchObject({ reason: "whatsapp-not-linked" });
      expect(sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  async function expectTelegramHeartbeatAccountId(params: {
    heartbeat: Record<string, unknown>;
    telegram: Record<string, unknown>;
    expectedAccountId: string | undefined;
  }): Promise<void> {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({
        channels: { telegram: params.telegram },
        heartbeat: params.heartbeat,
        storePath,
        tmpDir,
      });
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
      });

      replySpy.mockResolvedValue({ text: "Hello from heartbeat" });
      const sendTelegram = createMessageSendSpy({ chatId: TELEGRAM_GROUP });

      await runHeartbeatOnce({
        cfg,
        deps: {
          ...makeTelegramDeps({ sendTelegram }),
          getReplyFromConfig: replySpy,
        },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        TELEGRAM_GROUP,
        "Hello from heartbeat",
        expect.objectContaining({ accountId: params.expectedAccountId, verbose: false }),
      );
    });
  }

  it.each([
    {
      expectedAccountId: undefined,
      heartbeat: { every: "5m", target: "telegram" },
      telegram: { botToken: "test-bot-token-123" },
      title: "passes through accountId for telegram heartbeats",
    },
    {
      expectedAccountId: undefined,
      heartbeat: { every: "5m", target: "telegram" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      title: "does not pre-resolve telegram accountId (allows config-only account tokens)",
    },
    {
      expectedAccountId: "work",
      heartbeat: { accountId: "work", every: "5m", target: "telegram" },
      telegram: {
        accounts: {
          work: { botToken: "test-bot-token-123" },
        },
      },
      title: "uses explicit heartbeat accountId for telegram delivery",
    },
  ])("$title", async ({ heartbeat, telegram, expectedAccountId }) => {
    await expectTelegramHeartbeatAccountId({ expectedAccountId, heartbeat, telegram });
  });
});
