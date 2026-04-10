import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorZaloProvider: vi.fn(),
  probeZalo: vi.fn(async () => ({
    elapsedMs: 1,
    error: "probe failed",
    ok: false as const,
  })),
}));

vi.mock("./monitor.js", () => ({
    monitorZaloProvider: hoisted.monitorZaloProvider,
  }));

vi.mock("./probe.js", () => ({
    probeZalo: hoisted.probeZalo,
  }));

vi.mock("./channel.runtime.js", () => ({
  probeZaloAccount: hoisted.probeZalo,
  startZaloGatewayAccount: async (ctx: {
    account: ResolvedZaloAccount;
    abortSignal: AbortSignal;
    setStatus: (patch: Partial<ResolvedZaloAccount>) => void;
  }) => {
    await hoisted.probeZalo();
    ctx.setStatus({ accountId: ctx.account.accountId });
    return await hoisted.monitorZaloProvider({
      abortSignal: ctx.abortSignal,
      account: ctx.account,
      token: ctx.account.token,
      useWebhook: false,
    });
  },
}));

import { zaloPlugin } from "./channel.js";

function buildAccount(): ResolvedZaloAccount {
  return {
    accountId: "default",
    config: {},
    enabled: true,
    token: "test-token",
    tokenSource: "config",
  };
}

describe("zaloPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort", async () => {
    hoisted.monitorZaloProvider.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      account: buildAccount(),
      startAccount: zaloPlugin.gateway!.startAccount!,
    });

    await expectPendingUntilAbort({
      abort,
      isSettled,
      task,
      waitForStarted: waitForStartedMocks(hoisted.probeZalo, hoisted.monitorZaloProvider),
    });

    expectLifecyclePatch(patches, { accountId: "default" });
    expect(isSettled()).toBe(true);
    expect(hoisted.monitorZaloProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abort.signal,
        account: expect.objectContaining({ accountId: "default" }),
        token: "test-token",
        useWebhook: false,
      }),
    );
  });
});
