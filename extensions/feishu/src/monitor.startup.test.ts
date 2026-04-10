import { afterEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig } from "../runtime-api.js";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", async () => {
  const { createFeishuClientMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuClientMockModule();
});
vi.mock("./runtime.js", async () => {
  const { createFeishuRuntimeMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuRuntimeMockModule();
});

function buildMultiAccountWebsocketConfig(accountIds: string[]): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        accounts: Object.fromEntries(
          accountIds.map((accountId) => [
            accountId,
            {
              enabled: true,
              appId: `cli_${accountId}`,
              appSecret: `secret_${accountId}`, // Pragma: allowlist secret
              connectionMode: "websocket",
            },
          ]),
        ),
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

async function waitForStartedAccount(started: string[], accountId: string) {
  for (let i = 0; i < 10 && !started.includes(accountId); i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  stopFeishuMonitor();
});

describe("Feishu monitor startup preflight", () => {
  it("starts account probes sequentially to avoid startup bursts", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    let releaseProbes!: () => void;
    const probesReleased = new Promise<void>((resolve) => {
      releaseProbes = () => resolve();
    });
    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      started.push(account.accountId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await probesReleased;
      inFlight -= 1;
      return { botOpenId: `bot_${account.accountId}`, ok: true };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      abortSignal: abortController.signal,
      config: buildMultiAccountWebsocketConfig(["alpha", "beta", "gamma"]),
    });

    try {
      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual(["alpha"]);
      expect(maxInFlight).toBe(1);
    } finally {
      releaseProbes();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not refetch bot info after a failed sequential preflight", async () => {
    const started: string[] = [];
    let releaseBetaProbe!: () => void;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });

    probeFeishuMock.mockImplementation(async (account: { accountId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return { ok: false };
      }
      await betaProbeReleased;
      return { botOpenId: `bot_${account.accountId}`, ok: true };
    });

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      abortSignal: abortController.signal,
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
    });

    try {
      await waitForStartedAccount(started, "beta");
      expect(started).toEqual(["alpha", "beta"]);
      expect(started.filter((accountId) => accountId === "alpha")).toHaveLength(1);
    } finally {
      releaseBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("continues startup when probe layer reports timeout", async () => {
    const started: string[] = [];
    let releaseBetaProbe!: () => void;
    const betaProbeReleased = new Promise<void>((resolve) => {
      releaseBetaProbe = () => resolve();
    });

    probeFeishuMock.mockImplementation((account: { accountId: string }) => {
      started.push(account.accountId);
      if (account.accountId === "alpha") {
        return Promise.resolve({ error: "probe timed out after 10000ms", ok: false });
      }
      return betaProbeReleased.then(() => ({ botOpenId: `bot_${account.accountId}`, ok: true }));
    });

    const abortController = new AbortController();
    const runtime = createNonExitingRuntimeEnv();
    const monitorPromise = monitorFeishuProvider({
      abortSignal: abortController.signal,
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
      runtime,
    });

    try {
      await waitForStartedAccount(started, "beta");
      expect(started).toEqual(["alpha", "beta"]);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("bot info probe timed out"),
      );
    } finally {
      releaseBetaProbe();
      abortController.abort();
      await monitorPromise;
    }
  });

  it("stops sequential preflight when aborted during probe", async () => {
    const started: string[] = [];
    probeFeishuMock.mockImplementation(
      (account: { accountId: string }, options: { abortSignal?: AbortSignal }) => {
        started.push(account.accountId);
        return new Promise((resolve) => {
          options.abortSignal?.addEventListener(
            "abort",
            () => resolve({ error: "probe aborted", ok: false }),
            { once: true },
          );
        });
      },
    );

    const abortController = new AbortController();
    const monitorPromise = monitorFeishuProvider({
      abortSignal: abortController.signal,
      config: buildMultiAccountWebsocketConfig(["alpha", "beta"]),
    });

    try {
      await Promise.resolve();
      expect(started).toEqual(["alpha"]);

      abortController.abort();
      await monitorPromise;

      expect(started).toEqual(["alpha"]);
    } finally {
      abortController.abort();
    }
  });
});
