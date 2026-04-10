import { describe, expect, it } from "vitest";
import { extractCliErrorMessage, parseCliJson, parseCliJsonl } from "./cli-output.js";

describe("parseCliJson", () => {
  it("recovers mixed-output Claude session metadata from embedded JSON objects", () => {
    const result = parseCliJson(
      [
        "Claude Code starting...",
        '{"type":"init","session_id":"session-789"}',
        '{"type":"result","result":"Claude says hi","usage":{"input_tokens":9,"output_tokens":4}}',
      ].join("\n"),
      {
        command: "claude",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      sessionId: "session-789",
      text: "Claude says hi",
      usage: {
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 9,
        output: 4,
        total: undefined,
      },
    });
  });

  it("parses Gemini CLI response text and stats payloads", () => {
    const result = parseCliJson(
      JSON.stringify({
        response: "Gemini says hello",
        session_id: "gemini-session-123",
        stats: {
          cached: 8,
          input: 5,
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 21,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      sessionId: "gemini-session-123",
      text: "Gemini says hello",
      usage: {
        cacheRead: 8,
        cacheWrite: undefined,
        input: 5,
        output: 5,
        total: 21,
      },
    });
  });

  it("falls back to input_tokens minus cached when Gemini stats omit input", () => {
    const result = parseCliJson(
      JSON.stringify({
        response: "Hello",
        session_id: "gemini-session-456",
        stats: {
          cached: 8,
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 21,
        },
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result?.usage?.input).toBe(5);
    expect(result?.usage?.cacheRead).toBe(8);
  });

  it("falls back to Gemini stats when usage exists without token fields", () => {
    const result = parseCliJson(
      JSON.stringify({
        response: "Gemini says hello",
        session_id: "gemini-session-789",
        stats: {
          cached: 8,
          input: 5,
          input_tokens: 13,
          output_tokens: 5,
          total_tokens: 21,
        },
        usage: {},
      }),
      {
        command: "gemini",
        output: "json",
        sessionIdFields: ["session_id"],
      },
    );

    expect(result).toEqual({
      sessionId: "gemini-session-789",
      text: "Gemini says hello",
      usage: {
        cacheRead: 8,
        cacheWrite: undefined,
        input: 5,
        output: 5,
        total: 21,
      },
    });
  });
});

describe("parseCliJsonl", () => {
  it("parses Claude stream-json result events", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ session_id: "session-123", type: "init" }),
        JSON.stringify({
          result: "Claude says hello",
          session_id: "session-123",
          type: "result",
          usage: {
            cache_read_input_tokens: 4,
            input_tokens: 12,
            output_tokens: 3,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      sessionId: "session-123",
      text: "Claude says hello",
      usage: {
        cacheRead: 4,
        cacheWrite: undefined,
        input: 12,
        output: 3,
        total: undefined,
      },
    });
  });

  it("preserves Claude cache creation tokens instead of flattening them to zero", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ session_id: "session-cache-123", type: "init" }),
        JSON.stringify({
          result: "Claude says hello",
          session_id: "session-cache-123",
          type: "result",
          usage: {
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 4,
            input_tokens: 12,
            output_tokens: 3,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      sessionId: "session-cache-123",
      text: "Claude says hello",
      usage: {
        cacheRead: 4,
        cacheWrite: 7,
        input: 12,
        output: 3,
        total: undefined,
      },
    });
  });

  it("preserves Claude session metadata even when the final result text is empty", () => {
    const result = parseCliJsonl(
      [
        JSON.stringify({ session_id: "session-456", type: "init" }),
        JSON.stringify({
          result: "   ",
          session_id: "session-456",
          type: "result",
          usage: {
            input_tokens: 18,
            output_tokens: 0,
          },
        }),
      ].join("\n"),
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      sessionId: "session-456",
      text: "",
      usage: {
        cacheRead: undefined,
        cacheWrite: undefined,
        input: 18,
        output: undefined,
        total: undefined,
      },
    });
  });

  it("parses multiple JSON objects embedded on the same line", () => {
    const result = parseCliJsonl(
      '{"type":"init","session_id":"session-999"} {"type":"result","session_id":"session-999","result":"done"}',
      {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      "claude-cli",
    );

    expect(result).toEqual({
      sessionId: "session-999",
      text: "done",
      usage: undefined,
    });
  });

  it("extracts nested Claude API errors from failed stream-json output", () => {
    const message =
      "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.";
    const apiError = `API Error: 400 ${JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
      },
      request_id: "req_011CZqHuXhFetYCnr8325DQc",
      type: "error",
    })}`;
    const result = extractCliErrorMessage(
      [
        JSON.stringify({ session_id: "session-api-error", subtype: "init", type: "system" }),
        JSON.stringify({
          error: "unknown",
          message: {
            content: [{ text: apiError, type: "text" }],
            model: "<synthetic>",
            role: "assistant",
          },
          session_id: "session-api-error",
          type: "assistant",
        }),
        JSON.stringify({
          is_error: true,
          result: apiError,
          session_id: "session-api-error",
          subtype: "success",
          type: "result",
        }),
      ].join("\n"),
    );

    expect(result).toBe(message);
  });
});
