import { describe, expect, it } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import {
  CRITICAL_THRESHOLD,
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  TOOL_CALL_HISTORY_SIZE,
  WARNING_THRESHOLD,
  detectToolCallLoop,
  getToolCallStats,
  hashToolCall,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

function createState(): SessionState {
  return {
    lastActivity: Date.now(),
    queueDepth: 0,
    state: "processing",
  };
}

const enabledLoopDetectionConfig: ToolLoopDetectionConfig = { enabled: true };

const shortHistoryLoopConfig: ToolLoopDetectionConfig = {
  enabled: true,
  historySize: 4,
};

function recordSuccessfulCall(
  state: SessionState,
  toolName: string,
  params: unknown,
  result: unknown,
  index: number,
): void {
  const toolCallId = `${toolName}-${index}`;
  recordToolCall(state, toolName, params, toolCallId);
  recordToolCallOutcome(state, {
    result,
    toolCallId,
    toolName,
    toolParams: params,
  });
}

function recordRepeatedSuccessfulCalls(params: {
  state: SessionState;
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  startIndex?: number;
}) {
  const startIndex = params.startIndex ?? 0;
  for (let i = 0; i < params.count; i += 1) {
    recordSuccessfulCall(
      params.state,
      params.toolName,
      params.toolParams,
      params.result,
      startIndex + i,
    );
  }
}

function createNoProgressPollFixture(sessionId: string) {
  return {
    params: { action: "poll", sessionId },
    result: {
      content: [{ text: "(no new output)\n\nProcess still running.", type: "text" }],
      details: { aggregated: "steady", status: "running" },
    },
  };
}

function createReadNoProgressFixture() {
  return {
    params: { path: "/same.txt" },
    result: {
      content: [{ text: "same output", type: "text" }],
      details: { ok: true },
    },
    toolName: "read",
  } as const;
}

function createPingPongFixture() {
  return {
    listParams: { dir: "/workspace" },
    readParams: { path: "/a.txt" },
    state: createState(),
  };
}

function detectLoopAfterRepeatedCalls(params: {
  toolName: string;
  toolParams: unknown;
  result: unknown;
  count: number;
  config?: ToolLoopDetectionConfig;
}) {
  const state = createState();
  recordRepeatedSuccessfulCalls({
    count: params.count,
    result: params.result,
    state,
    toolName: params.toolName,
    toolParams: params.toolParams,
  });
  return detectToolCallLoop(
    state,
    params.toolName,
    params.toolParams,
    params.config ?? enabledLoopDetectionConfig,
  );
}

function recordSuccessfulPingPongCalls(params: {
  state: SessionState;
  readParams: { path: string };
  listParams: { dir: string };
  count: number;
  textAtIndex: (toolName: "read" | "list", index: number) => string;
}) {
  for (let i = 0; i < params.count; i += 1) {
    if (i % 2 === 0) {
      recordSuccessfulCall(
        params.state,
        "read",
        params.readParams,
        { content: [{ text: params.textAtIndex("read", i), type: "text" }], details: { ok: true } },
        i,
      );
    } else {
      recordSuccessfulCall(
        params.state,
        "list",
        params.listParams,
        { content: [{ text: params.textAtIndex("list", i), type: "text" }], details: { ok: true } },
        i,
      );
    }
  }
}

function expectPingPongLoop(
  loopResult: ReturnType<typeof detectToolCallLoop>,
  expected: { level: "warning" | "critical"; count: number; expectCriticalText?: boolean },
) {
  expect(loopResult.stuck).toBe(true);
  if (!loopResult.stuck) {
    return;
  }
  expect(loopResult.level).toBe(expected.level);
  expect(loopResult.detector).toBe("ping_pong");
  expect(loopResult.count).toBe(expected.count);
  if (expected.expectCriticalText) {
    expect(loopResult.message).toContain("CRITICAL");
  }
}

describe("tool-loop-detection", () => {
  describe("hashToolCall", () => {
    it("creates consistent hash for same tool and params", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("read", { path: "/file.txt" });
      expect(hash1).toBe(hash2);
    });

    it("creates different hashes for different params", () => {
      const hash1 = hashToolCall("read", { path: "/file1.txt" });
      const hash2 = hashToolCall("read", { path: "/file2.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("creates different hashes for different tools", () => {
      const hash1 = hashToolCall("read", { path: "/file.txt" });
      const hash2 = hashToolCall("write", { path: "/file.txt" });
      expect(hash1).not.toBe(hash2);
    });

    it("handles non-object params", () => {
      expect(() => hashToolCall("tool", "string-param")).not.toThrow();
      expect(() => hashToolCall("tool", 123)).not.toThrow();
      expect(() => hashToolCall("tool", null)).not.toThrow();
    });

    it("produces deterministic hashes regardless of key order", () => {
      const hash1 = hashToolCall("tool", { a: 1, b: 2 });
      const hash2 = hashToolCall("tool", { a: 1, b: 2 });
      expect(hash1).toBe(hash2);
    });

    it("keeps hashes fixed-size even for large params", () => {
      const payload = { data: "x".repeat(20_000) };
      const hash = hashToolCall("read", payload);
      expect(hash.startsWith("read:")).toBe(true);
      expect(hash.length).toBe("read:".length + 64);
    });
  });

  describe("recordToolCall", () => {
    it("adds tool call to empty history", () => {
      const state = createState();

      recordToolCall(state, "read", { path: "/file.txt" }, "call-1");

      expect(state.toolCallHistory).toHaveLength(1);
      expect(state.toolCallHistory?.[0]?.toolName).toBe("read");
      expect(state.toolCallHistory?.[0]?.toolCallId).toBe("call-1");
    });

    it("maintains sliding window of last N calls", () => {
      const state = createState();

      for (let i = 0; i < TOOL_CALL_HISTORY_SIZE + 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`);
      }

      expect(state.toolCallHistory).toHaveLength(TOOL_CALL_HISTORY_SIZE);

      const oldestCall = state.toolCallHistory?.[0];
      expect(oldestCall?.argsHash).toBe(hashToolCall("tool", { iteration: 10 }));
    });

    it("records timestamp for each call", () => {
      const state = createState();
      const before = Date.now();
      recordToolCall(state, "tool", { arg: 1 }, "call-ts");
      const after = Date.now();

      const timestamp = state.toolCallHistory?.[0]?.timestamp ?? 0;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("respects configured historySize", () => {
      const state = createState();

      for (let i = 0; i < 10; i += 1) {
        recordToolCall(state, "tool", { iteration: i }, `call-${i}`, shortHistoryLoopConfig);
      }

      expect(state.toolCallHistory).toHaveLength(4);
      expect(state.toolCallHistory?.[0]?.argsHash).toBe(hashToolCall("tool", { iteration: 6 }));
    });
  });

  describe("detectToolCallLoop", () => {
    it("is disabled by default", () => {
      const state = createState();

      for (let i = 0; i < 20; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `default-${i}`);
      }

      const loopResult = detectToolCallLoop(state, "read", { path: "/same.txt" });
      expect(loopResult.stuck).toBe(false);
    });

    it("does not flag unique tool calls", () => {
      const state = createState();

      for (let i = 0; i < 15; i += 1) {
        recordToolCall(state, "read", { path: `/file${i}.txt` }, `call-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/new-file.txt" },
        enabledLoopDetectionConfig,
      );
      expect(result.stuck).toBe(false);
    });

    it("warns on generic repeated tool+args calls", () => {
      const state = createState();
      for (let i = 0; i < WARNING_THRESHOLD; i += 1) {
        recordToolCall(state, "read", { path: "/same.txt" }, `warn-${i}`);
      }

      const result = detectToolCallLoop(
        state,
        "read",
        { path: "/same.txt" },
        enabledLoopDetectionConfig,
      );

      expect(result.stuck).toBe(true);
      if (result.stuck) {
        expect(result.level).toBe("warning");
        expect(result.detector).toBe("generic_repeat");
        expect(result.count).toBe(WARNING_THRESHOLD);
        expect(result.message).toContain("WARNING");
        expect(result.message).toContain(`${WARNING_THRESHOLD} times`);
      }
    });

    it("keeps generic loops warn-only below global breaker threshold", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        count: CRITICAL_THRESHOLD,
        result: fixture.result,
        toolName: fixture.toolName,
        toolParams: fixture.params,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
      }
    });

    it("applies custom thresholds when detection is enabled", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-custom");
      const config: ToolLoopDetectionConfig = {
        criticalThreshold: 4,
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: true,
          pingPong: false,
        },
        enabled: true,
        warningThreshold: 2,
      };

      recordRepeatedSuccessfulCalls({
        count: 2,
        result,
        state,
        toolName: "process",
        toolParams: params,
      });
      const warningResult = detectToolCallLoop(state, "process", params, config);
      expect(warningResult.stuck).toBe(true);
      if (warningResult.stuck) {
        expect(warningResult.level).toBe("warning");
      }

      recordRepeatedSuccessfulCalls({
        count: 2,
        result,
        startIndex: 2,
        state,
        toolName: "process",
        toolParams: params,
      });
      const criticalResult = detectToolCallLoop(state, "process", params, config);
      expect(criticalResult.stuck).toBe(true);
      if (criticalResult.stuck) {
        expect(criticalResult.level).toBe("critical");
        expect(criticalResult.detector).toBe("known_poll_no_progress");
      }
    });

    it("can disable specific detectors", () => {
      const state = createState();
      const { params, result } = createNoProgressPollFixture("sess-no-detectors");
      const config: ToolLoopDetectionConfig = {
        detectors: {
          genericRepeat: false,
          knownPollNoProgress: false,
          pingPong: false,
        },
        enabled: true,
      };

      recordRepeatedSuccessfulCalls({
        count: CRITICAL_THRESHOLD,
        result,
        state,
        toolName: "process",
        toolParams: params,
      });

      const loopResult = detectToolCallLoop(state, "process", params, config);
      expect(loopResult.stuck).toBe(false);
    });

    it("warns for known polling no-progress loops", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        count: WARNING_THRESHOLD,
        result,
        toolName: "process",
        toolParams: params,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("warning");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("no progress");
      }
    });

    it("blocks known polling no-progress loops at critical threshold", () => {
      const { params, result } = createNoProgressPollFixture("sess-1");
      const loopResult = detectLoopAfterRepeatedCalls({
        count: CRITICAL_THRESHOLD,
        result,
        toolName: "process",
        toolParams: params,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("known_poll_no_progress");
        expect(loopResult.message).toContain("CRITICAL");
      }
    });

    it("does not block known polling when output progresses", () => {
      const state = createState();
      const params = { action: "poll", sessionId: "sess-1" };

      for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
        const result = {
          content: [{ text: `line ${i}`, type: "text" }],
          details: { aggregated: `line ${i}`, status: "running" },
        };
        recordSuccessfulCall(state, "process", params, result, i);
      }

      const loopResult = detectToolCallLoop(state, "process", params, enabledLoopDetectionConfig);
      expect(loopResult.stuck).toBe(false);
    });

    it("blocks any tool with global no-progress breaker at 30", () => {
      const fixture = createReadNoProgressFixture();
      const loopResult = detectLoopAfterRepeatedCalls({
        count: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
        result: fixture.result,
        toolName: fixture.toolName,
        toolParams: fixture.params,
      });
      expect(loopResult.stuck).toBe(true);
      if (loopResult.stuck) {
        expect(loopResult.level).toBe("critical");
        expect(loopResult.detector).toBe("global_circuit_breaker");
        expect(loopResult.message).toContain("global circuit breaker");
      }
    });

    it("warns on ping-pong alternating patterns", () => {
      const state = createState();
      const readParams = { path: "/a.txt" };
      const listParams = { dir: "/workspace" };

      for (let i = 0; i < WARNING_THRESHOLD - 1; i += 1) {
        if (i % 2 === 0) {
          recordToolCall(state, "read", readParams, `read-${i}`);
        } else {
          recordToolCall(state, "list", listParams, `list-${i}`);
        }
      }

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { count: WARNING_THRESHOLD, level: "warning" });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("blocks ping-pong alternating patterns at critical threshold", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        count: CRITICAL_THRESHOLD - 1,
        listParams,
        readParams,
        state,
        textAtIndex: (toolName) => (toolName === "read" ? "read stable" : "list stable"),
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, {
        count: CRITICAL_THRESHOLD,
        expectCriticalText: true,
        level: "critical",
      });
      if (loopResult.stuck) {
        expect(loopResult.message).toContain("ping-pong loop");
      }
    });

    it("does not block ping-pong at critical threshold when outcomes are progressing", () => {
      const { state, readParams, listParams } = createPingPongFixture();

      recordSuccessfulPingPongCalls({
        count: CRITICAL_THRESHOLD - 1,
        listParams,
        readParams,
        state,
        textAtIndex: (toolName, index) => `${toolName} ${index}`,
      });

      const loopResult = detectToolCallLoop(state, "list", listParams, enabledLoopDetectionConfig);
      expectPingPongLoop(loopResult, { count: CRITICAL_THRESHOLD, level: "warning" });
    });

    it("does not flag ping-pong when alternation is broken", () => {
      const state = createState();
      recordToolCall(state, "read", { path: "/a.txt" }, "a1");
      recordToolCall(state, "list", { dir: "/workspace" }, "b1");
      recordToolCall(state, "read", { path: "/a.txt" }, "a2");
      recordToolCall(state, "write", { path: "/tmp/out.txt" }, "c1"); // Breaks alternation

      const loopResult = detectToolCallLoop(
        state,
        "list",
        { dir: "/workspace" },
        enabledLoopDetectionConfig,
      );
      expect(loopResult.stuck).toBe(false);
    });

    it("records fixed-size result hashes for large tool outputs", () => {
      const state = createState();
      const params = { action: "log", sessionId: "sess-big" };
      const toolCallId = "log-big";
      recordToolCall(state, "process", params, toolCallId);
      recordToolCallOutcome(state, {
        result: {
          content: [{ text: "y".repeat(40_000), type: "text" }],
          details: { status: "running", totalChars: 40_000, totalLines: 1 },
        },
        toolCallId,
        toolName: "process",
        toolParams: params,
      });

      const entry = state.toolCallHistory?.find((call) => call.toolCallId === toolCallId);
      expect(typeof entry?.resultHash).toBe("string");
      expect(entry?.resultHash?.length).toBe(64);
    });

    it("handles empty history", () => {
      const state = createState();

      const result = detectToolCallLoop(state, "tool", { arg: 1 }, enabledLoopDetectionConfig);
      expect(result.stuck).toBe(false);
    });
  });

  describe("getToolCallStats", () => {
    it("returns zero stats for empty history", () => {
      const state = createState();

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(0);
      expect(stats.uniquePatterns).toBe(0);
      expect(stats.mostFrequent).toBeNull();
    });

    it("counts total calls and unique patterns", () => {
      const state = createState();

      for (let i = 0; i < 5; i += 1) {
        recordToolCall(state, "read", { path: "/file.txt" }, `same-${i}`);
      }

      recordToolCall(state, "write", { path: "/output.txt" }, "write-1");
      recordToolCall(state, "list", { dir: "/home" }, "list-1");
      recordToolCall(state, "read", { path: "/other.txt" }, "read-other");

      const stats = getToolCallStats(state);
      expect(stats.totalCalls).toBe(8);
      expect(stats.uniquePatterns).toBe(4);
    });

    it("identifies most frequent pattern", () => {
      const state = createState();

      for (let i = 0; i < 3; i += 1) {
        recordToolCall(state, "read", { path: "/file1.txt" }, `p1-${i}`);
      }

      for (let i = 0; i < 7; i += 1) {
        recordToolCall(state, "read", { path: "/file2.txt" }, `p2-${i}`);
      }

      for (let i = 0; i < 2; i += 1) {
        recordToolCall(state, "write", { path: "/output.txt" }, `p3-${i}`);
      }

      const stats = getToolCallStats(state);
      expect(stats.mostFrequent?.toolName).toBe("read");
      expect(stats.mostFrequent?.count).toBe(7);
    });
  });
});
