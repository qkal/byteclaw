import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "../test-support/lifecycle-test-support.js";
import {
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "../test-support/monitor-mocks-test-support.js";

describe("Zalo reply-once lifecycle", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const resolveAgentRouteMock = vi.fn(() => ({
    accountId: "acct-zalo-lifecycle",
    agentId: "main",
    channel: "zalo",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
    sessionKey: "agent:main:zalo:direct:dm-chat-1",
  }));
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      reply: {
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
      },
      routing: {
        resolveAgentRoute:
          resolveAgentRouteMock as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      session: {
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
    });
  });

  afterEach(async () => {
    await resetLifecycleTestState();
  });

  function createReplyOnceMonitorSetup() {
    return createLifecycleMonitorSetup({
      accountId: "acct-zalo-lifecycle",
      dmPolicy: "open",
    });
  }

  it("routes one accepted webhook event to one visible reply across duplicate replay", async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "zalo reply once" });
      },
    );

    const monitor = await startWebhookLifecycleMonitor(createReplyOnceMonitorSetup());

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            payload: createTextUpdate({
              chatId: "dm-chat-1",
              messageId: `zalo-replay-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
            }),
            secret: "supersecret",
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(finalizeInboundContextMock).toHaveBeenCalledTimes(1);
      expect(finalizeInboundContextMock).toHaveBeenCalledWith(
        expect.objectContaining({
          AccountId: "acct-zalo-lifecycle",
          From: "zalo:user-1",
          MessageSid: expect.stringContaining("zalo-replay-"),
          SessionKey: "agent:main:zalo:direct:dm-chat-1",
          To: "zalo:dm-chat-1",
        }),
      );
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
      expect(recordInboundSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:zalo:direct:dm-chat-1",
        }),
      );
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        "zalo-token",
        expect.objectContaining({
          chat_id: "dm-chat-1",
          text: "zalo reply once",
        }),
        undefined,
      );
    } finally {
      await monitor.stop();
    }
  });

  it("does not emit a second visible reply when replay arrives after a post-send failure", async () => {
    let dispatchAttempts = 0;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        dispatchAttempts += 1;
        await dispatcherOptions.deliver({ text: "zalo reply after failure" });
        if (dispatchAttempts === 1) {
          throw new Error("post-send failure");
        }
      },
    );

    const monitor = await startWebhookLifecycleMonitor(createReplyOnceMonitorSetup());

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            payload: createTextUpdate({
              chatId: "dm-chat-1",
              messageId: `zalo-retry-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
            }),
            secret: "supersecret",
            settleBeforeReplay: true,
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Zalo webhook failed: Error: post-send failure"),
      );
    } finally {
      await monitor.stop();
    }
  });
});
