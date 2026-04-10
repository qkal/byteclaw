import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SignalDaemonExitEvent } from "./daemon.js";
import {
  config,
  createMockSignalDaemonHandle,
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const { waitForTransportReadyMock, spawnSignalDaemonMock, streamMock } =
  getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = NonNullable<Parameters<typeof monitorSignalProvider>[0]>;

function createMonitorRuntime() {
  return {
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
    log: vi.fn(),
  };
}

function setSignalAutoStartConfig(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(createSignalToolResultConfig(overrides));
}

function createAutoAbortController() {
  const abortController = new AbortController();
  streamMock.mockImplementation(async () => {
    abortController.abort();
    return;
  });
  return abortController;
}

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    config: config as OpenClawConfig,
    waitForTransportReady:
      waitForTransportReadyMock as MonitorSignalProviderOptions["waitForTransportReady"],
    ...opts,
  });
}

function expectWaitForTransportReadyTimeout(timeoutMs: number) {
  expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
  expect(waitForTransportReadyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      timeoutMs,
    }),
  );
}

describe("monitorSignalProvider autostart", () => {
  it("uses bounded readiness checks when auto-starting the daemon", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      runtime,
    });

    expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
    expect(waitForTransportReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        label: "signal daemon",
        logAfterMs: 10_000,
        logIntervalMs: 10_000,
        pollIntervalMs: 150,
        runtime,
        timeoutMs: 30_000,
      }),
    );
  });

  it("uses startupTimeoutMs override when provided", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 60_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      runtime,
      startupTimeoutMs: 90_000,
    });

    expectWaitForTransportReadyTimeout(90_000);
  });

  it("caps startupTimeoutMs at 2 minutes", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 180_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      runtime,
    });

    expectWaitForTransportReadyTimeout(120_000);
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ code: 1, signal: null, source: "process" }),
        isExited: () => true,
      }),
    );
    waitForTransportReadyMock.mockImplementationOnce(
      async (params: { abortSignal?: AbortSignal | null }) => {
        await new Promise<void>((_resolve, reject) => {
          if (params.abortSignal?.aborted) {
            reject(params.abortSignal.reason);
            return;
          }
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(params.abortSignal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    );

    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
      }),
    ).rejects.toThrow(/signal daemon exited/i);
  });

  it("treats daemon exit after user abort as clean shutdown", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = new AbortController();
    let exited = false;
    let resolveExit!: (value: SignalDaemonExitEvent) => void;
    const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
      resolveExit = resolve;
    });
    const stop = vi.fn(() => {
      if (exited) {
        return;
      }
      exited = true;
      resolveExit({ code: null, signal: "SIGTERM", source: "process" });
    });
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: exitedPromise,
        isExited: () => exited,
        stop,
      }),
    );
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });

    await expect(
      runMonitorWithMocks({
        abortSignal: abortController.signal,
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
      }),
    ).resolves.toBeUndefined();
  });
});
