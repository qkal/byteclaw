import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCoerceToFailoverError,
  mockedCompactDirect,
  mockedContextEngine,
  mockedDescribeFailoverError,
  mockedEvaluateContextWindowGuard,
  mockedGlobalHookRunner,
  mockedPickFallbackThinkingLevel,
  mockedResolveContextWindowInfo,
  mockedResolveFailoverStatus,
  mockedRunContextEngineMaintenance,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("passes precomputed legacy before_agent_start result into the attempt", async () => {
    const legacyResult = {
      modelOverride: "legacy-model",
      prependContext: "legacy context",
    };
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_agent_start",
    );
    mockedGlobalHookRunner.runBeforeAgentStart.mockResolvedValueOnce(legacyResult);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      prompt: "hello",
      runId: "run-legacy-pass-through",
      sessionFile: "/tmp/session.json",
      sessionId: "test-session",
      sessionKey: "test-key",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/workspace",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyBeforeAgentStartResult: legacyResult,
      }),
    );
  });

  it("passes resolved auth profile into run attempts for context-engine afterTurn propagation", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-auth-profile-passthrough",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "test-profile",
        authProfileIdSource: "auto",
      }),
    );
  });

  it("blocks undersized models before dispatching a provider attempt", async () => {
    mockedResolveContextWindowInfo.mockReturnValue({
      source: "model",
      tokens: 800,
    });
    mockedEvaluateContextWindowGuard.mockReturnValue({
      shouldBlock: true,
      shouldWarn: true,
      source: "model",
      tokens: 800,
    });

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-small-context",
      }),
    ).rejects.toThrow("Model context window too small (800 tokens). Minimum is 1000.");

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    mockOverflowRetrySuccess({
      compactDirect: mockedCompactDirect,
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          authProfileId: "test-profile",
          trigger: "overflow",
        }),
        sessionFile: "/tmp/session.json",
        sessionId: "test-session",
      }),
    );
  });

  it("threads prompt-cache runtime context into overflow compaction", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptCache: {
            lastCacheTouchAt: 1_700_000_000_000,
            lastCallUsage: {
              cacheRead: 32_000,
              input: 150_000,
              total: 182_000,
            },
            observation: {
              broke: false,
              cacheRead: 32_000,
            },
            retention: "short",
          },
          promptError: makeOverflowError(),
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        tokensAfter: 80_000,
        tokensBefore: 150_000,
      }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          promptCache: expect.objectContaining({
            lastCacheTouchAt: 1_700_000_000_000,
            lastCallUsage: expect.objectContaining({
              input: 150000,
              cacheRead: 32000,
            }),
            observation: expect.objectContaining({
              broke: false,
              cacheRead: 32000,
            }),
            retention: "short",
          }),
          trigger: "overflow",
        }),
      }),
    );
  });

  it("passes observed overflow token counts into compaction when providers report them", async () => {
    const overflowError = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 277403 tokens > 200000 maximum"}}',
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        firstKeptEntryId: "entry-8",
        summary: "Compacted session",
        tokensBefore: 277_403,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTokenCount: 277_403,
      }),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("does not reset compaction attempt budget after successful tool-result truncation", async () => {
    const overflowError = queueOverflowAttemptWithOversizedToolOutput(
      mockedRunEmbeddedAttempt,
      makeOverflowError(),
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce({
        compacted: false,
        ok: false,
        reason: "nothing to compact",
      })
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          firstKeptEntryId: "entry-5",
          summary: "Compacted 2",
          tokensBefore: 160_000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          firstKeptEntryId: "entry-7",
          summary: "Compacted 3",
          tokensBefore: 140_000,
        }),
      );

    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
  });

  it("fires compaction hooks during overflow recovery for ownsCompaction engines", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      compacted: true,
      ok: true,
      result: {
        summary: "engine-owned compaction",
        tokensAfter: 50,
      },
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: "/tmp/session.json" },
      expect.objectContaining({
        sessionKey: "test-key",
      }),
    );
    expect(mockedGlobalHookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        compactedCount: -1,
        messageCount: -1,
        sessionFile: "/tmp/session.json",
        tokenCount: 50,
      },
      expect.objectContaining({
        sessionKey: "test-key",
      }),
    );
  });

  it("runs maintenance after successful overflow-recovery compaction", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: makeOverflowError() }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      compacted: true,
      ok: true,
      result: {
        summary: "engine-owned compaction",
        tokensAfter: 50,
      },
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedRunContextEngineMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        contextEngine: mockedContextEngine,
        reason: "compaction",
        runtimeContext: expect.objectContaining({
          authProfileId: "test-profile",
          trigger: "overflow",
        }),
        sessionFile: "/tmp/session.json",
        sessionId: "test-session",
        sessionKey: "test-key",
      }),
    );
  });

  it("guards thrown engine-owned overflow compaction attempts", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: makeOverflowError() }),
    );
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine boom"));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("returns retry_limit when repeated retries never converge", async () => {
    mockedRunEmbeddedAttempt.mockClear();
    mockedCompactDirect.mockClear();
    mockedPickFallbackThinkingLevel.mockReset();
    mockedPickFallbackThinkingLevel.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("unsupported reasoning mode"),
      }),
    );
    mockedPickFallbackThinkingLevel.mockReturnValue("low");

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(32);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.meta.error?.kind).toBe("retry_limit");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("normalizes abort-wrapped prompt errors before handing off to model fallback", async () => {
    const promptError = Object.assign(new Error("request aborted"), {
      cause: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      },
      name: "AbortError",
    });
    const normalized = Object.assign(new Error("Resource has been exhausted (e.g. check quota)."), {
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    });

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError }));
    mockedCoerceToFailoverError.mockReturnValue(normalized);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      code: undefined,
      message: err instanceof Error ? err.message : String(err),
      reason: err === normalized ? "rate_limit" : undefined,
      status: err === normalized ? 429 : undefined,
    }));
    mockedResolveFailoverStatus.mockReturnValue(429);

    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        config: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.2"],
              },
            },
          },
        },
      }),
    ).rejects.toBe(normalized);

    expect(mockedCoerceToFailoverError).toHaveBeenCalledWith(
      promptError,
      expect.objectContaining({
        model: "test-model",
        profileId: "test-profile",
        provider: "anthropic",
      }),
    );
    expect(mockedResolveFailoverStatus).toHaveBeenCalledWith("rate_limit");
  });
});
