import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Ghost reminder bug (issue #13317)", () => {
  const createHeartbeatDeps = (replyText: string) => {
    const sendTelegram = vi.fn().mockResolvedValue({
      chatId: "155462274",
      messageId: "m1",
    });
    const getReplySpy = vi.fn().mockResolvedValue({ text: replyText });
    return { getReplySpy, sendTelegram };
  };

  const createConfig = async (params: {
    tmpDir: string;
    storePath: string;
    target?: "telegram" | "none";
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
          },
          workspace: params.tmpDir,
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: params.storePath },
    };
    const sessionKey = await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });

    return { cfg, sessionKey };
  };

  const expectCronEventPrompt = (
    calledCtx: {
      Provider?: string;
      Body?: string;
    } | null,
    reminderText: string,
  ) => {
    expect(calledCtx).not.toBeNull();
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain(reminderText);
    expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
    expect(calledCtx?.Body).not.toContain("heartbeat poll");
  };

  const runCronReminderCase = async (
    tmpPrefix: string,
    enqueue: (sessionKey: string) => void,
  ): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string; ForceSenderIsOwnerFalse?: boolean } | null;
  }> =>
    runHeartbeatCase({
      enqueue,
      reason: "cron:reminder-job",
      replyText: "Relay this reminder now",
      tmpPrefix,
    });

  const runHeartbeatCase = async (params: {
    tmpPrefix: string;
    replyText: string;
    reason: string;
    enqueue: (sessionKey: string) => void;
    target?: "telegram" | "none";
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string; ForceSenderIsOwnerFalse?: boolean } | null;
    replyCallCount: number;
  }> =>
    withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const { sendTelegram, getReplySpy } = createHeartbeatDeps(params.replyText);
        const { cfg, sessionKey } = await createConfig({
          storePath,
          target: params.target,
          tmpDir,
        });
        params.enqueue(sessionKey);
        const result = await runHeartbeatOnce({
          agentId: "main",
          cfg,
          deps: {
            getReplyFromConfig: getReplySpy,
            telegram: sendTelegram,
          },
          reason: params.reason,
        });
        const calledCtx = (getReplySpy.mock.calls[0]?.[0] ?? null) as {
          Provider?: string;
          Body?: string;
        } | null;
        return {
          calledCtx,
          replyCallCount: getReplySpy.mock.calls.length,
          result,
          sendTelegram,
        };
      },
      { prefix: params.tmpPrefix },
    );

  it("does not use CRON_EVENT_PROMPT when only a HEARTBEAT_OK event is present", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      enqueue: (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
      },
      reason: "cron:test-job",
      replyText: "Heartbeat check-in",
      tmpPrefix: "openclaw-ghost-",
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.Body).not.toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).not.toContain("relay this reminder");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when an actionable cron event exists", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-",
      (sessionKey) => {
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when cron events are mixed with heartbeat noise", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-mixed-",
      (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT for tagged cron events on interval wake", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Cron: QMD maintenance completed", {
          contextKey: "cron:qmd-maintenance",
          sessionKey,
        });
      },
      reason: "interval",
      replyText: "Relay this cron update now",
      tmpPrefix: "openclaw-cron-interval-",
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain("Cron: QMD maintenance completed");
    expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses an internal-only cron prompt when delivery target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Reminder: Rotate API keys", { sessionKey });
      },
      reason: "cron:reminder-job",
      replyText: "Handled internally",
      target: "none",
      tmpPrefix: "openclaw-cron-internal-",
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("Handle this reminder internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("uses an internal-only exec prompt when delivery target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey });
      },
      reason: "exec-event",
      replyText: "Handled internally",
      target: "none",
      tmpPrefix: "openclaw-exec-internal-",
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("routes wake-triggered heartbeat replies using queued system-event delivery context", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              target: "last",
            },
            workspace: tmpDir,
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        chatId: "-100155462274",
        messageId: "m1",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        deliveryContext: {
          channel: "telegram",
          threadId: 42,
          to: "-100155462274",
        },
        sessionKey,
      });

      const result = await runHeartbeatOnce({
        agentId: "main",
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
        reason: "wake",
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "-100155462274",
        "Restart complete",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });

  it("does not reuse stale turn-source routing for isolated wake runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              isolatedSession: true,
              target: "last",
            },
            workspace: tmpDir,
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            lastChannel: "telegram",
            lastTo: "-100155462274",
            sessionId: "sid",
            updatedAt: Date.now(),
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        chatId: "-100155462274",
        messageId: "m1",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        deliveryContext: {
          channel: "telegram",
          threadId: 42,
          to: "-100999999999",
        },
        sessionKey,
      });

      const result = await runHeartbeatOnce({
        agentId: "main",
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
        reason: "wake",
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram.mock.calls[0]?.[0]).toBe("-100155462274");
      const options = sendTelegram.mock.calls[0]?.[2] as { messageThreadId?: number } | undefined;
      expect(options?.messageThreadId).toBeUndefined();
    });
  });
});
