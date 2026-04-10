import { describe, expect, it, vi } from "vitest";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";

describe("createChannelReplyPipeline", () => {
  it.each([
    {
      expectTypingCallbacks: false,
      input: {
        accountId: "default",
        agentId: "main",
        cfg: {},
        channel: "telegram",
      },
      name: "builds prefix options without forcing typing support",
    },
    {
      expectTypingCallbacks: true,
      input: {
        accountId: "default",
        agentId: "main",
        cfg: {},
        channel: "discord",
        typing: {
          onStartError: () => {},
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        },
      },
      name: "builds typing callbacks when typing config is provided",
    },
  ])("$name", async ({ input, expectTypingCallbacks }) => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const pipeline = createChannelReplyPipeline(
      expectTypingCallbacks
        ? {
            ...input,
            typing: {
              onStartError: () => {},
              start,
              stop,
            },
          }
        : input,
    );

    expect(typeof pipeline.onModelSelected).toBe("function");
    expect(typeof pipeline.responsePrefixContextProvider).toBe("function");

    if (!expectTypingCallbacks) {
      expect(pipeline.typingCallbacks).toBeUndefined();
      return;
    }

    await pipeline.typingCallbacks?.onReplyStart();
    pipeline.typingCallbacks?.onIdle?.();

    expect(start).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("preserves explicit typing callbacks when a channel needs custom lifecycle hooks", async () => {
    const onReplyStart = vi.fn(async () => {});
    const onIdle = vi.fn(() => {});
    const pipeline = createChannelReplyPipeline({
      agentId: "main",
      cfg: {},
      channel: "bluebubbles",
      typingCallbacks: {
        onIdle,
        onReplyStart,
      },
    });

    await pipeline.typingCallbacks?.onReplyStart();
    pipeline.typingCallbacks?.onIdle?.();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
