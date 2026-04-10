import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession", () => {
  it("calls onBlockReplyFlush before tool_execution_start to preserve message boundaries", () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReplyFlush = vi.fn();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "text_end",
      onBlockReply,
      onBlockReplyFlush,
      runId: "run-flush-test",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    // Simulate text arriving before tool
    emit({
      message: { role: "assistant" },
      type: "message_start",
    });

    emitAssistantTextDelta({ delta: "First message before tool.", emit });

    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    // Tool execution starts - should trigger flush
    emit({
      args: { command: "echo hello" },
      toolCallId: "tool-flush-1",
      toolName: "bash",
      type: "tool_execution_start",
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    // Another tool - should flush again
    emit({
      args: { path: "/tmp/test.txt" },
      toolCallId: "tool-flush-2",
      toolName: "read",
      type: "tool_execution_start",
    });

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
  });
  it("flushes buffered block chunks before tool execution", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "text_end",
      blockReplyChunking: { maxChars: 200, minChars: 50 },
      onBlockReply,
      onBlockReplyFlush,
      runId: "run-flush-buffer",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });

    emitAssistantTextDelta({ delta: "Short chunk.", emit });

    expect(onBlockReply).not.toHaveBeenCalled();

    emit({
      args: { command: "echo flush" },
      toolCallId: "tool-flush-buffer-1",
      toolName: "bash",
      type: "tool_execution_start",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Short chunk.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("waits for async block replies before tool_execution_start flush", async () => {
    const { session, emit } = createStubSessionHarness();
    const delivered: string[] = [];
    const flushSnapshots: string[][] = [];

    subscribeEmbeddedPiSession({
      blockReplyBreak: "text_end",
      blockReplyChunking: { maxChars: 200, minChars: 50 },
      onBlockReply: async (payload) => {
        await Promise.resolve();
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      onBlockReplyFlush: vi.fn(() => {
        flushSnapshots.push([...delivered]);
      }),
      runId: "run-async-tool-flush",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });
    emitAssistantTextDelta({ delta: "Short chunk.", emit });

    emit({
      args: { command: "echo flush" },
      toolCallId: "tool-async-flush-1",
      toolName: "bash",
      type: "tool_execution_start",
    });
    await vi.waitFor(() => {
      expect(delivered).toEqual(["Short chunk."]);
      expect(flushSnapshots).toEqual([["Short chunk."]]);
    });
  });

  it("calls onBlockReplyFlush at message_end for message-boundary turns", async () => {
    const { session, emit } = createStubSessionHarness();

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      blockReplyBreak: "message_end",
      onBlockReply,
      onBlockReplyFlush,
      runId: "run-message-end-flush",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });
    emitAssistantTextDelta({ delta: "Final reply before lifecycle end.", emit });
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    emit({
      message: {
        content: [{ text: "Final reply before lifecycle end.", type: "text" }],
        role: "assistant",
      },
      type: "message_end",
    });
    await Promise.resolve();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0]?.text).toBe("Final reply before lifecycle end.");
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });

  it("waits for async block replies before message_end flush", async () => {
    const { session, emit } = createStubSessionHarness();
    const delivered: string[] = [];
    const flushSnapshots: string[][] = [];

    subscribeEmbeddedPiSession({
      blockReplyBreak: "message_end",
      onBlockReply: async (payload) => {
        await Promise.resolve();
        if (payload.text) {
          delivered.push(payload.text);
        }
      },
      onBlockReplyFlush: vi.fn(() => {
        flushSnapshots.push([...delivered]);
      }),
      runId: "run-async-message-end-flush",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    emit({
      message: { role: "assistant" },
      type: "message_start",
    });
    emitAssistantTextDelta({ delta: "Final reply before lifecycle end.", emit });

    emit({
      message: {
        content: [{ text: "Final reply before lifecycle end.", type: "text" }],
        role: "assistant",
      },
      type: "message_end",
    });
    await vi.waitFor(() => {
      expect(delivered).toEqual(["Final reply before lifecycle end."]);
      expect(flushSnapshots).toEqual([["Final reply before lifecycle end."]]);
    });
  });
});
