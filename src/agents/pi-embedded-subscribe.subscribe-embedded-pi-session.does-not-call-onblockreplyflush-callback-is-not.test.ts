import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

interface StubSession {
  subscribe: (fn: (evt: unknown) => void) => () => void;
}

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("does not call onBlockReplyFlush when callback is not provided", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();

    // No onBlockReplyFlush provided
    subscribeEmbeddedPiSession({
      blockReplyBreak: "text_end",
      onBlockReply,
      runId: "run-no-flush",
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
    });

    // This should not throw even without onBlockReplyFlush
    expect(() => {
      handler?.({
        args: { command: "echo test" },
        toolCallId: "tool-no-flush",
        toolName: "bash",
        type: "tool_execution_start",
      });
    }).not.toThrow();
  });
});
