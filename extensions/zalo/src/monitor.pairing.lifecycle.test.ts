import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withServer } from "../../../test/helpers/http-test-server.js";
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

describe("Zalo pairing lifecycle", () => {
  const readAllowFromStoreMock = vi.fn(async () => [] as string[]);
  const upsertPairingRequestMock = vi.fn(async () => ({ code: "PAIRCODE", created: true }));

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      commands: {
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldComputeCommandAuthorized: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
    });
  });

  afterEach(async () => {
    await resetLifecycleTestState();
  });

  function createPairingMonitorSetup() {
    return createLifecycleMonitorSetup({
      accountId: "acct-zalo-pairing",
      allowFrom: [],
      dmPolicy: "pairing",
    });
  }

  it("emits one pairing reply across duplicate webhook replay and scopes reads and writes to accountId", async () => {
    const monitor = await startWebhookLifecycleMonitor(createPairingMonitorSetup());

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            payload: createTextUpdate({
              chatId: "dm-pairing-1",
              messageId: `zalo-pairing-${Date.now()}`,
              userId: "user-unauthorized",
              userName: "Unauthorized User",
            }),
            secret: "supersecret",
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(readAllowFromStoreMock).toHaveBeenCalledTimes(1);
      expect(readAllowFromStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acct-zalo-pairing",
          channel: "zalo",
        }),
      );
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(upsertPairingRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acct-zalo-pairing",
          channel: "zalo",
          id: "user-unauthorized",
        }),
      );
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        "zalo-token",
        expect.objectContaining({
          chat_id: "dm-pairing-1",
          text: expect.stringContaining("PAIRCODE"),
        }),
        undefined,
      );
    } finally {
      await monitor.stop();
    }
  });

  it("does not emit a second pairing reply when replay arrives after the first send fails", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("pairing send failed"));

    const monitor = await startWebhookLifecycleMonitor(createPairingMonitorSetup());

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            payload: createTextUpdate({
              chatId: "dm-pairing-1",
              messageId: `zalo-pairing-retry-${Date.now()}`,
              userId: "user-unauthorized",
              userName: "Unauthorized User",
            }),
            secret: "supersecret",
            settleBeforeReplay: true,
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).not.toHaveBeenCalled();
    } finally {
      await monitor.stop();
    }
  });
});
