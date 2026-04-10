import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";

describe("qa-bus state", () => {
  it("records inbound and outbound traffic in cursor order", () => {
    const state = createQaBusState();

    const inbound = state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "hello",
    });
    const outbound = state.addOutboundMessage({
      text: "hi",
      to: "dm:alice",
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.cursor).toBe(2);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "inbound-message",
      "outbound-message",
    ]);
    expect(snapshot.messages.map((message) => message.id)).toEqual([inbound.id, outbound.id]);
  });

  it("creates threads and mutates message state", async () => {
    const state = createQaBusState();

    const thread = state.createThread({
      conversationId: "qa-room",
      title: "QA thread",
    });
    const message = state.addOutboundMessage({
      text: "inside thread",
      threadId: thread.id,
      to: `thread:qa-room/${thread.id}`,
    });

    state.reactToMessage({
      emoji: "eyes",
      messageId: message.id,
      senderId: "alice",
    });
    state.editMessage({
      messageId: message.id,
      text: "inside thread (edited)",
    });
    state.deleteMessage({
      messageId: message.id,
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      conversationId: "qa-room",
      id: thread.id,
      title: "QA thread",
    });
    expect(snapshot.messages[0]).toMatchObject({
      deleted: true,
      id: message.id,
      reactions: [{ emoji: "eyes", senderId: "alice" }],
      text: "inside thread (edited)",
    });
  });

  it("waits for a text match and rejects on timeout", async () => {
    const state = createQaBusState();
    const pending = state.waitFor({
      kind: "message-text",
      textIncludes: "needle",
      timeoutMs: 500,
    });

    setTimeout(() => {
      state.addOutboundMessage({
        text: "haystack + needle",
        to: "dm:alice",
      });
    }, 20);

    const matched = await pending;
    expect("text" in matched && matched.text).toContain("needle");

    await expect(
      state.waitFor({
        kind: "message-text",
        textIncludes: "missing",
        timeoutMs: 20,
      }),
    ).rejects.toThrow("qa-bus wait timeout");
  });

  it("preserves inline attachments and lets search match attachment metadata", () => {
    const state = createQaBusState();

    const outbound = state.addOutboundMessage({
      attachments: [
        {
          altText: "QA dashboard screenshot",
          contentBase64: "aGVsbG8=",
          fileName: "qa-screenshot.png",
          id: "image-1",
          kind: "image",
          mimeType: "image/png",
        },
      ],
      text: "artifact attached",
      to: "dm:alice",
    });

    const readback = state.readMessage({ messageId: outbound.id });
    expect(readback.attachments).toHaveLength(1);
    expect(readback.attachments?.[0]).toMatchObject({
      altText: "QA dashboard screenshot",
      fileName: "qa-screenshot.png",
      kind: "image",
    });

    const byFilename = state.searchMessages({
      query: "screenshot",
    });
    expect(byFilename.some((message) => message.id === outbound.id)).toBe(true);

    const byAltText = state.searchMessages({
      query: "dashboard",
    });
    expect(byAltText.some((message) => message.id === outbound.id)).toBe(true);
  });
});
