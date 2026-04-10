import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  repairToolUseResultPairing,
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
  stripToolResultDetails,
} from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

function getAssistantToolCallBlocks(messages: AgentMessage[]) {
  const assistant = messages[0] as Extract<AgentMessage, { role: "assistant" }> | undefined;
  if (!assistant || !Array.isArray(assistant.content)) {
    return [] as { type?: unknown; id?: unknown; name?: unknown }[];
  }
  return assistant.content.filter((block) => {
    const { type } = block as { type?: unknown };
    return typeof type === "string" && TOOL_CALL_BLOCK_TYPES.has(type);
  }) as { type?: unknown; id?: unknown; name?: unknown }[];
}

describe("sanitizeToolUseResultPairing", () => {
  const buildDuplicateToolResultInput = (opts?: {
    middleMessage?: unknown;
    secondText?: string;
  }): AgentMessage[] =>
    castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
      },
      {
        content: [{ text: "first", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
      ...(opts?.middleMessage ? [castAgentMessage(opts.middleMessage)] : []),
      {
        content: [{ text: opts?.secondText ?? "second", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
    ]);

  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = castAgentMessages([
      {
        content: [
          { arguments: {}, id: "call_1", name: "read", type: "toolCall" },
          { arguments: {}, id: "call_2", name: "exec", type: "toolCall" },
        ],
        role: "assistant",
      },
      { content: "user message that should come after tool use", role: "user" },
      {
        content: [{ text: "ok", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("repairs blank tool result names from matching tool calls", () => {
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
      },
      {
        content: [{ text: "ok", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    const toolResult = out.find((message) => message.role === "toolResult") as {
      toolName?: string;
    };

    expect(toolResult?.toolName).toBe("read");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = castAgentMessages([
      ...buildDuplicateToolResultInput(),
      { content: "ok", role: "user" },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = buildDuplicateToolResultInput({
      middleMessage: { content: [{ text: "ok", type: "text" }], role: "assistant" },
      secondText: "second (duplicate)",
    });

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as {
      toolCallId?: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = castAgentMessages([
      { content: "hello", role: "user" },
      {
        content: [{ text: "orphan", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
      },
      {
        content: [{ text: "ok", type: "text" }],
        role: "assistant",
      },
    ]);

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips tool call extraction for assistant messages with stopReason 'error'", () => {
    // When an assistant message has stopReason: "error", its tool_use blocks may be
    // Incomplete/malformed. We should NOT create synthetic tool_results for them,
    // As this causes API 400 errors: "unexpected tool_use_id found in tool_result blocks"
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_error", name: "exec", type: "toolCall" }],
        role: "assistant",
        stopReason: "error",
      },
      { content: "something went wrong", role: "user" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for errored messages
    expect(result.added).toHaveLength(0);
    // The assistant message should be passed through unchanged
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.messages).toHaveLength(2);
  });

  it("skips tool call extraction for assistant messages with stopReason 'aborted'", () => {
    // When a request is aborted mid-stream, the assistant message may have incomplete
    // Tool_use blocks (with partialJson). We should NOT create synthetic tool_results.
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_aborted", name: "Bash", type: "toolCall" }],
        role: "assistant",
        stopReason: "aborted",
      },
      { content: "retrying after abort", role: "user" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should NOT add synthetic tool results for aborted messages
    expect(result.added).toHaveLength(0);
    // Messages should be passed through without synthetic insertions
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
  });

  it("still repairs tool results for normal assistant messages with stopReason 'toolUse'", () => {
    // Normal tool calls (stopReason: "toolUse" or "stop") should still be repaired
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_normal", name: "read", type: "toolCall" }],
        role: "assistant",
        stopReason: "toolUse",
      },
      { content: "user message", role: "user" },
    ]);

    const result = repairToolUseResultPairing(input);

    // Should add a synthetic tool result for the missing result
    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.toolCallId).toBe("call_normal");
  });

  it("retains matching tool results that follow an aborted assistant message", () => {
    // Aborted assistant turns do not synthesize missing tool results, but real
    // Matching results in the same span remain part of the repaired transcript.
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_aborted", name: "exec", type: "toolCall" }],
        role: "assistant",
        stopReason: "aborted",
      },
      {
        content: [{ text: "partial result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
      },
      { content: "retrying", role: "user" },
    ]);

    const result = repairToolUseResultPairing(input);

    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    expect(result.messages[2]?.role).toBe("user");
    expect(result.added).toHaveLength(0);
  });

  it("drops matching tool results for aborted assistant messages when requested", () => {
    const input = castAgentMessages([
      {
        content: [{ arguments: {}, id: "call_aborted", name: "exec", type: "toolCall" }],
        role: "assistant",
        stopReason: "aborted",
      },
      {
        content: [{ text: "partial result", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
      },
      { content: "retrying", role: "user" },
    ]);

    const result = repairToolUseResultPairing(input, {
      erroredAssistantResultPolicy: "drop",
    });

    expect(result.droppedOrphanCount).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.added).toHaveLength(0);
  });
});

describe("sanitizeToolCallInputs", () => {
  function sanitizeAssistantContent(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return sanitizeToolCallInputs(
      castAgentMessages([
        {
          content,
          role: "assistant",
        },
      ]),
      options,
    );
  }

  function sanitizeAssistantToolCalls(
    content: unknown[],
    options?: Parameters<typeof sanitizeToolCallInputs>[1],
  ) {
    return getAssistantToolCallBlocks(sanitizeAssistantContent(content, options));
  }

  it("drops tool calls missing input or arguments", () => {
    const input = castAgentMessages([
      {
        content: [{ id: "call_1", name: "read", type: "toolCall" }],
        role: "assistant",
      },
      { content: "hello", role: "user" },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it.each([
    {
      content: [
        { arguments: {}, id: "call_ok", name: "read", type: "toolCall" },
        { arguments: {}, id: "call_empty_name", name: "", type: "toolCall" },
        { id: "call_blank_name", input: {}, name: "   ", type: "toolUse" },
        { arguments: {}, id: "", name: "exec", type: "functionCall" },
      ],
      expectedIds: ["call_ok"],
      name: "drops tool calls with missing or blank name/id",
      options: undefined,
    },
    {
      content: [
        { arguments: {}, id: "call_ok", name: "read", type: "toolCall" },
        {
          arguments: {},
          id: "call_bad_chars",
          name: 'toolu_01abc <|tool_call_argument_begin|> {"command"',
          type: "toolCall",
        },
        {
          id: "call_too_long",
          input: {},
          name: `read_${"x".repeat(80)}`,
          type: "toolUse",
        },
      ],
      expectedIds: ["call_ok"],
      name: "drops tool calls with malformed or overlong names",
      options: undefined,
    },
    {
      content: [
        { arguments: {}, id: "call_ns", name: "vigil-harbor__memory_status", type: "toolCall" },
        { id: "call_dotted", input: {}, name: "my.server:some_tool", type: "toolUse" },
      ],
      expectedIds: ["call_ns", "call_dotted"],
      name: "accepts punctuation-safe tool names during transcript repair",
      options: undefined,
    },
    {
      content: [
        { arguments: {}, id: "call_ok", name: "read", type: "toolCall" },
        { arguments: {}, id: "call_unknown", name: "write", type: "toolCall" },
      ],
      expectedIds: ["call_ok"],
      name: "drops unknown tool names when an allowlist is provided",
      options: { allowedToolNames: ["read"] },
    },
  ])("$name", ({ content, options, expectedIds }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const ids = toolCalls
      .map((toolCall) => (toolCall as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    expect(ids).toEqual(expectedIds);
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input = castAgentMessages([
      {
        content: [
          { text: "before", type: "text" },
          { id: "call_ok", input: { path: "a" }, name: "read", type: "toolUse" },
          { id: "call_drop", name: "read", type: "toolCall" },
        ],
        role: "assistant",
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });

  it.each([
    {
      content: [{ arguments: {}, id: "call_1", name: " read", type: "toolCall" }],
      expectedNames: ["read"],
      name: "trims leading whitespace from tool names",
      options: undefined,
    },
    {
      content: [{ id: "call_1", input: { command: "ls" }, name: "exec ", type: "toolUse" }],
      expectedNames: ["exec"],
      name: "trims trailing whitespace from tool names",
      options: undefined,
    },
    {
      content: [
        { arguments: {}, id: "call_1", name: " read ", type: "toolCall" },
        { id: "call_2", input: {}, name: "  exec  ", type: "toolUse" },
      ],
      expectedNames: ["read", "exec"],
      name: "trims both leading and trailing whitespace from tool names",
      options: undefined,
    },
    {
      content: [
        { arguments: {}, id: "call_1", name: " read ", type: "toolCall" },
        { arguments: {}, id: "call_2", name: " write ", type: "toolCall" },
      ],
      expectedNames: ["read"],
      name: "trims tool names and matches against allowlist",
      options: { allowedToolNames: ["read"] },
    },
  ])("$name", ({ content, options, expectedNames }) => {
    const toolCalls = sanitizeAssistantToolCalls(content, options);
    const names = toolCalls
      .map((toolCall) => (toolCall as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
    expect(names).toEqual(expectedNames);
  });

  it("preserves toolUse input shape for sessions_spawn when no attachments are present", () => {
    const input = castAgentMessages([
      {
        content: [
          {
            id: "call_1",
            input: { task: "hello" },
            name: "sessions_spawn",
            type: "toolUse",
          },
        ],
        role: "assistant",
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Record<string, unknown>[];

    expect(toolCalls).toHaveLength(1);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "input")).toBe(true);
    expect(Object.hasOwn(toolCalls[0] ?? {}, "arguments")).toBe(false);
    expect((toolCalls[0] ?? {}).input).toEqual({ task: "hello" });
  });

  it("redacts sessions_spawn attachments for mixed-case and padded tool names", () => {
    const input = castAgentMessages([
      {
        content: [
          {
            id: "call_1",
            input: {
              attachments: [{ name: "a.txt", content: "SECRET" }],
              task: "hello",
            },
            name: "  SESSIONS_SPAWN  ",
            type: "toolUse",
          },
        ],
        role: "assistant",
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const toolCalls = getAssistantToolCallBlocks(out) as Record<string, unknown>[];

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] ?? {}).name).toBe("SESSIONS_SPAWN");
    const inputObj = (toolCalls[0]?.input ?? {}) as Record<string, unknown>;
    const attachments = (inputObj.attachments ?? []) as Record<string, unknown>[];
    expect(attachments[0]?.content).toBe("__OPENCLAW_REDACTED__");
  });
  it("preserves other block properties when trimming tool names", () => {
    const toolCalls = sanitizeAssistantToolCalls([
      { arguments: { path: "/tmp/test" }, id: "call_1", name: " read ", type: "toolCall" },
    ]);

    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { name?: unknown }).name).toBe("read");
    expect((toolCalls[0] as { id?: unknown }).id).toBe("call_1");
    expect((toolCalls[0] as { arguments?: unknown }).arguments).toEqual({ path: "/tmp/test" });
  });
});

describe("stripToolResultDetails", () => {
  it("removes details only from toolResult messages", () => {
    const input = castAgentMessages([
      {
        content: [{ text: "ok", type: "text" }],
        details: { internal: true },
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
      { content: [{ text: "keep me", type: "text" }], details: { no: "touch" }, role: "assistant" },
      { content: "hello", role: "user" },
    ]);

    const out = stripToolResultDetails(input) as unknown as Record<string, unknown>[];

    expect(Object.hasOwn(out[0] ?? {}, "details")).toBe(false);
    expect((out[0] ?? {}).role).toBe("toolResult");

    // Non-toolResult messages are preserved as-is.
    expect(Object.hasOwn(out[1] ?? {}, "details")).toBe(true);
    expect((out[1] ?? {}).role).toBe("assistant");
    expect((out[2] ?? {}).role).toBe("user");
  });

  it("returns the same array reference when there are no toolResult details", () => {
    const input = castAgentMessages([
      { content: [{ text: "a", type: "text" }], role: "assistant" },
      {
        content: [{ text: "ok", type: "text" }],
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
      },
      { content: "b", role: "user" },
    ]);

    const out = stripToolResultDetails(input);
    expect(out).toBe(input);
  });
});
