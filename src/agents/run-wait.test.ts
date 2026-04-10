import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import {
  __testing,
  readLatestAssistantReply,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
  waitForAgentRunsToDrain,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";

describe("readLatestAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("returns the most recent assistant message when compaction markers trail history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          content: [{ text: "All checks passed and changes were pushed.", type: "text" }],
          role: "assistant",
        },
        { content: [{ text: "tool output", type: "text" }], role: "toolResult" },
        { content: [{ text: "Compaction", type: "text" }], role: "system" },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("All checks passed and changes were pushed.");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { limit: 50, sessionKey: "agent:main:child" },
    });
  });

  it("falls back to older assistant text when latest assistant has no text", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        { content: [{ text: "older output", type: "text" }], role: "assistant" },
        { content: [], role: "assistant" },
        { content: [{ text: "Compaction", type: "text" }], role: "system" },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("older output");
  });

  it("returns assistant fingerprints for delta comparisons", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          content: [{ text: "new output", type: "text" }],
          role: "assistant",
          timestamp: 42,
        },
      ],
    });

    const result = await readLatestAssistantReplySnapshot({ sessionKey: "agent:main:child" });

    expect(result.text).toBe("new output");
    expect(result.fingerprint).toContain('"timestamp":42');
  });

  it("reads only final_answer text from phased assistant history", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          content: [
            {
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
              type: "text",
            },
            {
              text: "Fixed the quoting issue.",
              textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
              type: "text",
            },
          ],
          role: "assistant",
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Fixed the quoting issue.");
  });

  it("preserves spaces across split final_answer history blocks", async () => {
    callGatewayMock.mockResolvedValue({
      messages: [
        {
          content: [
            {
              text: "Need fix line quoting properly.",
              textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
              type: "text",
            },
            {
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "final_1", phase: "final_answer" }),
              type: "text",
            },
            {
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "final_2", phase: "final_answer" }),
              type: "text",
            },
          ],
          role: "assistant",
        },
      ],
    });

    const result = await readLatestAssistantReply({ sessionKey: "agent:main:child" });

    expect(result).toBe("Hi there");
  });
});

describe("waitForAgentRun", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("maps gateway timeouts to timeout status", async () => {
    callGatewayMock.mockRejectedValue(new Error("gateway timeout while waiting"));

    const result = await waitForAgentRun({ runId: "run-1", timeoutMs: 500 });

    expect(result).toEqual({
      error: "gateway timeout while waiting",
      status: "timeout",
    });
  });

  it("preserves timing metadata from agent.wait", async () => {
    callGatewayMock.mockResolvedValue({
      endedAt: 200,
      startedAt: 100,
      status: "ok",
    });

    const result = await waitForAgentRun({ runId: "run-2", timeoutMs: 500 });

    expect(result).toEqual({
      endedAt: 200,
      startedAt: 100,
      status: "ok",
    });
  });
});

describe("waitForAgentRunAndReadUpdatedAssistantReply", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("returns undefined when the latest assistant fingerprint matches the baseline", async () => {
    const assistantMessage = {
      content: [{ text: "same reply", type: "text" }],
      role: "assistant",
      timestamp: 42,
    };
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [assistantMessage],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      baseline: {
        fingerprint: JSON.stringify(assistantMessage),
        text: "same reply",
      },
      runId: "run-1",
      sessionKey: "agent:main:child",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      replyText: undefined,
      status: "ok",
    });
  });

  it("returns the new assistant text when the fingerprint changes", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        status: "ok",
      })
      .mockResolvedValueOnce({
        messages: [
          {
            content: [{ text: "fresh reply", type: "text" }],
            role: "assistant",
            timestamp: 99,
          },
        ],
      });

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      baseline: {
        fingerprint: "old-fingerprint",
        text: "older reply",
      },
      runId: "run-2",
      sessionKey: "agent:main:child",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      replyText: "fresh reply",
      status: "ok",
    });
  });
});

describe("waitForAgentRunsToDrain", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    __testing.setDepsForTest({
      callGateway: async (opts) => await callGatewayMock(opts),
    });
  });

  it("waits across rounds until descendant runs stop changing", async () => {
    let activeRunIds = ["run-1"];
    callGatewayMock.mockImplementation(async (opts) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method !== "agent.wait") {
        throw new Error(`unexpected method: ${String(request.method)}`);
      }
      if (request.params?.runId === "run-1") {
        activeRunIds = ["run-2"];
      } else if (request.params?.runId === "run-2") {
        activeRunIds = [];
      }
      return { status: "ok" };
    });

    const result = await waitForAgentRunsToDrain({
      getPendingRunIds: () => activeRunIds,
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      deadlineAtMs: expect.any(Number),
      pendingRunIds: [],
      timedOut: false,
    });
    expect(callGatewayMock.mock.calls.map((call) => call[0])).toEqual([
      {
        method: "agent.wait",
        params: {
          runId: "run-1",
          timeoutMs: expect.any(Number),
        },
        timeoutMs: expect.any(Number),
      },
      {
        method: "agent.wait",
        params: {
          runId: "run-2",
          timeoutMs: expect.any(Number),
        },
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  it("deduplicates and trims pending run ids", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = [" run-1 ", "run-1", "", "run-2"];

    const result = await waitForAgentRunsToDrain({
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
      timeoutMs: 1000,
    });

    expect(result.timedOut).toBe(false);
    expect(callGatewayMock.mock.calls).toHaveLength(2);
  });

  it("keeps the initial pending run ids before refreshing", async () => {
    callGatewayMock.mockResolvedValue({ status: "ok" });
    let activeRunIds = ["run-2"];

    const result = await waitForAgentRunsToDrain({
      getPendingRunIds: () => {
        const current = activeRunIds;
        activeRunIds = [];
        return current;
      },
      initialPendingRunIds: ["run-1"],
      timeoutMs: 1000,
    });

    expect(result.timedOut).toBe(false);
    expect(callGatewayMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-1" }),
      }),
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-2" }),
      }),
    ]);
  });
});
