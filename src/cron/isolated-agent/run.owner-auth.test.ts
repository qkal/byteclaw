import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_OWNER_AUTH_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      delivery: { mode: "none" },
      id: "owner-auth",
      name: "Owner Auth",
      payload: { kind: "agentTurn", message: "check owner tools" },
      schedule: { everyMs: 60_000, kind: "every" },
      sessionTarget: "isolated",
    } as never,
    message: "check owner tools",
    sessionKey: "cron:owner-auth",
  };
}

describe("runCronIsolatedAgentTurn owner auth", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      accountId: undefined,
      channel: "telegram",
      error: undefined,
      to: "123",
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { attempts: [], model, provider, result };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "passes senderIsOwner=true to isolated cron agent runs",
    { timeout: RUN_OWNER_AUTH_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParams());

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const senderIsOwner = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.senderIsOwner;
      expect(senderIsOwner).toBe(true);
    },
  );
});
