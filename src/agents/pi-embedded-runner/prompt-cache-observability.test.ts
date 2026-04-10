import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  collectPromptCacheToolNames,
  completePromptCacheObservation,
  resetPromptCacheObservabilityForTest,
} from "./prompt-cache-observability.js";

describe("prompt cache observability", () => {
  beforeEach(() => {
    resetPromptCacheObservabilityForTest();
  });

  it("collects trimmed tool names only", () => {
    expect(
      collectPromptCacheToolNames([{ name: " read " }, { name: "" }, {}, { name: "write" }]),
    ).toEqual(["read", "write"]);
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    const first = beginPromptCacheObservation({
      cacheRetention: "long",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      sessionKey: "agent:main",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
      transport: "sse",
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 8000 },
      }),
    ).toBeNull();

    const second = beginPromptCacheObservation({
      cacheRetention: "short",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      sessionKey: "agent:main",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system with hook change",
      toolNames: ["read", "write"],
      transport: "websocket",
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2000 },
      }),
    ).toEqual({
      cacheRead: 2000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
      previousCacheRead: 8000,
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      modelApi: "anthropic-messages",
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      sessionId: "session-1",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 5000 },
    });

    beginPromptCacheObservation({
      modelApi: "anthropic-messages",
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      sessionId: "session-1",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        usage: { cacheRead: 4600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    beginPromptCacheObservation({
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 8000 },
    });

    const second = beginPromptCacheObservation({
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["write", "read"],
    });

    expect(second.changes).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginPromptCacheObservation({
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-0",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-0",
      usage: { cacheRead: 8000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginPromptCacheObservation({
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        provider: "openai",
        sessionId: `session-${index}`,
        streamStrategy: "boundary-aware:openai-responses",
        systemPrompt: `stable system ${index}`,
        toolNames: ["read"],
      });
    }

    const restarted = beginPromptCacheObservation({
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-0",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginPromptCacheObservation({
      cacheRetention: "long",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      sessionKey: "agent:main",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
      transport: "sse",
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      usage: { cacheRead: 8000 },
    });

    beginPromptCacheObservation({
      cacheRetention: "short",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      sessionKey: "agent:main",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
      transport: "websocket",
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
      }),
    ).toBeNull();

    const resumed = beginPromptCacheObservation({
      cacheRetention: "short",
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "session-1",
      sessionKey: "agent:main",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
      transport: "websocket",
    });

    expect(resumed.previousCacheRead).toBe(8000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2000 },
      }),
    ).toEqual({
      cacheRead: 2000,
      changes: null,
      previousCacheRead: 8000,
    });
  });
});
