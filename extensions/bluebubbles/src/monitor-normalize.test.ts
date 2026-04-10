import { describe, expect, it } from "vitest";
import { normalizeWebhookMessage, normalizeWebhookReaction } from "./monitor-normalize.js";

function createFallbackDmPayload(overrides: Record<string, unknown> = {}) {
  return {
    chatGuid: "iMessage;-;+15551234567",
    guid: "msg-1",
    handle: null,
    isFromMe: false,
    isGroup: false,
    ...overrides,
  };
}

describe("normalizeWebhookMessage", () => {
  it("falls back to DM chatGuid handle when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      data: createFallbackDmPayload({
        text: "hello",
      }),
      type: "new-message",
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.chatGuid).toBe("iMessage;-;+15551234567");
  });

  it("marks explicit sender handles as explicit identity", () => {
    const result = normalizeWebhookMessage({
      data: {
        chatGuid: "iMessage;-;+15551234567",
        guid: "msg-explicit-1",
        handle: { address: "+15551234567" },
        isFromMe: true,
        isGroup: false,
        text: "hello",
      },
      type: "new-message",
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(true);
  });

  it("does not infer sender from group chatGuid when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      data: {
        chatGuid: "iMessage;+;chat123456",
        guid: "msg-1",
        handle: null,
        isFromMe: false,
        isGroup: true,
        text: "hello group",
      },
      type: "new-message",
    });

    expect(result).toBeNull();
  });

  it("accepts array-wrapped payload data", () => {
    const result = normalizeWebhookMessage({
      data: [
        {
          guid: "msg-1",
          handle: { address: "+15551234567" },
          isFromMe: false,
          isGroup: false,
          text: "hello",
        },
      ],
      type: "new-message",
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
  });

  it("normalizes participant handles from the handles field", () => {
    const result = normalizeWebhookMessage({
      data: {
        chatGuid: "iMessage;+;chat123456",
        guid: "msg-handles-1",
        handle: { address: "+15550000000" },
        handles: [
          { address: "+15551234567", displayName: "Alice" },
          { address: "+15557654321", displayName: "Bob" },
        ],
        isFromMe: false,
        isGroup: true,
        text: "hello group",
      },
      type: "new-message",
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([
      { id: "+15551234567", name: "Alice" },
      { id: "+15557654321", name: "Bob" },
    ]);
  });

  it("normalizes participant handles from the participantHandles field", () => {
    const result = normalizeWebhookMessage({
      data: {
        chatGuid: "iMessage;+;chat123456",
        guid: "msg-participant-handles-1",
        handle: { address: "+15550000000" },
        isFromMe: false,
        isGroup: true,
        participantHandles: [{ address: "+15551234567" }, "+15557654321"],
        text: "hello group",
      },
      type: "new-message",
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([{ id: "+15551234567" }, { id: "+15557654321" }]);
  });
});

describe("normalizeWebhookReaction", () => {
  it("falls back to DM chatGuid handle when reaction sender handle is missing", () => {
    const result = normalizeWebhookReaction({
      data: createFallbackDmPayload({
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
        guid: "msg-2",
      }),
      type: "updated-message",
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.messageId).toBe("p:0/msg-1");
    expect(result?.action).toBe("added");
  });
});
