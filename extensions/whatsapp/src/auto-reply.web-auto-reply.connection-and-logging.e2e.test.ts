import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { withEnvAsync } from "openclaw/plugin-sdk/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
import {
  createMockWebListener,
  createScriptedWebListenerFactory,
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  setLoadConfigMock,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

async function startWatchdogScenario(params: {
  monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
}) {
  const sleep = vi.fn(async () => {});
  const scripted = createScriptedWebListenerFactory();
  const started = startWebAutoReplyMonitor({
    heartbeatSeconds: 60,
    listenerFactory: scripted.listenerFactory,
    messageTimeoutMs: 30,
    monitorWebChannelFn: params.monitorWebChannel as never,
    sleep,
    watchdogCheckMs: 5,
  });

  await Promise.resolve();
  expect(scripted.getListenerCount()).toBe(1);
  await vi.waitFor(
    () => {
      expect(scripted.getOnMessage()).toBeTypeOf("function");
    },
    { interval: 2, timeout: 250 },
  );

  const spies = createWebInboundDeliverySpies();
  await sendWebDirectInboundMessage({
    body: "hi",
    from: "+1",
    id: "m1",
    onMessage: scripted.getOnMessage()!,
    spies,
    to: "+2",
  });

  return { scripted, sleep, spies, ...started };
}

describe("web auto-reply connection", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(() => formatEnvelopeTimestamp(d, " America/Los_Angeles ")).not.toThrow();
  });

  it("handles reconnect progress and max-attempt stop behavior", async () => {
    for (const scenario of [
      {
        closeTwiceAndFinish: false,
        expectedCallsAfterFirstClose: 2,
        expectedError: "Retry 1",
        reconnect: { factor: 1.1, initialMs: 10, maxAttempts: 3, maxMs: 10 },
      },
      {
        closeTwiceAndFinish: true,
        expectedCallsAfterFirstClose: 2,
        expectedError: "max attempts reached",
        reconnect: { factor: 1.1, initialMs: 5, maxAttempts: 2, maxMs: 5 },
      },
    ]) {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { runtime, controller, run } = startWebAutoReplyMonitor({
        listenerFactory: scripted.listenerFactory,
        monitorWebChannelFn: monitorWebChannel as never,
        reconnect: scenario.reconnect,
        sleep,
      });

      await Promise.resolve();
      expect(scripted.getListenerCount()).toBe(1);

      scripted.resolveClose(0);
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(scenario.expectedCallsAfterFirstClose);
        },
        { interval: 2, timeout: 250 },
      );

      if (scenario.closeTwiceAndFinish) {
        scripted.resolveClose(1);
        await run;
      } else {
        controller.abort();
        scripted.resolveClose(1);
        await Promise.resolve();
        await run;
      }

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(scenario.expectedError));
    }
  });

  it("treats status 440 as non-retryable and stops without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const scripted = createScriptedWebListenerFactory();
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      listenerFactory: scripted.listenerFactory,
      monitorWebChannelFn: monitorWebChannel as never,
      reconnect: { factor: 1.1, initialMs: 10, maxAttempts: 3, maxMs: 10 },
      sleep,
    });

    await Promise.resolve();
    expect(scripted.getListenerCount()).toBe(1);
    scripted.resolveClose(0, {
      error: "Unknown Stream Errored (conflict)",
      isLoggedOut: false,
      status: 440,
    });

    const completedQuickly = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
    ]);

    if (!completedQuickly) {
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
        },
        { interval: 2, timeout: 250 },
      );
      controller.abort();
      scripted.resolveClose(1, { error: "aborted", isLoggedOut: false, status: 499 });
      await run;
    }

    expect(completedQuickly).toBe(true);
    expect(scripted.getListenerCount()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("status 440"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("session conflict"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Stopping web monitoring"));
  });

  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    try {
      const { scripted, controller, run } = await startWatchdogScenario({
        monitorWebChannel,
      });

      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
        },
        { interval: 2, timeout: 250 },
      );

      controller.abort();
      scripted.resolveClose(1, { isLoggedOut: false, status: 499 });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a reconnected listener a fresh watchdog window", async () => {
    vi.useFakeTimers();
    try {
      const { scripted, controller, run } = await startWatchdogScenario({
        monitorWebChannel,
      });

      scripted.resolveClose(0, { error: "first-close", isLoggedOut: false, status: 499 });
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(2);
        },
        { interval: 2, timeout: 250 },
      );

      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
      expect(scripted.getListenerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(3);
        },
        { interval: 2, timeout: 250 },
      );

      controller.abort();
      scripted.resolveClose(scripted.getListenerCount() - 1, {
        error: "aborted",
        isLoggedOut: false,
        status: 499,
      });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes inbound messages without batching and preserves timestamps", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      const originalMax = process.getMaxListeners();
      process.setMaxListeners?.(1);

      const store = await makeSessionStore({
        main: { sessionId: "sid", updatedAt: Date.now() },
      });

      try {
        const sendMedia = vi.fn();
        const reply = vi.fn().mockResolvedValue(undefined);
        const sendComposing = vi.fn();
        const resolver = vi.fn().mockResolvedValue({ text: "ok" });

        const capture = createWebListenerFactoryCapture();

        setLoadConfigMock(() => ({
          agents: {
            defaults: {
              envelopeTimezone: "utc",
            },
          },
          session: { store: store.storePath },
        }));

        await monitorWebChannel(false, capture.listenerFactory as never, false, resolver);
        const capturedOnMessage = capture.getOnMessage();
        expect(capturedOnMessage).toBeDefined();

        const spies = { reply, sendComposing, sendMedia };
        await sendWebDirectInboundMessage({
          body: "first",
          from: "+1",
          id: "m1",
          onMessage: capturedOnMessage!,
          spies,
          timestamp: 1_735_689_600_000,
          to: "+2",
        });
        await sendWebDirectInboundMessage({
          body: "second",
          from: "+1",
          id: "m2",
          onMessage: capturedOnMessage!,
          spies,
          timestamp: 1_735_693_200_000,
          to: "+2",
        });

        expect(resolver).toHaveBeenCalledTimes(2);
        const firstArgs = resolver.mock.calls[0][0];
        const secondArgs = resolver.mock.calls[1][0];
        const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"));
        const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"));
        const firstPattern = escapeRegExp(firstTimestamp);
        const secondPattern = escapeRegExp(secondTimestamp);
        expect(firstArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${firstPattern}\\] \\[openclaw\\] first`),
        );
        expect(firstArgs.Body).not.toContain("second");
        expect(secondArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${secondPattern}\\] \\[openclaw\\] second`),
        );
        expect(secondArgs.Body).not.toContain("first");
        expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
      } finally {
        process.setMaxListeners?.(originalMax);
        await store.cleanup();
        resetLoadConfigMock();
      }
    });
  });

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/openclaw-heartbeat-${crypto.randomUUID()}.log`;
    setLoggerOverride({ file: logPath, level: "trace" });

    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };

    const controller = new AbortController();
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<void>(() => {
        // Never resolves; abort will short-circuit
      });
      return { close: vi.fn(), onClose };
    });

    const run = monitorWebChannel(
      false,
      listenerFactory as never,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { factor: 1.1, initialMs: 5, maxAttempts: 1, maxMs: 5 },
      },
    );

    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.runAllTimersAsync();
    await run.catch(() => {});

    const content = await fs.readFile(logPath, "utf8");
    expect(content).toMatch(/web-heartbeat/);
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ file: logPath, level: "trace" });

    const capture = createWebListenerFactoryCapture();

    const resolver = vi.fn().mockResolvedValue({ text: "auto" });
    await monitorWebChannel(false, capture.listenerFactory as never, false, resolver as never);
    const capturedOnMessage = capture.getOnMessage();
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      accountId: "default",
      body: "hello",
      chatId: "+1",
      chatType: "direct",
      conversationId: "+1",
      from: "+1",
      id: "msg1",
      reply: vi.fn(),
      sendComposing: vi.fn(),
      sendMedia: vi.fn(),
      to: "+2",
    });

    const content = await fs.readFile(logPath, "utf8");
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });

  it("marks dispatch idle after replies flush", async () => {
    const markDispatchIdle = vi.fn();
    const typingMock = {
      cleanup: vi.fn(),
      isActive: vi.fn(() => false),
      markDispatchIdle,
      markRunComplete: vi.fn(),
      onReplyStart: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockImplementation(async (_ctx, opts) => {
      opts?.onTypingController?.(typingMock);
      return { text: "final reply" };
    });

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          accountId: "default",
          body: "hello",
          chatId: "direct:+1000",
          chatType: "direct",
          conversationId: "+1000",
          from: "+1000",
          id: "m1",
          reply,
          sendComposing,
          sendMedia,
          timestamp: Date.now(),
          to: "+2000",
        });
        return createMockWebListener();
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});
