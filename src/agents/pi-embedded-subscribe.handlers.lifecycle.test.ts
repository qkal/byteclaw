import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void;
    onBlockReplyFlush?: () => void | Promise<void>;
  },
): EmbeddedPiSubscribeContext {
  const onBlockReply = vi.fn();
  return {
    emitBlockReply: onBlockReply,
    flushBlockReplyBuffer: vi.fn(),
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    maybeResolveCompactionWait: vi.fn(),
    params: {
      config: {},
      onAgentEvent: overrides?.onAgentEvent,
      onBlockReply,
      onBlockReplyFlush: overrides?.onBlockReplyFlush,
      runId: "run-1",
      sessionKey: "agent:main:main",
    },
    resolveCompactionRetry: vi.fn(),
    state: {
      blockState: {
        final: true,
        inlineCode: createInlineCodeState(),
        thinking: true,
      },
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      pendingToolAudioAsVoice: false,
      pendingToolMediaUrls: [],
    },
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd", () => {
  it("logs the resolved error message when run ends with assistant error", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        content: [{ text: "", type: "text" }],
        errorMessage: "connection refused",
        role: "assistant",
        stopReason: "error",
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("embedded run agent end");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=unknown provider=unknown error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
      error: "LLM request failed: connection refused by the provider endpoint.",
      event: "embedded_run_agent_end",
      rawErrorPreview: "connection refused",
      runId: "run-1",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      data: {
        error: "LLM request failed: connection refused by the provider endpoint.",
        phase: "error",
      },
      stream: "lifecycle",
    });
  });

  it("attaches raw provider error metadata and includes model/provider in console output", async () => {
    const ctx = createContext({
      content: [{ text: "", type: "text" }],
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      model: "claude-test",
      provider: "anthropic",
      role: "assistant",
      stopReason: "error",
    });

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("embedded run agent end");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      consoleMessage:
        'embedded run agent end: runId=run-1 isError=true model=claude-test provider=anthropic error=The AI service is temporarily overloaded. Please try again in a moment. rawError={"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      error: "The AI service is temporarily overloaded. Please try again in a moment.",
      event: "embedded_run_agent_end",
      failoverReason: "overloaded",
      providerErrorType: "overloaded_error",
      runId: "run-1",
    });
  });

  it("sanitizes model and provider before writing consoleMessage", async () => {
    const ctx = createContext({
      content: [{ text: "", type: "text" }],
      errorMessage: "connection refused",
      model: "claude\tsonnet\n4",
      provider: "anthropic\u001b]8;;https://evil.test\u0007",
      role: "assistant",
      stopReason: "error",
    });

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    const meta = warn.mock.calls[0]?.[1];
    expect(meta).toMatchObject({
      consoleMessage:
        "embedded run agent end: runId=run-1 isError=true model=claude sonnet 4 provider=anthropic]8;;https://evil.test error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    });
    expect(meta?.consoleMessage).not.toContain("\n");
    expect(meta?.consoleMessage).not.toContain("\r");
    expect(meta?.consoleMessage).not.toContain("\t");
    expect(meta?.consoleMessage).not.toContain("\u001b");
  });

  it("redacts logged error text before emitting lifecycle events", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        content: [{ text: "", type: "text" }],
        errorMessage: "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456",
        role: "assistant",
        stopReason: "error",
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      error: "x-api-key: ***",
      event: "embedded_run_agent_end",
      rawErrorPreview: "x-api-key: ***",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      data: {
        error: "x-api-key: ***",
        phase: "error",
      },
      stream: "lifecycle",
    });
  });

  it("keeps non-error run-end logging on debug only", async () => {
    const ctx = createContext(undefined);

    await handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  it("flushes orphaned tool media as a media-only block reply", async () => {
    const ctx = createContext(undefined);
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    expect(ctx.emitBlockReply).toHaveBeenCalledWith({
      audioAsVoice: true,
      mediaUrls: ["/tmp/reply.opus"],
    });
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(false);
  });

  it("resolves compaction wait before awaiting an async block reply flush", async () => {
    let resolveFlush: (() => void) | undefined;
    const ctx = createContext(undefined);
    ctx.flushBlockReplyBuffer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      )
      .mockImplementation(() => {});

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();

    resolveFlush?.();
    await endPromise;
  });

  it("resolves compaction wait before awaiting an async channel flush", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(undefined, { onBlockReplyFlush });

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    resolveChannelFlush?.();
    await endPromise;
  });
});
