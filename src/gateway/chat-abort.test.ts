import { describe, expect, it, vi } from "vitest";
import {
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  abortChatRunById,
  isChatStopCommandText,
} from "./chat-abort.js";

function createActiveEntry(sessionKey: string): ChatAbortControllerEntry {
  const now = Date.now();
  return {
    controller: new AbortController(),
    expiresAtMs: now + 10_000,
    sessionId: "sess-1",
    sessionKey,
    startedAtMs: now,
  };
}

function createOps(params: {
  runId: string;
  entry: ChatAbortControllerEntry;
  buffer?: string;
}): ChatAbortOps & {
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  removeChatRun: ReturnType<typeof vi.fn>;
} {
  const { runId, entry, buffer } = params;
  const broadcast = vi.fn();
  const nodeSendToSession = vi.fn();
  const removeChatRun = vi.fn();

  return {
    agentRunSeq: new Map(),
    broadcast,
    chatAbortControllers: new Map([[runId, entry]]),
    chatAbortedRuns: new Map(),
    chatDeltaLastBroadcastLen: new Map([[runId, buffer?.length ?? 0]]),
    chatDeltaSentAt: new Map([[runId, Date.now()]]),
    chatRunBuffers: new Map(buffer !== undefined ? [[runId, buffer]] : []),
    nodeSendToSession,
    removeChatRun,
  };
}

describe("isChatStopCommandText", () => {
  it("matches slash and standalone multilingual stop forms", () => {
    expect(isChatStopCommandText(" /STOP!!! ")).toBe(true);
    expect(isChatStopCommandText("stop please")).toBe(true);
    expect(isChatStopCommandText("do not do that")).toBe(true);
    expect(isChatStopCommandText("停止")).toBe(true);
    expect(isChatStopCommandText("やめて")).toBe(true);
    expect(isChatStopCommandText("توقف")).toBe(true);
    expect(isChatStopCommandText("остановись")).toBe(true);
    expect(isChatStopCommandText("halt")).toBe(true);
    expect(isChatStopCommandText("stopp")).toBe(true);
    expect(isChatStopCommandText("pare")).toBe(true);
    expect(isChatStopCommandText("/status")).toBe(false);
    expect(isChatStopCommandText("please do not do that")).toBe(false);
    expect(isChatStopCommandText("keep going")).toBe(false);
  });
});

describe("abortChatRunById", () => {
  it("broadcasts aborted payload with partial message when buffered text exists", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ buffer: "  Partial reply  ", entry, runId });
    ops.agentRunSeq.set(runId, 2);
    ops.agentRunSeq.set("client-run-1", 4);
    ops.removeChatRun.mockReturnValue({ clientRunId: "client-run-1", sessionKey });

    const result = abortChatRunById(ops, { runId, sessionKey, stopReason: "user" });

    expect(result).toEqual({ aborted: true });
    expect(entry.controller.signal.aborted).toBe(true);
    expect(ops.chatAbortControllers.has(runId)).toBe(false);
    expect(ops.chatRunBuffers.has(runId)).toBe(false);
    expect(ops.chatDeltaSentAt.has(runId)).toBe(false);
    expect(ops.chatDeltaLastBroadcastLen.has(runId)).toBe(false);
    expect(ops.removeChatRun).toHaveBeenCalledWith(runId, runId, sessionKey);
    expect(ops.agentRunSeq.has(runId)).toBe(false);
    expect(ops.agentRunSeq.has("client-run-1")).toBe(false);

    expect(ops.broadcast).toHaveBeenCalledTimes(1);
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({
        runId,
        seq: 3,
        sessionKey,
        state: "aborted",
        stopReason: "user",
      }),
    );
    expect(payload.message).toEqual(
      expect.objectContaining({
        content: [{ text: "  Partial reply  ", type: "text" }],
        role: "assistant",
      }),
    );
    expect((payload.message as { timestamp?: unknown }).timestamp).toEqual(expect.any(Number));
    expect(ops.nodeSendToSession).toHaveBeenCalledWith(sessionKey, "chat", payload);
  });

  it("omits aborted message when buffered text is empty", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ buffer: "   ", entry, runId });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.message).toBeUndefined();
  });

  it("preserves partial message even when abort listeners clear buffers synchronously", () => {
    const runId = "run-1";
    const sessionKey = "main";
    const entry = createActiveEntry(sessionKey);
    const ops = createOps({ buffer: "streamed text", entry, runId });

    // Simulate synchronous cleanup triggered by AbortController listeners.
    entry.controller.signal.addEventListener("abort", () => {
      ops.chatRunBuffers.delete(runId);
    });

    const result = abortChatRunById(ops, { runId, sessionKey });

    expect(result).toEqual({ aborted: true });
    const payload = ops.broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.message).toEqual(
      expect.objectContaining({
        content: [{ text: "streamed text", type: "text" }],
        role: "assistant",
      }),
    );
  });
});
