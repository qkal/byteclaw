import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  overflowBaseRunParams as baseParams,
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedContextEngine,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("overflow compaction in run loop", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedLog.debug.mockReset();
    mockedLog.info.mockReset();
    mockedLog.warn.mockReset();
    mockedLog.error.mockReset();
    mockedLog.isEnabled.mockReset();
    mockedLog.isEnabled.mockReturnValue(false);
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
    mockedCompactDirect.mockResolvedValue({
      compacted: false,
      ok: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      reason: "no oversized tool results",
      truncated: false,
      truncatedCount: 0,
    });
  });

  it("retries after successful compaction on context overflow promptError", async () => {
    mockOverflowRetrySuccess({
      compactDirect: mockedCompactDirect,
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({ authProfileId: "test-profile" }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("auto-compaction succeeded"),
    );
    // Should not be an error result
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after successful compaction on likely-overflow promptError variants", async () => {
    const overflowHintError = new Error("Context window exceeded: requested 12000 tokens");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowHintError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        firstKeptEntryId: "entry-6",
        summary: "Compacted session",
        tokensBefore: 140_000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("source=promptError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("returns error if compaction fails", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect.mockResolvedValueOnce({
      compacted: false,
      ok: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("auto-compaction failed"));
  });

  it("falls back to tool-result truncation and retries when oversized results are detected", async () => {
    queueOverflowAttemptWithOversizedToolOutput(mockedRunEmbeddedAttempt, makeOverflowError());
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      compacted: false,
      ok: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({ contextWindowTokens: 200_000 }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Truncated 1 tool result(s)"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after fallback truncation for a mixed oversized-plus-aggregate tool tail", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          messagesSnapshot: [
            {
              content: [{ type: "text", text: "x".repeat(80_000) }],
              role: "toolResult",
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
              role: "toolResult",
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
              role: "toolResult",
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
          promptError: makeOverflowError(),
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      compacted: false,
      ok: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedSessionLikelyHasOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "toolResult" }),
          expect.objectContaining({ role: "toolResult" }),
          expect.objectContaining({ role: "toolResult" }),
        ]),
      }),
    );
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Truncated 2 tool result(s)"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries without hitting compaction when attempt-level preflight truncation already handled the overflow", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          preflightRecovery: {
            handled: true,
            route: "truncate_tool_results_only",
            truncatedCount: 2,
          },
          promptError: null,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("early recovery route=truncate_tool_results_only"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("falls back to compaction when early truncate-only recovery does not help", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          preflightRecovery: { route: "compact_only" },
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        firstKeptEntryId: "entry-7",
        summary: "Compacted after failed early truncation",
        tokensBefore: 155_000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "context overflow detected (attempt 1/3); attempting auto-compaction",
      ),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("runs post-compaction tool-result truncation before retry for mixed precheck routes", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          preflightRecovery: { route: "compact_then_truncate" },
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        firstKeptEntryId: "entry-5",
        summary: "Compacted session",
        tokensBefore: 150_000,
      }),
    );
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedTruncateOversizedToolResultsInSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: "/tmp/session.json" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.info).toHaveBeenCalledWith(
      expect.stringContaining("post-compaction tool-result truncation succeeded"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("retries compaction up to 3 times before giving up", async () => {
    const overflowError = makeOverflowError();

    // 4 overflow errors: 3 compaction retries + final failure
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          firstKeptEntryId: "entry-3",
          summary: "Compacted 1",
          tokensBefore: 180_000,
        }),
      )
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

    const result = await runEmbeddedPiAgent(baseParams);

    // Compaction attempted 3 times (max)
    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    // 4 attempts: 3 overflow+compact+retry cycles + final overflow → error
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("succeeds after second compaction attempt", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          firstKeptEntryId: "entry-3",
          summary: "Compacted 1",
          tokensBefore: 180_000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          firstKeptEntryId: "entry-5",
          summary: "Compacted 2",
          tokensBefore: 160_000,
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction for compaction_failure errors", async () => {
    const compactionFailureError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: compactionFailureError }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("compaction_failure");
  });

  it("retries after successful compaction on assistant context overflow errors", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          lastAssistant: {
            errorMessage: "request_too_large: Request size exceeds model context window",
            stopReason: "error",
          } as EmbeddedRunAttemptResult["lastAssistant"],
          promptError: null,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        firstKeptEntryId: "entry-5",
        summary: "Compacted session",
        tokensBefore: 150_000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
    expect(result.meta.error).toBeUndefined();
  });

  it("does not treat stale assistant overflow as current-attempt overflow when promptError is non-overflow", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        lastAssistant: {
          errorMessage: "request_too_large: Request size exceeds model context window",
          stopReason: "error",
        } as EmbeddedRunAttemptResult["lastAssistant"],
        promptError: new Error("transport disconnected"),
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedLog.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("source=assistantError"),
    );
  });

  it("returns an explicit timeout payload when the run times out before producing any reply", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        assistantTexts: [],
        timedOut: true,
        timedOutDuringCompaction: false,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("sets promptTokens from the latest model call usage, not accumulated attempt usage", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        attemptUsage: {
          cacheRead: 120_000,
          cacheWrite: 0,
          input: 4000,
          total: 124_000,
        },
        lastAssistant: {
          stopReason: "end_turn",
          usage: {
            cacheRead: 1100,
            cacheWrite: 0,
            input: 900,
            total: 2000,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(result.meta.agentMeta?.usage?.input).toBe(4000);
    expect(result.meta.agentMeta?.promptTokens).toBe(2000);
  });
});
