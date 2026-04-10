import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import {
  buildAssistantStreamData,
  consumePendingToolMediaIntoReply,
  consumePendingToolMediaReply,
  handleMessageEnd,
  handleMessageUpdate,
  hasAssistantVisibleReply,
  resolveSilentReplyFallbackText,
} from "./pi-embedded-subscribe.handlers.messages.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./pi-embedded-subscribe.openai-responses.test-helpers.js";

function createMessageUpdateContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onPartialReply?: ReturnType<typeof vi.fn>;
    flushBlockReplyBuffer?: ReturnType<typeof vi.fn>;
    debug?: ReturnType<typeof vi.fn>;
    shouldEmitPartialReplies?: boolean;
  } = {},
) {
  return {
    consumePartialReplyDirectives: vi.fn(() => null),
    emitReasoningStream: vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    log: { debug: params.debug ?? vi.fn() },
    noteLastAssistant: vi.fn(),
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    state: {
      assistantMessageIndex: 0,
      blockBuffer: "",
      blockReplyBreak: "text_end",
      deltaBuffer: "",
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      emittedAssistantUpdate: false,
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      partialBlockState: {
        final: false,
        inlineCode: createInlineCodeState(),
        thinking: false,
      },
      reasoningStreamOpen: false,
      shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
      streamReasoning: false,
    },
    stripBlockTags: (text: string) => text,
  } as unknown as EmbeddedPiSubscribeContext;
}

