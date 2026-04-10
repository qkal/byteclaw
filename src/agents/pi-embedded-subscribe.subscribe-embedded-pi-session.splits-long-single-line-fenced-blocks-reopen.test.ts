import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
} from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("splits long single-line fenced blocks with reopen/close", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      chunking: {
        maxChars: 40,
        minChars: 10,
      },
      onBlockReply,
    });

    const text = `\`\`\`json\n${"x".repeat(120)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();
    expectFencedChunks(onBlockReply.mock.calls, "```json");
  });
  it("waits for auto-compaction retry and clears buffered text", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        };
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      runId: "run-1",
      session,
    });

    const assistantMessage = {
      content: [{ text: "oops", type: "text" }],
      role: "assistant",
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ message: assistantMessage, type: "message_end" });
    }

    expect(subscription.assistantTexts.length).toBe(1);

    for (const listener of listeners) {
      listener({
        type: "auto_compaction_end",
        willRetry: true,
      });
    }

    expect(subscription.isCompacting()).toBe(true);
    expect(subscription.assistantTexts.length).toBe(0);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });
  it("resolves after compaction ends without retry", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    const subscription = subscribeEmbeddedPiSession({
      runId: "run-2",
      session,
    });

    for (const listener of listeners) {
      listener({ type: "auto_compaction_start" });
    }

    expect(subscription.isCompacting()).toBe(true);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: false });
    }

    await waitPromise;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("resets assistant usage to a zero snapshot after compaction without retry", () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      messages: [
        {
          content: [{ text: "old", type: "text" }],
          role: "assistant",
          usage: {
            cacheRead: 5,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0.001, output: 0.002, total: 0.003 },
            input: 120,
            output: 30,
            totalTokens: 155,
          },
        },
      ],
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"];

    subscribeEmbeddedPiSession({
      runId: "run-3",
      session,
    });

    for (const listener of listeners) {
      listener({ type: "auto_compaction_end", willRetry: false });
    }

    const usage = (session.messages?.[0] as { usage?: unknown } | undefined)?.usage;
    expect(usage).toEqual(makeZeroUsageSnapshot());
  });
});
