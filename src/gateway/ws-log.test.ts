import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test.each([
    {
      expected: "12345678…9abc",
      input: "12345678-1234-1234-1234-123456789abc",
      name: "compacts uuids",
    },
    {
      expected: "aaaaaaaaaaaa…aaaa",
      input: "a".repeat(30),
      name: "compacts long strings",
    },
    {
      expected: "short",
      input: " short ",
      name: "trims before checking length",
    },
  ])("shortId $name", ({ input, expected }) => {
    expect(shortId(input)).toBe(expected);
  });

  test.each([
    {
      expected: "TestError: boom",
      input: Object.assign(new Error("boom"), { name: "TestError" }),
      name: "formats Error instances",
    },
    {
      expected: "Oops: failed: code=E1",
      input: { code: "E1", message: "failed", name: "Oops" },
      name: "formats message-like objects with codes",
    },
  ])("formatForLog $name", ({ input, expected }) => {
    expect(formatForLog(input)).toBe(expected);
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test("summarizeAgentEventForWsLog compacts assistant payloads", () => {
    const summary = summarizeAgentEventForWsLog({
      data: {
        mediaUrls: ["a", "b"],
        text: "hello\n\nworld ".repeat(20),
      },
      runId: "12345678-1234-1234-1234-123456789abc",
      seq: 2,
      sessionKey: "agent:main:main",
      stream: "assistant",
    });

    expect(summary).toMatchObject({
      agent: "main",
      aseq: 2,
      media: 2,
      run: "12345678…9abc",
      session: "main",
      stream: "assistant",
    });
    expect(summary.text).toBeTypeOf("string");
    expect(summary.text).not.toContain("\n");
  });

  test("summarizeAgentEventForWsLog includes tool metadata", () => {
    expect(
      summarizeAgentEventForWsLog({
        data: { name: "fetch", phase: "start", toolCallId: "12345678-1234-1234-1234-123456789abc" },
        runId: "run-1",
        stream: "tool",
      }),
    ).toMatchObject({
      call: "12345678…9abc",
      run: "run-1",
      stream: "tool",
      tool: "start:fetch",
    });
  });

  test("summarizeAgentEventForWsLog includes lifecycle errors with compact previews", () => {
    const summary = summarizeAgentEventForWsLog({
      data: {
        aborted: true,
        error: "fatal ".repeat(40),
        phase: "abort",
      },
      runId: "run-2",
      sessionKey: "agent:main:thread-1",
      stream: "lifecycle",
    });

    expect(summary).toMatchObject({
      aborted: true,
      agent: "main",
      phase: "abort",
      session: "thread-1",
      stream: "lifecycle",
    });
    expect(summary.error).toBeTypeOf("string");
    expect((summary.error as string).length).toBeLessThanOrEqual(120);
  });

  test("summarizeAgentEventForWsLog preserves invalid session keys and unknown-stream reasons", () => {
    expect(
      summarizeAgentEventForWsLog({
        data: { reason: "dropped" },
        sessionKey: "bogus-session",
        stream: "other",
      }),
    ).toEqual({
      reason: "dropped",
      session: "bogus-session",
      stream: "other",
    });
  });
});