function createMessageEndContext(
  params: {
    onAgentEvent?: ReturnType<typeof vi.fn>;
    onBlockReply?: ReturnType<typeof vi.fn>;
    emitBlockReply?: ReturnType<typeof vi.fn>;
    finalizeAssistantTexts?: ReturnType<typeof vi.fn>;
    consumeReplyDirectives?: ReturnType<typeof vi.fn>;
    state?: Record<string, unknown>;
  } = {},
) {
  return {
    blockChunker: null,
    consumeReplyDirectives: params.consumeReplyDirectives ?? vi.fn(() => ({ text: "Need send." })),
    emitBlockReply: params.emitBlockReply ?? vi.fn(),
    emitReasoningStream: vi.fn(),
    finalizeAssistantTexts: params.finalizeAssistantTexts ?? vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    log: { debug: vi.fn(), warn: vi.fn() },
    noteLastAssistant: vi.fn(),
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
      ...(params.onBlockReply ? { onBlockReply: params.onBlockReply } : { onBlockReply: vi.fn() }),
    },
    recordAssistantUsage: vi.fn(),
    state: {
      assistantTextBaseline: 0,
      assistantTexts: [],
      blockBuffer: "Need send.",
      blockReplyBreak: "message_end",
      blockState: {
        final: false,
        inlineCode: createInlineCodeState(),
        thinking: false,
      },
      deltaBuffer: "Need send.",
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      emittedAssistantUpdate: false,
      includeReasoning: false,
      lastReasoningSent: undefined,
      lastStreamedAssistant: undefined,
      lastStreamedAssistantCleaned: undefined,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      reasoningStreamOpen: false,
      streamReasoning: false,
      ...params.state,
    },
    stripBlockTags: (text: string) => text,
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("resolveSilentReplyFallbackText", () => {
  it("replaces NO_REPLY with latest messaging tool text when available", () => {
    expect(
      resolveSilentReplyFallbackText({
        messagingToolSentTexts: ["first", "final delivered text"],
        text: "NO_REPLY",
      }),
    ).toBe("final delivered text");
  });

  it("keeps original text when response is not NO_REPLY", () => {
    expect(
      resolveSilentReplyFallbackText({
        messagingToolSentTexts: ["final delivered text"],
        text: "normal assistant reply",
      }),
    ).toBe("normal assistant reply");
  });

  it("keeps NO_REPLY when there is no messaging tool text to mirror", () => {
    expect(
      resolveSilentReplyFallbackText({
        messagingToolSentTexts: [],
        text: "NO_REPLY",
      }),
    ).toBe("NO_REPLY");
  });

  it("tolerates malformed text payloads without throwing", () => {
    expect(
      resolveSilentReplyFallbackText({
        messagingToolSentTexts: ["final delivered text"],
        text: undefined,
      }),
    ).toBe("");
    expect(
      resolveSilentReplyFallbackText({
        messagingToolSentTexts: [42 as unknown as string],
        text: "NO_REPLY",
      }),
    ).toBe("42");
  });
});

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("buildAssistantStreamData", () => {
  it("normalizes media payloads for assistant stream events", () => {
    expect(
      buildAssistantStreamData({
        delta: "he",
        mediaUrl: "https://example.com/a.png",
        replace: true,
        text: "hello",
      }),
    ).toEqual({
      delta: "he",
      mediaUrls: ["https://example.com/a.png"],
      replace: true,
      text: "hello",
    });
  });
});

describe("consumePendingToolMediaIntoReply", () => {
  it("attaches queued tool media to the next assistant reply", () => {
    const state = {
      pendingToolAudioAsVoice: false,
      pendingToolMediaUrls: ["/tmp/a.png", "/tmp/b.png"],
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        text: "done",
      }),
    ).toEqual({
      audioAsVoice: undefined,
      mediaUrls: ["/tmp/a.png", "/tmp/b.png"],
      text: "done",
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
  });

  it("preserves reasoning replies without consuming queued media", () => {
    const state = {
      pendingToolAudioAsVoice: true,
      pendingToolMediaUrls: ["/tmp/a.png"],
    };

    expect(
      consumePendingToolMediaIntoReply(state, {
        isReasoning: true,
        text: "thinking",
      }),
    ).toEqual({
      isReasoning: true,
      text: "thinking",
    });
    expect(state.pendingToolMediaUrls).toEqual(["/tmp/a.png"]);
    expect(state.pendingToolAudioAsVoice).toBe(true);
  });
});

describe("consumePendingToolMediaReply", () => {
  it("builds a media-only reply for orphaned tool media", () => {
    const state = {
      pendingToolAudioAsVoice: true,
      pendingToolMediaUrls: ["/tmp/reply.opus"],
    };

    expect(consumePendingToolMediaReply(state)).toEqual({
      audioAsVoice: true,
      mediaUrls: ["/tmp/reply.opus"],
    });
    expect(state.pendingToolMediaUrls).toEqual([]);
    expect(state.pendingToolAudioAsVoice).toBe(false);
  });
});

describe("handleMessageUpdate", () => {
  it("suppresses commentary-phase partial delivery and text_end flush", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const ctx = createMessageUpdateContext({
      flushBlockReplyBuffer,
      onAgentEvent,
      onPartialReply,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ messagePhase: "commentary", text: "Need send.", type: "text_delta" }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({ messagePhase: "commentary", text: "Need send.", type: "text_end" }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
  });

  it("suppresses commentary partials when phase exists only in textSignature metadata", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const flushBlockReplyBuffer = vi.fn();
    const commentaryBlock = createOpenAiResponsesTextBlock({
      id: "msg_sig",
      phase: "commentary",
      text: "Need send.",
    });
    const ctx = createMessageUpdateContext({
      flushBlockReplyBuffer,
      onAgentEvent,
      onPartialReply,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        content: [commentaryBlock],
        text: "Need send.",
        type: "text_delta",
      }),
    );
    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        content: [commentaryBlock],
        text: "Need send.",
        type: "text_end",
      }),
    );

    await Promise.resolve();

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");
  });

  it("suppresses commentary partials even when they contain visible text", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageUpdateContext({
      onAgentEvent,
      shouldEmitPartialReplies: false,
    });

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        partial: createOpenAiResponsesPartial({
          id: "item_commentary",
          partialPhase: "commentary",
          signaturePhase: "commentary",
          text: "Working...",
        }),
        text: "Working...",
        type: "text_delta",
      }),
    );

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(ctx.state.deltaBuffer).toBe("");
    expect(ctx.state.blockBuffer).toBe("");

    handleMessageUpdate(
      ctx,
      createTextUpdateEvent({
        partial: createOpenAiResponsesPartial({
          id: "item_final",
          partialPhase: "final_answer",
          signaturePhase: "final_answer",
          text: "Done.",
        }),
        text: "Done.",
        type: "text_delta",
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      data: {
        delta: "Done.",
        text: "Done.",
      },
      stream: "assistant",
    });
  });

  it("contains synchronous text_end flush failures", async () => {
    const debug = vi.fn();
    const ctx = createMessageUpdateContext({
      debug,
      flushBlockReplyBuffer: vi.fn(() => {
        throw new Error("boom");
      }),
      shouldEmitPartialReplies: false,
    });

    handleMessageUpdate(ctx, createTextUpdateEvent({ text: "", type: "text_end" }));

    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith("text_end block reply flush failed: Error: boom");
    });
  });
});

