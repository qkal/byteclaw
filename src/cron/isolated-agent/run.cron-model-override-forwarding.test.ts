import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resetRunCronIsolatedAgentTurnHarness,
  resolveAgentConfigMock,
  resolveAgentModelFallbacksOverrideMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "model-fwd-job",
    name: "Model Forward Test",
    payload: {
      kind: "agentTurn",
      message: "summarize",
      model: "google/gemini-2.0-flash",
    },
    schedule: { expr: "0 9 * * *", kind: "cron", tz: "UTC" },
    sessionTarget: "isolated",
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "summarize",
    sessionKey: "cron:model-fwd",
    ...overrides,
  };
}

function makeSuccessfulRunResult(provider = "google", model = "gemini-2.0-flash") {
  return {
    attempts: [],
    model,
    provider,
    result: {
      meta: {
        agentMeta: {
          model,
          provider,
          usage: { input: 100, output: 50 },
        },
      },
      payloads: [{ text: "summary done" }],
    },
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — cron model override forwarding (#58065)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    // Agent default model is Opus (anthropic)
    resolveConfiguredModelRefMock.mockReturnValue({
      model: "claude-opus-4-6",
      provider: "anthropic",
    });

    // Cron payload model override resolves to gemini
    resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
      if (raw.includes("gemini")) {
        return { ref: { model: "gemini-2.0-flash", provider: "google" } };
      }
      return { ref: { model: "claude-opus-4-6", provider: "anthropic" } };
    });

    resolveAgentConfigMock.mockReturnValue(undefined);
    updateSessionStoreMock.mockResolvedValue(undefined);

    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        isNewSession: true,
        sessionEntry: makeCronSessionEntry({
          model: undefined,
          modelProvider: undefined,
        }),
      }),
    );
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes the cron payload model override to runWithModelFallback", async () => {
    // Track the provider/model passed to runWithModelFallback
    let capturedProvider: string | undefined;
    let capturedModel: string | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string }) => {
        capturedProvider = params.provider;
        capturedModel = params.model;
        return makeSuccessfulRunResult();
      },
    );

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    // The cron payload specifies google/gemini-2.0-flash — that must be
    // What reaches runWithModelFallback, not the agent default (opus).
    expect(capturedProvider).toBe("google");
    expect(capturedModel).toBe("gemini-2.0-flash");
  });

  it("passes the cron payload model to the embedded agent runner", async () => {
    // Use passthrough so runEmbeddedPiAgentMock actually gets called
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { attempts: [], model, provider, result };
    });
    runEmbeddedPiAgentMock.mockResolvedValue({
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      payloads: [{ text: "summary done" }],
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    const embeddedCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(embeddedCall?.provider).toBe("google");
    expect(embeddedCall?.model).toBe("gemini-2.0-flash");
  });

  it("does not add agent primary model as fallback when cron payload model is set", async () => {
    // No per-agent fallbacks configured — resolveAgentModelFallbacksOverride
    // Returns undefined in that case. Before the fix, this caused
    // RunWithModelFallback to receive fallbacksOverride=undefined, which
    // Made it append the agent primary model as a last-resort candidate.
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(makeParams());

    // With the fix, the shared override helper resolves an explicit empty
    // List here: no configured fallback chain, and no silent agent-primary
    // Append on retry.
    expect(capturedFallbacksOverride).toEqual([]);
  });

  it("preserves default fallback chain for cron payload model overrides", async () => {
    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
                model: "claude-opus-4-6",
                provider: "anthropic",
              },
            },
          },
        },
      }),
    );

    expect(capturedFallbacksOverride).toEqual(["openai/gpt-5.4", "google/gemini-2.5-pro"]);
  });

  it("preserves agent fallbacks when no cron payload model is set", async () => {
    // Job without model override
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "summarize" },
    });

    resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult("anthropic", "claude-opus-4-6");
      },
    );

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    // Without a payload model override, fallbacksOverride should remain
    // Undefined so the agent primary model IS available as a last-resort
    // Fallback (existing behavior preserved).
    expect(capturedFallbacksOverride).toBeUndefined();
  });

  it("uses explicit payload fallbacks when both model and fallbacks are set", async () => {
    const jobWithFallbacks = makeJob({
      payload: {
        fallbacks: ["openai/gpt-4o"],
        kind: "agentTurn",
        message: "summarize",
        model: "google/gemini-2.0-flash",
      },
    });

    let capturedFallbacksOverride: string[] | undefined;
    runWithModelFallbackMock.mockImplementation(
      async (params: { provider: string; model: string; fallbacksOverride?: string[] }) => {
        capturedFallbacksOverride = params.fallbacksOverride;
        return makeSuccessfulRunResult();
      },
    );

    await runCronIsolatedAgentTurn(makeParams({ job: jobWithFallbacks }));

    expect(capturedFallbacksOverride).toEqual(["openai/gpt-4o"]);
  });
});
