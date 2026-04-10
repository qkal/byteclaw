import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
} from "./pi-embedded-subscribe.e2e-harness.js";

const waitForAsyncCallbacks = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("subscribeEmbeddedPiSession block reply rejections", () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    unhandledRejections.length = 0;
  });

  it("contains rejected async text_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      blockReplyBreak: "text_end",
      onBlockReply,
      runId: "run",
    });

    emitAssistantTextDelta({ delta: "Hello block", emit });
    emitAssistantTextEnd({ emit });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it("contains rejected async message_end block replies", async () => {
    process.on("unhandledRejection", onUnhandledRejection);
    const onBlockReply = vi.fn().mockRejectedValue(new Error("boom"));
    const { emit } = createSubscribedSessionHarness({
      blockReplyBreak: "message_end",
      onBlockReply,
      runId: "run",
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "Hello block" });
    await waitForAsyncCallbacks();

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toHaveLength(0);
  });
});
