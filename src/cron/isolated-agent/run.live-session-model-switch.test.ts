import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthProfileOverrideMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "cron-model-switch-job",
    name: "Model Switch Test",
    payload: {
      kind: "agentTurn",
      message: "run task",
      // Cron requests sonnet; agent primary is opus
      model: "anthropic/claude-sonnet-4-6",
    },
    schedule: { expr: "0 * * * *", kind: "cron", tz: "UTC" },
    sessionTarget: "isolated",
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run task",
    sessionKey: "cron:model-switch",
    ...overrides,
  };
}

function makeSuccessfulRunResult(modelUsed = "claude-sonnet-4-6") {
  return {
    attempts: [],
    model: modelUsed,
    provider: "anthropic",
    result: {
      meta: {
        agentMeta: {
          model: modelUsed,
          provider: "anthropic",
          usage: { input: 100, output: 50 },
        },
      },
      payloads: [{ text: "task complete" }],
    },
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — LiveSessionModelSwitchError retry (#57206)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(async () => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      const [provider, model] = raw.split("/");
      return { ref: { model, provider } };
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
      }),
    );
    updateSessionStoreMock.mockResolvedValue(undefined);
    logWarnMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (previousFastTestEnv !== undefined) {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    } else {
      delete process.env.OPENCLAW_TEST_FAST;
    }
  });

  it("retries with the requested model when runWithModelFallback throws LiveSessionModelSwitchError on the first attempt", async () => {
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(
      async (params: {
        provider: string;
        model: string;
        run: (p: string, m: string) => Promise<unknown>;
      }) => {
        callCount++;
        if (callCount === 1) {
          // First attempt: session started with opus, throw to request sonnet
          throw switchError;
        }
        // Second attempt: should now be called with sonnet
        expect(params.provider).toBe("anthropic");
        expect(params.model).toBe("claude-sonnet-4-6");
        return makeSuccessfulRunResult("claude-sonnet-4-6");
      },
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("persists switched provider/model before retrying", async () => {
    const cronSession = makeCronSession({
      isNewSession: true,
      sessionEntry: makeCronSessionEntry({
        model: undefined,
        modelProvider: undefined,
      }),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    runWithModelFallbackMock.mockImplementation(async () => {
      throw switchError;
    });
    runWithModelFallbackMock
      .mockRejectedValueOnce(switchError)
      .mockRejectedValueOnce(new Error("transient network error"));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("transient network error");
    expect(updateSessionStoreMock).toHaveBeenCalled();
    expect(cronSession.sessionEntry).toMatchObject({
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
    });
  });

  it("retries with switched auth profile state from LiveSessionModelSwitchError", async () => {
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("profile-a");
    const cronSession = makeCronSession({
      isNewSession: true,
      sessionEntry: makeCronSessionEntry({
        authProfileOverride: "profile-a",
        authProfileOverrideSource: "auto",
        compactionCount: 7,
        model: undefined,
        modelProvider: undefined,
      }),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      attempts: [],
      model,
      provider,
      result: await run(provider, model),
    }));
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new LiveSessionModelSwitchError({
          authProfileId: "profile-b",
          authProfileIdSource: "user",
          model: "claude-sonnet-4-6",
          provider: "anthropic",
        }),
      )
      .mockResolvedValueOnce({
        meta: {
          agentMeta: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            usage: { input: 100, output: 50 },
          },
        },
        payloads: [{ text: "task complete" }],
      });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedPiAgentMock.mock.calls[1]?.[0]).toMatchObject({
      authProfileId: "profile-b",
      authProfileIdSource: "user",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    expect(cronSession.sessionEntry).toMatchObject({
      authProfileOverride: "profile-b",
      authProfileOverrideSource: "user",
    });
  });

  it("returns error (not infinite loop) when LiveSessionModelSwitchError is thrown repeatedly", async () => {
    // If the runner somehow keeps throwing the same error (e.g. broken catalog)
    // It should not loop forever. The inner runPrompt itself will eventually
    // Surface an error from within the model fallback path, but we simulate
    // A different error on the second attempt to ensure the outer catch still works.
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        throw switchError;
      }
      // Second attempt throws a different error — should propagate up
      throw new Error("transient network error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("transient network error");
    // Switched once, then failed
    expect(callCount).toBe(2);
  });

  it("aborts after exceeding LiveSessionModelSwitchError retry limit (#58466)", async () => {
    const switchError = new LiveSessionModelSwitchError({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw switchError;
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    // Circuit breaker: max 2 retries → 3 total attempts (initial + 2 retries)
    expect(callCount).toBe(3);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("retry limit reached"));
  });

  it("does not retry when the thrown error is not a LiveSessionModelSwitchError", async () => {
    let callCount = 0;
    runWithModelFallbackMock.mockImplementation(async () => {
      callCount++;
      throw new Error("some other error");
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(callCount).toBe(1);
  });
});
