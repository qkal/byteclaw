import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  monitorNextcloudTalkProvider: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorNextcloudTalkProvider: hoisted.monitorNextcloudTalkProvider,
  };
});

const { nextcloudTalkGatewayAdapter } = await import("./gateway.js");

function buildAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://nextcloud.example.com",
    secret: "secret", // Pragma: allowlist secret
    secretSource: "config", // Pragma: allowlist secret
    config: {
      baseUrl: "https://nextcloud.example.com",
      botSecret: "secret", // Pragma: allowlist secret
      webhookPath: "/nextcloud-talk-webhook",
      webhookPort: 8788,
    },
  };
}

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorNextcloudTalkProvider.mockResolvedValue({ stop });
  return stop;
}

function startNextcloudAccount(abortSignal?: AbortSignal) {
  return nextcloudTalkGatewayAdapter.startAccount!(
    createStartAccountContext({
      abortSignal,
      account: buildAccount(),
    }),
  );
}

describe("nextcloud-talk startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      account: buildAccount(),
      startAccount: nextcloudTalkGatewayAdapter.startAccount!,
    });
    await expectStopPendingUntilAbort({
      abort,
      isSettled,
      stop,
      task,
      waitForStarted: waitForStartedMocks(hoisted.monitorNextcloudTalkProvider),
    });
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startNextcloudAccount(abort.signal);

    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
