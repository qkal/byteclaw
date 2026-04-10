import { describe, expect, it, vi } from "vitest";
import {
  config,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, streamMock, upsertPairingRequestMock } =
  getSignalToolResultTestMocks();

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}
describe("monitorSignalProvider tool results", () => {
  it("pairs uuid-only senders with a uuid allowlist entry", async () => {
    const baseChannels = (config.channels ?? {}) as Record<string, unknown>;
    const baseSignal = (baseChannels.signal ?? {}) as Record<string, unknown>;
    setSignalToolResultTestConfig({
      ...config,
      channels: {
        ...baseChannels,
        signal: {
          ...baseSignal,
          allowFrom: [],
          autoStart: false,
          dmPolicy: "pairing",
        },
      },
    });
    const abortController = new AbortController();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          dataMessage: {
            message: "hello",
          },
          sourceName: "Ada",
          sourceUuid: uuid,
          timestamp: 1,
        },
      };
      await onEvent({
        data: JSON.stringify(payload),
        event: "receive",
      });
      abortController.abort();
    });

    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "signal",
        id: `uuid:${uuid}`,
        meta: expect.objectContaining({ name: "Ada" }),
      }),
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      `Your Signal sender id: uuid:${uuid}`,
    );
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;

    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stream dropped");
      }
      abortController.abort();
    });

    try {
      const monitorPromise = monitorSignalProvider({
        abortSignal: abortController.signal,
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        reconnectPolicy: {
          factor: 1,
          initialMs: 1,
          jitter: 0,
          maxMs: 1,
        },
      });

      await vi.advanceTimersByTimeAsync(5);
      await monitorPromise;

      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
