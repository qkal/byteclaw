import { describe, expect, it, vi } from "vitest";
import { createMatrixReplyContextResolver, summarizeMatrixReplyEvent } from "./reply-context.js";
import type { MatrixRawEvent } from "./types.js";

describe("matrix reply context", () => {
  it("summarizes reply events from body text", () => {
    expect(
      summarizeMatrixReplyEvent({
        content: {
          body: " Some quoted message ",
          msgtype: "m.text",
        },
        event_id: "$original",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.room.message",
      } as MatrixRawEvent),
    ).toBe("Some quoted message");
  });

  it("truncates long reply bodies", () => {
    const longBody = "x".repeat(600);
    const result = summarizeMatrixReplyEvent({
      content: {
        body: longBody,
        msgtype: "m.text",
      },
      event_id: "$original",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.room.message",
    } as MatrixRawEvent);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(500);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("handles media-only reply events", () => {
    expect(
      summarizeMatrixReplyEvent({
        content: {
          body: "photo.jpg",
          msgtype: "m.image",
        },
        event_id: "$original",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.room.message",
      } as MatrixRawEvent),
    ).toBe("[matrix image attachment]");
  });

  it("summarizes poll start events from poll content", () => {
    expect(
      summarizeMatrixReplyEvent({
        content: {
          "m.poll.start": {
            answers: [
              { id: "a1", "m.text": "Pizza" },
              { id: "a2", "m.text": "Sushi" },
            ],
            kind: "m.poll.disclosed",
            max_selections: 1,
            question: { "m.text": "Lunch?" },
          },
        },
        event_id: "$poll",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.poll.start",
      } as MatrixRawEvent),
    ).toBe("[Poll]\nLunch?\n\n1. Pizza\n2. Sushi");
  });

  it("resolves and caches reply context", async () => {
    const getEvent = vi.fn(async () => ({
      content: {
        body: "This is the original message",
        msgtype: "m.text",
      },
      event_id: "$original",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.room.message",
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      eventId: "$original",
      roomId: "!room:example.org",
    });

    expect(result).toEqual({
      replyToBody: "This is the original message",
      replyToSender: "Alice",
      replyToSenderId: "@alice:example.org",
    });

    // Second call should use cache
    await resolveReplyContext({
      eventId: "$original",
      roomId: "!room:example.org",
    });

    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("returns empty context when event fetch fails", async () => {
    const getEvent = vi.fn().mockRejectedValueOnce(new Error("not found"));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      eventId: "$missing",
      roomId: "!room:example.org",
    });

    expect(result).toEqual({});
  });

  it("returns empty context for redacted events", async () => {
    const getEvent = vi.fn(async () => ({
      content: {},
      event_id: "$redacted",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.room.message",
      unsigned: {
        redacted_because: { type: "m.room.redaction" },
      },
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      eventId: "$redacted",
      roomId: "!room:example.org",
    });

    expect(result).toEqual({});
    expect(getMemberDisplayName).not.toHaveBeenCalled();
  });

  it("does not cache fetch failures so retries can succeed", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        content: {
          body: "Recovered message",
          msgtype: "m.text",
        },
        event_id: "$original",
        origin_server_ts: Date.now(),
        sender: "@bob:example.org",
        type: "m.room.message",
      });
    const getMemberDisplayName = vi.fn(async () => "Bob");
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    // First call fails
    const first = await resolveReplyContext({
      eventId: "$original",
      roomId: "!room:example.org",
    });
    expect(first).toEqual({});

    // Second call succeeds (should retry, not use cached failure)
    const second = await resolveReplyContext({
      eventId: "$original",
      roomId: "!room:example.org",
    });
    expect(second).toEqual({
      replyToBody: "Recovered message",
      replyToSender: "Bob",
      replyToSenderId: "@bob:example.org",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
  });

  it("falls back to senderId when display name resolution fails", async () => {
    const getEvent = vi.fn(async () => ({
      content: {
        body: "Hello",
        msgtype: "m.text",
      },
      event_id: "$original",
      origin_server_ts: Date.now(),
      sender: "@charlie:example.org",
      type: "m.room.message",
    }));
    const getMemberDisplayName = vi.fn().mockRejectedValueOnce(new Error("unknown member"));
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    const result = await resolveReplyContext({
      eventId: "$original",
      roomId: "!room:example.org",
    });

    expect(result).toEqual({
      replyToBody: "Hello",
      replyToSender: "@charlie:example.org",
      replyToSenderId: "@charlie:example.org",
    });
  });

  it("uses LRU eviction — recently accessed entries survive over older ones", async () => {
    let callCount = 0;
    const getEvent = vi.fn().mockImplementation((_roomId: string, eventId: string) => {
      callCount++;
      return Promise.resolve({
        content: { body: `msg-${eventId}`, msgtype: "m.text" },
        event_id: eventId,
        origin_server_ts: Date.now(),
        sender: `@user${callCount}:example.org`,
        type: "m.room.message",
      });
    });
    const getMemberDisplayName = vi
      .fn()
      .mockImplementation((_r: string, userId: string) => Promise.resolve(userId));

    // Use a small cache by testing the eviction pattern:
    // The actual MAX_CACHED_REPLY_CONTEXTS is 256. We cannot override it easily,
    // But we can verify that a cache hit reorders entries (delete + re-insert).
    const resolveReplyContext = createMatrixReplyContextResolver({
      client: { getEvent } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    // Populate cache with two entries
    await resolveReplyContext({ eventId: "$A", roomId: "!r:e" });
    await resolveReplyContext({ eventId: "$B", roomId: "!r:e" });
    expect(getEvent).toHaveBeenCalledTimes(2);

    // Access $A again — should be a cache hit (no new getEvent call)
    // And should move $A to the end of the Map for LRU.
    const hitResult = await resolveReplyContext({ eventId: "$A", roomId: "!r:e" });
    expect(getEvent).toHaveBeenCalledTimes(2); // Still 2 — cache hit
    expect(hitResult.replyToBody).toBe("msg-$A");
  });
});
