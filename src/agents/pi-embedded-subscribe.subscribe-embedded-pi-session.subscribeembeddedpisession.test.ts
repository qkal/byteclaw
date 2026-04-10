import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createStubSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  emitMessageStartAndEndForAssistantText,
  expectSingleAgentEventText,
  extractAgentEventPayloads,
  findLifecycleErrorAgentEvent,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  async function flushBlockReplyCallbacks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      onAgentEvent,
      runId: options?.runId ?? "run",
      session,
      sessionKey: options?.sessionKey,
    });

    return { emit, onAgentEvent };
  }

  function createToolErrorHarness(runId: string) {
    const { session, emit } = createStubSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      runId,
      session,
      sessionKey: "test-session",
    });

    return { emit, subscription };
  }

  function createSubscribedHarness(
    options: Omit<Parameters<typeof subscribeEmbeddedPiSession>[0], "session">,
  ) {
    const { session, emit } = createStubSessionHarness();
    subscribeEmbeddedPiSession({
      session,
      ...options,
    });
    return { emit };
  }

  function emitAssistantTextDelta(
    emit: (evt: unknown) => void,
    delta: string,
    message: Record<string, unknown> = { role: "assistant" },
  ) {
    emit({
      assistantMessageEvent: {
        delta,
        type: "text_delta",
      },
      message,
      type: "message_update",
    });
  }

  function createWriteFailureHarness(params: {
    runId: string;
    path: string;
    content: string;
  }): ReturnType<typeof createToolErrorHarness> {
    const harness = createToolErrorHarness(params.runId);
    emitToolRun({
      args: { content: params.content, path: params.path },
      emit: harness.emit,
      isError: true,
      result: { error: "disk full" },
      toolCallId: "w1",
      toolName: "write",
    });
    expect(harness.subscription.getLastToolError()?.toolName).toBe("write");
    return harness;
  }

  function emitToolRun(params: {
    emit: (evt: unknown) => void;
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    isError: boolean;
    result: unknown;
  }): void {
    params.emit({
      args: params.args,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      type: "tool_execution_start",
    });
    params.emit({
      isError: params.isError,
      result: params.result,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      type: "tool_execution_end",
    });
  }

  it.each(THINKING_TAG_CASES)(
    "streams <%s> reasoning via onReasoningStream without leaking into final text",
    async ({ open, close }) => {
      const onReasoningStream = vi.fn();
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedHarness({
        blockReplyBreak: "message_end",
        onBlockReply,
        onReasoningStream,
        reasoningMode: "stream",
        runId: "run",
      });

      emitAssistantTextDelta(emit, `${open}\nBecause`);
      emitAssistantTextDelta(emit, ` it helps\n${close}\n\nFinal answer`);

      const assistantMessage = {
        content: [
          {
            text: `${open}\nBecause it helps\n${close}\n\nFinal answer`,
            type: "text",
          },
        ],
        role: "assistant",
      } as AssistantMessage;

      emit({ message: assistantMessage, type: "message_end" });
      await flushBlockReplyCallbacks();

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0][0].text).toBe("Final answer");

      const streamTexts = onReasoningStream.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      expect(streamTexts.at(-1)).toBe("Reasoning:\n_Because it helps_");

      expect(assistantMessage.content).toEqual([
        { thinking: "Because it helps", type: "thinking" },
        { text: "Final answer", type: "text" },
      ]);
    },
  );

  it("suppresses assistant streaming while deterministic exec approval delivery is pending", async () => {
    let resolveToolResult: (() => void) | undefined;
    const onToolResult = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveToolResult = resolve;
        }),
    );
    const onPartialReply = vi.fn();

    const { emit } = createSubscribedHarness({
      onPartialReply,
      onToolResult,
      runId: "run",
    });

    emit({
      args: { command: "echo hi" },
      toolCallId: "tool-1",
      toolName: "exec",
      type: "tool_execution_start",
    });
    emit({
      isError: false,
      result: {
        details: {
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          command: "echo hi",
          host: "gateway",
          status: "approval-pending",
        },
      },
      toolCallId: "tool-1",
      toolName: "exec",
      type: "tool_execution_end",
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });
    emitAssistantTextDelta(emit, "After tool");

    await vi.waitFor(() => {
      expect(onToolResult).toHaveBeenCalledTimes(1);
    });
    expect(onPartialReply).not.toHaveBeenCalled();

    expect(resolveToolResult).toBeTypeOf("function");
    resolveToolResult?.();
    await Promise.resolve();
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("attaches media from internal completion events even when assistant omits MEDIA lines", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createSubscribedHarness({
      blockReplyBreak: "message_end",
      internalEvents: [
        {
          announceType: "music generation task",
          childSessionKey: "music_generate:task-123",
          mediaUrls: ["/tmp/lobster-boss.mp3"],
          replyInstruction: "Reply normally.",
          result: "Generated 1 track.\nMEDIA:/tmp/lobster-boss.mp3",
          source: "music_generation",
          status: "ok",
          statusLabel: "completed successfully",
          taskLabel: "lobster boss theme",
          type: "task_completion",
        },
      ],
      onBlockReply,
      runId: "run",
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });
    emitAssistantTextDelta(emit, "Here it is.");
    emit({
      message: {
        content: [{ text: "Here it is.", type: "text" }],
        role: "assistant",
      },
      type: "message_end",
    });
    emit({ type: "agent_end" });
    await flushBlockReplyCallbacks();

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrls: ["/tmp/lobster-boss.mp3"],
        text: "Here it is.",
      }),
    );
  });

  it.each(THINKING_TAG_CASES)(
    "suppresses <%s> blocks across chunk boundaries",
    async ({ open, close }) => {
      const onBlockReply = vi.fn();

      const { emit } = createSubscribedHarness({
        blockReplyBreak: "text_end",
        blockReplyChunking: {
          breakPreference: "newline",
          maxChars: 50,
          minChars: 5,
        },
        onBlockReply,
        runId: "run",
      });

      emit({ message: { role: "assistant" }, type: "message_start" });
      emitAssistantTextDelta(emit, `${open}Reasoning chunk that should not leak`);

      expect(onBlockReply).not.toHaveBeenCalled();

      emitAssistantTextDelta(emit, `${close}\n\nFinal answer`);
      emit({
        assistantMessageEvent: { type: "text_end" },
        message: { role: "assistant" },
        type: "message_update",
      });
      await flushBlockReplyCallbacks();

      expect(onBlockReply.mock.calls.length).toBeGreaterThan(0);
      const payloadTexts = onBlockReply.mock.calls
        .map((call) => call[0]?.text)
        .filter((value): value is string => typeof value === "string");
      for (const text of payloadTexts) {
        expect(text).not.toContain("Reasoning");
        expect(text).not.toContain(open);
      }
      const combined = payloadTexts.join(" ").replace(/\s+/g, " ").trim();
      expect(combined).toBe("Final answer");
    },
  );

  it("streams native thinking_delta events and signals reasoning end", () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedHarness({
      onReasoningEnd,
      onReasoningStream,
      reasoningMode: "stream",
      runId: "run",
    });

    emit({
      assistantMessageEvent: {
        delta: "Checking files",
        type: "thinking_delta",
      },
      message: {
        content: [{ thinking: "Checking files", type: "thinking" }],
        role: "assistant",
      },
      type: "message_update",
    });

    emit({
      assistantMessageEvent: {
        type: "thinking_end",
      },
      message: {
        content: [{ thinking: "Checking files done", type: "thinking" }],
        role: "assistant",
      },
      type: "message_update",
    });

    const streamTexts = onReasoningStream.mock.calls
      .map((call) => call[0]?.text)
      .filter((value): value is string => typeof value === "string");
    expect(streamTexts.at(-1)).toBe("Reasoning:\n_Checking files done_");
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("emits reasoning end once when native and tagged reasoning end overlap", () => {
    const onReasoningEnd = vi.fn();

    const { emit } = createSubscribedHarness({
      onReasoningEnd,
      onReasoningStream: vi.fn(),
      reasoningMode: "stream",
      runId: "run",
    });

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta(emit, "<think>Checking");
    emit({
      assistantMessageEvent: {
        type: "thinking_end",
      },
      message: {
        content: [{ thinking: "Checking", type: "thinking" }],
        role: "assistant",
      },
      type: "message_update",
    });

    emitAssistantTextDelta(emit, " files</think>\nFinal answer");

    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
  });

  it("emits delta chunks in agent events for streaming assistant text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emit({
      assistantMessageEvent: { delta: "Hello", type: "text_delta" },
      message: { role: "assistant" },
      type: "message_update",
    });
    emit({
      assistantMessageEvent: { delta: " world", type: "text_delta" },
      message: { role: "assistant" },
      type: "message_update",
    });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads[0]?.text).toBe("Hello");
    expect(payloads[0]?.delta).toBe("Hello");
    expect(payloads[1]?.text).toBe("Hello world");
    expect(payloads[1]?.delta).toBe(" world");
  });

  it("emits agent events on message_end for non-streaming assistant text", () => {
    const { session, emit } = createStubSessionHarness();

    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      onAgentEvent,
      runId: "run",
      session,
    });
    emitMessageStartAndEndForAssistantText({ emit, text: "Hello world" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Hello world");
  });

  it("does not emit duplicate agent events when message_end repeats", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    const assistantMessage = {
      content: [{ text: "Hello world", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    emit({ message: assistantMessage, type: "message_start" });
    emit({ message: assistantMessage, type: "message_end" });
    emit({ message: assistantMessage, type: "message_end" });

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
  });

  it("emits a replacement snapshot when cleaned text rewinds mid-stream", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta(emit, "MEDIA:");
    emitAssistantTextDelta(emit, " https://example.com/a.png\nCaption");

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.text).toBe("MEDIA:");
    expect(payloads[0]?.delta).toBe("MEDIA:");
    expect(payloads[0]?.replace).toBeUndefined();
    expect(payloads[1]?.text).toBe("Caption");
    expect(payloads[1]?.delta).toBe("");
    expect(payloads[1]?.replace).toBe(true);
  });

  it("emits agent events when media arrives without text", () => {
    const { emit, onAgentEvent } = createAgentEventHarness();

    emit({ message: { role: "assistant" }, type: "message_start" });
    emitAssistantTextDelta(emit, "MEDIA: https://example.com/a.png");

    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("");
    expect(payloads[0]?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("keeps unresolved mutating failure when an unrelated tool succeeds", () => {
    const { emit, subscription } = createWriteFailureHarness({
      content: "next",
      path: "/tmp/demo.txt",
      runId: "run-tools-1",
    });

    emitToolRun({
      args: { path: "/tmp/demo.txt" },
      emit,
      isError: false,
      result: { text: "ok" },
      toolCallId: "r1",
      toolName: "read",
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("clears unresolved mutating failure when the same action succeeds", () => {
    const { emit, subscription } = createWriteFailureHarness({
      content: "next",
      path: "/tmp/demo.txt",
      runId: "run-tools-2",
    });

    emitToolRun({
      args: { content: "retry", path: "/tmp/demo.txt" },
      emit,
      isError: false,
      result: { ok: true },
      toolCallId: "w2",
      toolName: "write",
    });

    expect(subscription.getLastToolError()).toBeUndefined();
  });

  it("keeps unresolved mutating failure when same tool succeeds on a different target", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-3");

    emitToolRun({
      args: { content: "first", path: "/tmp/a.txt" },
      emit,
      isError: true,
      result: { error: "disk full" },
      toolCallId: "w1",
      toolName: "write",
    });

    emitToolRun({
      args: { content: "second", path: "/tmp/b.txt" },
      emit,
      isError: false,
      result: { ok: true },
      toolCallId: "w2",
      toolName: "write",
    });

    expect(subscription.getLastToolError()?.toolName).toBe("write");
  });

  it("keeps unresolved session_status model-mutation failure on later read-only status success", () => {
    const { emit, subscription } = createToolErrorHarness("run-tools-4");

    emitToolRun({
      args: { model: "openai/gpt-4o", sessionKey: "agent:main:main" },
      emit,
      isError: true,
      result: { error: "Model not allowed." },
      toolCallId: "s1",
      toolName: "session_status",
    });

    emitToolRun({
      args: { sessionKey: "agent:main:main" },
      emit,
      isError: false,
      result: { ok: true },
      toolCallId: "s2",
      toolName: "session_status",
    });

    expect(subscription.getLastToolError()?.toolName).toBe("session_status");
  });

  it("emits lifecycle:error event on agent_end when last assistant message was an error", async () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "429 Rate limit exceeded",
    });

    // Look for lifecycle:error event
    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);

    expect(lifecycleError).toBeDefined();
    expect(lifecycleError?.data?.error).toContain("API rate limit reached");
  });
});
