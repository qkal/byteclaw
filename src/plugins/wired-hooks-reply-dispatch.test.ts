import { describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const replyDispatchEvent = {
  ctx: buildTestCtx({ BodyForAgent: "hello", SessionKey: "agent:test:session" }),
  inboundAudio: false,
  sendPolicy: "allow" as const,
  sessionKey: "agent:test:session",
  shouldRouteToOriginating: false,
  shouldSendToolSummaries: true,
};

const replyDispatchCtx = {
  cfg: {},
  dispatcher: {
    getFailedCounts: () => ({ block: 0, final: 0, tool: 0 }),
    getQueuedCounts: () => ({ block: 0, final: 0, tool: 0 }),
    markComplete: () => {},
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    sendToolResult: () => false,
    waitForIdle: async () => {},
  },
  markIdle: () => {},
  recordProcessed: () => {},
};

describe("reply_dispatch hook runner", () => {
  it("stops at the first handler that claims reply dispatch", async () => {
    const first = vi.fn().mockResolvedValue({
      counts: { block: 1, final: 1, tool: 0 },
      handled: true,
      queuedFinal: true,
    });
    const second = vi.fn().mockResolvedValue({
      counts: { block: 0, final: 0, tool: 0 },
      handled: true,
      queuedFinal: false,
    });
    const { runner } = createHookRunnerWithRegistry([
      { handler: first, hookName: "reply_dispatch" },
      { handler: second, hookName: "reply_dispatch" },
    ]);

    const result = await runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);

    expect(result).toEqual({
      counts: { block: 1, final: 1, tool: 0 },
      handled: true,
      queuedFinal: true,
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({
      counts: { block: 0, final: 0, tool: 1 },
      handled: true,
      queuedFinal: false,
    });
    const { runner } = createHookRunnerWithRegistry(
      [
        { handler: failing, hookName: "reply_dispatch" },
        { handler: succeeding, hookName: "reply_dispatch" },
      ],
      { logger },
    );

    const result = await runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);

    expect(result).toEqual({
      counts: { block: 0, final: 0, tool: 1 },
      handled: true,
      queuedFinal: false,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reply_dispatch handler from test-plugin failed: Error: boom"),
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