describe("handleMessageEnd", () => {
  it("suppresses commentary-phase replies from user-visible output", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      onAgentEvent,
    });

    void handleMessageEnd(ctx, {
      message: {
        content: [{ text: "Need send.", type: "text" }],
        phase: "commentary",
        role: "assistant",
        usage: { input: 1, output: 1, total: 2 },
      },
      type: "message_end",
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("suppresses commentary message_end when phase exists only in textSignature metadata", () => {
    const onAgentEvent = vi.fn();
    const emitBlockReply = vi.fn();
    const finalizeAssistantTexts = vi.fn();
    const ctx = createMessageEndContext({
      emitBlockReply,
      finalizeAssistantTexts,
      onAgentEvent,
    });

    void handleMessageEnd(ctx, {
      message: {
        content: [
          createOpenAiResponsesTextBlock({
            id: "msg_sig",
            phase: "commentary",
            text: "Need send.",
          }),
        ],
        role: "assistant",
        usage: { input: 1, output: 1, total: 2 },
      },
      type: "message_end",
    } as never);

    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitBlockReply).not.toHaveBeenCalled();
    expect(finalizeAssistantTexts).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels when text was already delivered", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // In real usage, the directive accumulator returns null for empty/consumed
    // Input. The non-empty call shouldn't happen for text_end channels (that's
    // The safety send we're guarding against).
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      consumeReplyDirectives,
      emitBlockReply,
      onBlockReply,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // Simulate text_end already delivered this text through emitBlockChunk
        lastBlockReplyText: "Hello world",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      message: {
        content: [{ text: "Hello world", type: "text" }],
        role: "assistant",
        usage: { input: 10, output: 5, total: 15 },
      },
      type: "message_end",
    } as never);

    // The block reply should NOT fire again since text_end already delivered it.
    // ConsumeReplyDirectives is called once with "" (the final flush for
    // Text_end channels) but returns null, so emitBlockReply is never called.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("does not duplicate block reply for text_end channels even when stripping differs", () => {
    const onBlockReply = vi.fn();
    const emitBlockReply = vi.fn();
    // Same pattern: directive accumulator returns null for empty final flush
    const consumeReplyDirectives = vi.fn((text: string) => (text ? { text } : null));
    const ctx = createMessageEndContext({
      consumeReplyDirectives,
      emitBlockReply,
      onBlockReply,
      state: {
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Hello world",
        blockReplyBreak: "text_end",
        // Text_end delivered via emitBlockChunk which uses different stripping
        lastBlockReplyText: "Hello world.",
        deltaBuffer: "",
        blockBuffer: "",
      },
    });

    void handleMessageEnd(ctx, {
      message: {
        role: "assistant",
        // The raw text differs slightly from lastBlockReplyText due to stripping
        content: [{ text: "Hello world", type: "text" }],
        usage: { input: 10, output: 5, total: 15 },
      },
      type: "message_end",
    } as never);

    // Even though text !== lastBlockReplyText (different stripping), the safety
    // Send should NOT fire for text_end channels. The only consumeReplyDirectives
    // Call is the final empty flush which returns null.
    expect(emitBlockReply).not.toHaveBeenCalled();
  });

  it("emits a replacement final assistant event when final_answer appears only at message_end", () => {
    const onAgentEvent = vi.fn();
    const ctx = createMessageEndContext({
      onAgentEvent,
      state: {
        blockBuffer: "",
        blockReplyBreak: "text_end",
        deltaBuffer: "",
        emittedAssistantUpdate: true,
        lastStreamedAssistantCleaned: "Working...",
      },
    });

    void handleMessageEnd(ctx, {
      message: {
        api: "openai-responses",
        content: [
          createOpenAiResponsesTextBlock({
            id: "item_commentary",
            phase: "commentary",
            text: "Working...",
          }),
          createOpenAiResponsesTextBlock({
            id: "item_final",
            phase: "final_answer",
            text: "Done.",
          }),
        ],
        model: "gpt-5.2",
        provider: "openai",
        role: "assistant",
        stopReason: "stop",
        timestamp: 0,
        usage: {},
      },
      type: "message_end",
    } as never);

    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({
      data: {
        delta: "",
        replace: true,
        text: "Done.",
      },
      stream: "assistant",
    });
  });
});
