import { describe, expect, it, vi } from "vitest";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Minimal mock context factory. Only the fields needed for the media emission path.
function createMockContext(overrides?: {
  shouldEmitToolOutput?: boolean;
  onToolResult?: ReturnType<typeof vi.fn>;
  toolResultFormat?: "markdown" | "plain";
}): EmbeddedPiSubscribeContext {
  const onToolResult = overrides?.onToolResult ?? vi.fn();
  return {
    params: {
      onAgentEvent: vi.fn(),
      onToolResult,
      runId: "test-run",
      toolResultFormat: overrides?.toolResultFormat,
    },
    state: {
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      itemActiveIds: new Set(),
      itemCompletedCount: 0,
      itemStartedCount: 0,
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      pendingMessagingMediaUrls: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingTexts: new Map(),
      pendingToolAudioAsVoice: false,
      pendingToolMediaUrls: [],
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    shouldEmitToolResult: vi.fn(() => false),
    shouldEmitToolOutput: vi.fn(() => overrides?.shouldEmitToolOutput ?? false),
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    emitBlockReply: vi.fn(),
    hookRunner: undefined,
    // Fill in remaining required fields with no-ops.
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    stripBlockTags: vi.fn((t: string) => t),
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: vi.fn(() => null),
    consumePartialReplyDirectives: vi.fn(() => null),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getUsageTotals: vi.fn(() => undefined),
    getCompactionCount: vi.fn(() => 0),
  } as unknown as EmbeddedPiSubscribeContext;
}

async function emitPngMediaToolResult(
  ctx: EmbeddedPiSubscribeContext,
  opts?: { isError?: boolean },
) {
  await handleToolExecutionEnd(ctx, {
    isError: opts?.isError ?? false,
    result: {
      content: [
        { text: "MEDIA:/tmp/screenshot.png", type: "text" },
        { data: "base64", mimeType: "image/png", type: "image" },
      ],
      details: { path: "/tmp/screenshot.png" },
    },
    toolCallId: "tc-1",
    toolName: "browser",
    type: "tool_execution_end",
  });
}

async function emitUntrustedToolMediaResult(
  ctx: EmbeddedPiSubscribeContext,
  mediaPathOrUrl: string,
) {
  await handleToolExecutionEnd(ctx, {
    isError: false,
    result: {
      content: [{ text: `MEDIA:${mediaPathOrUrl}`, type: "text" }],
    },
    toolCallId: "tc-1",
    toolName: "plugin_tool",
    type: "tool_execution_end",
  });
}

async function emitMcpMediaToolResult(ctx: EmbeddedPiSubscribeContext, mediaPathOrUrl: string) {
  await handleToolExecutionEnd(ctx, {
    isError: false,
    result: {
      content: [{ text: `MEDIA:${mediaPathOrUrl}`, type: "text" }],
      details: {
        mcpServer: "probe",
        mcpTool: "browser",
      },
    },
    toolCallId: "tc-1",
    toolName: "browser",
    type: "tool_execution_end",
  });
}

describe("handleToolExecutionEnd media emission", () => {
  it("does not warn for read tool when path is provided via file_path alias", async () => {
    const ctx = createMockContext();

    await handleToolExecutionStart(ctx, {
      args: { file_path: "README.md" },
      toolCallId: "tc-1",
      toolName: "read",
      type: "tool_execution_start",
    });

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("emits media when verbose is off and tool result has MEDIA: path", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitPngMediaToolResult(ctx);

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/screenshot.png"]);
  });

  it("does NOT emit local media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitUntrustedToolMediaResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("emits remote media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitUntrustedToolMediaResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT emit local media for MCP-provenance results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitMcpMediaToolResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("emits remote media for MCP-provenance results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitMcpMediaToolResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT queue legacy MEDIA paths when verbose is full", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: true });

    await emitPngMediaToolResult(ctx);

    // OnToolResult should NOT be called by the new media path (emitToolOutput handles it).
    // It may be called by emitToolOutput, but the new block should not fire.
    // Verify emitToolOutput was called instead.
    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("still queues structured media when verbose is full", async () => {
    const ctx = createMockContext({ onToolResult: vi.fn(), shouldEmitToolOutput: true });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [{ text: "Generated audio reply.", type: "text" }],
        details: {
          media: {
            audioAsVoice: true,
            mediaUrl: "/tmp/reply.opus",
          },
        },
      },
      toolCallId: "tc-1",
      toolName: "tts",
      type: "tool_execution_end",
    });

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("does not queue structured media already emitted in plain verbose output", async () => {
    const ctx = createMockContext({
      onToolResult: vi.fn(),
      shouldEmitToolOutput: true,
      toolResultFormat: "plain",
    });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          {
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
            type: "text",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
      toolCallId: "tc-1",
      toolName: "image_generate",
      type: "tool_execution_end",
    });

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("still queues structured media for markdown verbose output", async () => {
    const ctx = createMockContext({
      onToolResult: vi.fn(),
      shouldEmitToolOutput: true,
      toolResultFormat: "markdown",
    });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          {
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
            type: "text",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
      toolCallId: "tc-1",
      toolName: "image_generate",
      type: "tool_execution_end",
    });

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/generated.png"]);
  });

  it("emits provider inventory output for compact video_generate list results", async () => {
    const ctx = createMockContext({
      onToolResult: vi.fn(),
      shouldEmitToolOutput: false,
      toolResultFormat: "plain",
    });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          {
            text: [
              "openai: default=sora-2 | models=sora-2",
              "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
            ].join("\n"),
            type: "text",
          },
        ],
        details: {
          providers: [
            { defaultModel: "sora-2", id: "openai", models: ["sora-2"] },
            {
              defaultModel: "veo-3.1-fast-generate-preview",
              id: "google",
              models: ["veo-3.1-fast-generate-preview"],
            },
          ],
        },
      },
      toolCallId: "tc-1",
      toolName: "video_generate",
      type: "tool_execution_end",
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "video_generate",
      undefined,
      [
        "openai: default=sora-2 | models=sora-2",
        "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
      ].join("\n"),
      expect.any(Object),
    );
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for error results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await emitPngMediaToolResult(ctx, { isError: true });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit when tool result has no media", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [{ text: "Command executed successfully", type: "text" }],
      },
      toolCallId: "tc-1",
      toolName: "bash",
      type: "tool_execution_end",
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for <media:audio> placeholder text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          {
            text: "<media:audio> placeholder with successful preflight voice transcript",
            type: "text",
          },
        ],
      },
      toolCallId: "tc-1",
      toolName: "tts",
      type: "tool_execution_end",
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for malformed MEDIA:-prefixed prose", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          {
            text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
            type: "text",
          },
        ],
      },
      toolCallId: "tc-1",
      toolName: "browser",
      type: "tool_execution_end",
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("queues media from details.path fallback when no MEDIA: text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ onToolResult, shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        content: [
          { text: "Rendered canvas", type: "text" },
          { data: "base64", mimeType: "image/png", type: "image" },
        ],
        details: { path: "/tmp/canvas-output.png" },
      },
      toolCallId: "tc-1",
      toolName: "canvas",
      type: "tool_execution_end",
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/canvas-output.png"]);
  });

  it("queues structured details.media and voice metadata", async () => {
    const ctx = createMockContext({ onToolResult: vi.fn(), shouldEmitToolOutput: false });

    await handleToolExecutionEnd(ctx, {
      isError: false,
      result: {
        details: {
          media: {
            audioAsVoice: true,
            mediaUrl: "/tmp/reply.opus",
          },
        },
      },
      toolCallId: "tc-1",
      toolName: "tts",
      type: "tool_execution_end",
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });
});
