import { describe, expect, it, vi } from "vitest";
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "./draft-stream-controls.js";

describe("draft-stream-controls", () => {
  it("takeMessageIdAfterStop stops, reads, and clears message id", async () => {
    const events: string[] = [];
    let messageId: string | undefined = "m-1";

    const result = await takeMessageIdAfterStop({
      clearMessageId: () => {
        events.push("clear");
        messageId = undefined;
      },
      readMessageId: () => {
        events.push("read");
        return messageId;
      },
      stopForClear: async () => {
        events.push("stop");
      },
    });

    expect(result).toBe("m-1");
    expect(messageId).toBeUndefined();
    expect(events).toEqual(["stop", "read", "clear"]);
  });

  it("clearFinalizableDraftMessage deletes valid message ids", async () => {
    const deleteMessage = vi.fn(async () => {});
    const onDeleteSuccess = vi.fn();

    await clearFinalizableDraftMessage({
      clearMessageId: () => {},
      deleteMessage,
      isValidMessageId: (value): value is string => typeof value === "string",
      onDeleteSuccess,
      readMessageId: () => "m-2",
      stopForClear: async () => {},
      warnPrefix: "cleanup failed",
    });

    expect(deleteMessage).toHaveBeenCalledWith("m-2");
    expect(onDeleteSuccess).toHaveBeenCalledWith("m-2");
  });

  it("clearFinalizableDraftMessage skips invalid message ids", async () => {
    const deleteMessage = vi.fn(async () => {});

    await clearFinalizableDraftMessage<unknown>({
      clearMessageId: () => {},
      deleteMessage,
      isValidMessageId: (value): value is string => typeof value === "string",
      readMessageId: () => 123,
      stopForClear: async () => {},
      warnPrefix: "cleanup failed",
    });

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("clearFinalizableDraftMessage warns when delete fails", async () => {
    const warn = vi.fn();

    await clearFinalizableDraftMessage({
      clearMessageId: () => {},
      deleteMessage: async () => {
        throw new Error("boom");
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      readMessageId: () => "m-3",
      stopForClear: async () => {},
      warn,
      warnPrefix: "cleanup failed",
    });

    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");
  });

  it("controls ignore updates after final", async () => {
    const sendOrEditStreamMessage = vi.fn(async () => true);
    const controls = createFinalizableDraftStreamControlsForState({
      sendOrEditStreamMessage,
      state: { final: true, stopped: false },
      throttleMs: 250,
    });

    controls.update("ignored");
    await controls.loop.flush();

    expect(sendOrEditStreamMessage).not.toHaveBeenCalled();
  });

  it("lifecycle clear marks stopped, clears id, and deletes preview message", async () => {
    const state = { final: false, stopped: false };
    let messageId: string | undefined = "m-4";
    const deleteMessage = vi.fn(async () => {});

    const lifecycle = createFinalizableDraftLifecycle({
      clearMessageId: () => {
        messageId = undefined;
      },
      deleteMessage,
      isValidMessageId: (value): value is string => typeof value === "string",
      readMessageId: () => messageId,
      sendOrEditStreamMessage: async () => true,
      state,
      throttleMs: 250,
      warnPrefix: "cleanup failed",
    });

    await lifecycle.clear();

    expect(state.stopped).toBe(true);
    expect(messageId).toBeUndefined();
    expect(deleteMessage).toHaveBeenCalledWith("m-4");
  });
});
