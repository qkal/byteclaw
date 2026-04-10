import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./pi-embedded-subscribe.compaction-test-helpers.js";
import { createEmbeddedPiSessionEventHandler } from "./pi-embedded-subscribe.handlers.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

function createLifecycleContext(params: {
  storePath: string;
  sessionKey: string;
  initialCount: number;
  agentId?: string;
}): EmbeddedPiSubscribeContext {
  let compactionCount = params.initialCount;
  return {
    blockChunker: null,
    consumePartialReplyDirectives: vi.fn(),
    consumeReplyDirectives: vi.fn(),
    emitBlockChunk: vi.fn(),
    emitReasoningStream: vi.fn(),
    emitToolOutput: vi.fn(),
    emitToolSummary: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    getCompactionCount: () => compactionCount,
    getUsageTotals: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    maybeResolveCompactionWait: vi.fn(),
    noteCompactionRetry: vi.fn(),
    noteLastAssistant: vi.fn(),
    params: {
      agentId: params.agentId ?? "test-agent",
      config: { session: { store: params.storePath } } as never,
      onAgentEvent: undefined,
      runId: "run-lifecycle-test",
      session: { messages: [] } as never,
      sessionId: "session-1",
      sessionKey: params.sessionKey,
    },
    recordAssistantUsage: vi.fn(),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    shouldEmitToolOutput: () => false,
    shouldEmitToolResult: () => false,
    state: {
      assistantMessageIndex: 0,
      assistantTextBaseline: 0,
      assistantTexts: [],
      blockBuffer: "",
      blockState: { final: false, inlineCode: {} as never, thinking: false },
      compactionInFlight: false,
      compactionRetryPromise: null,
      deltaBuffer: "",
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
      emittedAssistantUpdate: false,
      includeReasoning: false,
      lastAssistantTextMessageIndex: -1,
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      partialBlockState: { final: false, inlineCode: {} as never, thinking: false },
      pendingCompactionRetry: 0,
      pendingMessagingMediaUrls: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingTexts: new Map(),
      reasoningMode: "off",
      shouldEmitPartialReplies: true,
      streamReasoning: false,
      successfulCronAdds: 0,
      suppressBlockChunks: false,
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      unsubscribed: false,
    } as never,
    stripBlockTags: vi.fn((text: string) => text),
    trimMessagingToolSent: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("createEmbeddedPiSessionEventHandler compaction reconciliation", () => {
  it("reconciles sessions.json on routed auto_compaction_end success", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lifecycle-compaction-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      compactionCount: 1,
      sessionKey,
      storePath,
    });

    const ctx = createLifecycleContext({
      initialCount: 1,
      sessionKey,
      storePath,
    });
    const handleEvent = createEmbeddedPiSessionEventHandler(ctx);

    handleEvent({ type: "auto_compaction_start" });
    expect(ctx.state.compactionInFlight).toBe(true);

    handleEvent({
      aborted: false,
      result: { kept: 12 },
      type: "auto_compaction_end",
      willRetry: false,
    });

    await waitForCompactionCount({
      expected: 2,
      sessionKey,
      storePath,
    });

    expect(ctx.getCompactionCount()).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });
});
