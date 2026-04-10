import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { formatBillingErrorMessage } from "../../pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads", () => {
  const OVERLOADED_FALLBACK_TEXT =
    "The AI service is temporarily overloaded. Please try again in a moment.";
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = `{
  "type": "error",
  "error": {
    "details": null,
    "type": "overloaded_error",
    "message": "Overloaded"
  },
  "request_id": "req_011CX7DwS7tSvggaNHmefwWg"
}`;
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage =>
    makeAssistantMessageFixture({
      content: [{ text: errorJson, type: "text" }],
      errorMessage: errorJson,
      ...overrides,
    });
  const makeStoppedAssistant = () =>
    makeAssistant({
      content: [],
      errorMessage: undefined,
      stopReason: "stop",
    });

  const expectOverloadedFallback = (payloads: ReturnType<typeof buildPayloads>) => {
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(OVERLOADED_FALLBACK_TEXT);
  };

  function expectSinglePayloadSummary(
    payloads: ReturnType<typeof buildPayloads>,
    expected: { text: string; isError?: boolean },
  ) {
    expectSinglePayloadText(payloads, expected.text);
    if (expected.isError === undefined) {
      expect(payloads[0]?.isError).toBeUndefined();
      return;
    }
    expect(payloads[0]?.isError).toBe(expected.isError);
  }

  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  function expectNoSyntheticCompletionForSession(sessionKey: string) {
    expectNoPayloads({
      lastAssistant: makeAssistant({
        content: [],
        errorMessage: undefined,
        stopReason: "stop",
      }),
      sessionKey,
      toolMetas: [{ meta: "/tmp/out.md", toolName: "write" }],
    });
  }

  it("suppresses raw API error JSON when the assistant errored", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
    });

    expectOverloadedFallback(payloads);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      inlineToolResultsAllowed: true,
      lastAssistant: makeAssistant({ errorMessage: errorJson }),
      verboseLevel: "on",
    });

    expectOverloadedFallback(payloads);
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({ content: [{ text: errorJsonPretty, type: "text" }] }),
    });

    expectOverloadedFallback(payloads);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("includes provider and model context for billing errors", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        content: [{ type: "text", text: "insufficient credits" }],
        errorMessage: "insufficient credits",
        model: "claude-3-5-sonnet",
      }),
      model: "claude-3-5-sonnet",
      provider: "Anthropic",
    });

    expectSinglePayloadSummary(payloads, {
      isError: true,
      text: formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"),
    });
  });

  it("does not emit a synthetic billing error for successful turns with stale errorMessage", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        content: [{ text: "Handle payment required errors in your API.", type: "text" }],
        errorMessage: "insufficient credits for embedding model",
        stopReason: "stop",
      }),
    });

    expectSinglePayloadText(payloads, "Handle payment required errors in your API.");
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: undefined }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeStoppedAssistant(),
    });

    expectSinglePayloadText(payloads, errorJsonPretty.trim());
  });

  it("adds a fallback error when a tool fails and no assistant output exists", () => {
    const payloads = buildPayloads({
      lastToolError: { error: "tab not found", toolName: "browser" },
    });

    expectSingleToolErrorPayload(payloads, {
      absentDetail: "tab not found",
      title: "Browser",
    });
  });

  it("does not add tool error fallback when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["All good"],
      lastAssistant: makeStoppedAssistant(),
      lastToolError: { error: "tab not found", toolName: "browser" },
    });

    expectSinglePayloadText(payloads, "All good");
  });

  it("does not add synthetic completion text when tools run without final assistant text", () => {
    expectNoPayloads({
      lastAssistant: makeStoppedAssistant(),
      sessionKey: "agent:main:discord:direct:u123",
      toolMetas: [{ meta: "/tmp/out.md", toolName: "write" }],
    });
  });

  it("does not add synthetic completion text for channel sessions", () => {
    expectNoSyntheticCompletionForSession("agent:main:discord:channel:c123");
  });

  it("does not add synthetic completion text for group sessions", () => {
    expectNoSyntheticCompletionForSession("agent:main:telegram:group:g123");
  });

  it("does not add synthetic completion text when messaging tool already delivered output", () => {
    expectNoPayloads({
      didSendViaMessagingTool: true,
      lastAssistant: makeAssistant({
        content: [],
        errorMessage: undefined,
        stopReason: "stop",
      }),
      sessionKey: "agent:main:discord:direct:u123",
      toolMetas: [{ meta: "sent to #ops", toolName: "message_send" }],
    });
  });

  it("does not add synthetic completion text when the run still has a tool error", () => {
    expectNoPayloads({
      lastToolError: { error: "url required", toolName: "browser" },
      toolMetas: [{ meta: "open https://example.com", toolName: "browser" }],
    });
  });

  it("does not add synthetic completion text when no tools ran", () => {
    expectNoPayloads({
      lastAssistant: makeStoppedAssistant(),
    });
  });

  it("adds tool error fallback when the assistant only invoked tools and verbose mode is on", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        content: [
          {
            arguments: { command: "echo hi" },
            id: "toolu_01",
            name: "exec",
            type: "toolCall",
          },
        ],
        errorMessage: undefined,
        stopReason: "toolUse",
      }),
      lastToolError: { error: "Command exited with code 1", toolName: "exec" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      detail: "code 1",
      title: "Exec",
    });
  });

  it("does not add tool error fallback when assistant text exists after tool calls", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Checked the page and recovered with final answer."],
      lastAssistant: makeAssistant({
        content: [
          {
            arguments: { action: "search", query: "openclaw docs" },
            id: "toolu_01",
            name: "browser",
            type: "toolCall",
          },
        ],
        errorMessage: undefined,
        stopReason: "toolUse",
      }),
      lastToolError: { error: "connection timeout", toolName: "browser" },
    });

    expectSinglePayloadSummary(payloads, {
      text: "Checked the page and recovered with final answer.",
    });
  });

  it.each(["url required", "url missing", "invalid parameter: url"])(
    "suppresses recoverable non-mutating tool error: %s",
    (error) => {
      expectNoPayloads({
        lastToolError: { error, toolName: "browser" },
      });
    },
  );

  it("suppresses non-mutating non-recoverable tool errors when messages.suppressToolErrors is enabled", () => {
    expectNoPayloads({
      config: { messages: { suppressToolErrors: true } },
      lastToolError: { error: "connection timeout", toolName: "browser" },
    });
  });

  it("suppresses mutating tool errors when suppressToolErrorWarnings is enabled", () => {
    expectNoPayloads({
      lastToolError: { error: "command not found", toolName: "exec" },
      suppressToolErrorWarnings: true,
    });
  });

  it.each([
    {
      absentDetail: "connection timeout",
      name: "still shows mutating tool errors when messages.suppressToolErrors is enabled",
      payload: {
        config: { messages: { suppressToolErrors: true } },
        lastToolError: { error: "connection timeout", toolName: "write" },
      },
      title: "Write",
    },
    {
      absentDetail: "required",
      name: "shows recoverable tool errors for mutating tools",
      payload: {
        lastToolError: { error: "text required", meta: "reply", toolName: "message" },
      },
      title: "Message",
    },
    {
      absentDetail: "connection timeout",
      name: "shows non-recoverable tool failure summaries to the user",
      payload: {
        lastToolError: { error: "connection timeout", toolName: "browser" },
      },
      title: "Browser",
    },
  ])("$name", ({ payload, title, absentDetail }) => {
    const payloads = buildPayloads(payload);
    expectSingleToolErrorPayload(payloads, { absentDetail, title });
  });

  it("shows mutating tool errors even when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Done."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: { error: "file missing", toolName: "write" },
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe("Done.");
    expect(payloads[1]?.isError).toBe(true);
    expect(payloads[1]?.text).toContain("Write");
    expect(payloads[1]?.text).not.toContain("missing");
  });

  it("does not treat session_status read failures as mutating when explicitly flagged", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Status loaded."],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        error: "model required",
        mutatingAction: false,
        toolName: "session_status",
      },
    });

    expectSinglePayloadSummary(payloads, { text: "Status loaded." });
  });

  it("dedupes identical tool warning text already present in assistant output", () => {
    const seed = buildPayloads({
      lastToolError: {
        error: "file missing",
        mutatingAction: true,
        toolName: "write",
      },
    });
    const warningText = seed[0]?.text;
    expect(warningText).toBeTruthy();

    const payloads = buildPayloads({
      assistantTexts: [warningText ?? ""],
      lastAssistant: { stopReason: "end_turn" } as unknown as AssistantMessage,
      lastToolError: {
        error: "file missing",
        mutatingAction: true,
        toolName: "write",
      },
    });

    expectSinglePayloadSummary(payloads, { text: warningText ?? "" });
  });

  it("includes non-recoverable tool error details when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { error: "connection timeout", toolName: "browser" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      detail: "connection timeout",
      title: "Browser",
    });
  });
});
