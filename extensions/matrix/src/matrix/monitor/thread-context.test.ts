import { describe, expect, it, vi } from "vitest";
import {
  createMatrixThreadContextResolver,
  summarizeMatrixThreadStarterEvent,
} from "./thread-context.js";
import type { MatrixRawEvent } from "./types.js";

describe("matrix thread context", () => {
  it("summarizes thread starter events from body text", () => {
    expect(
      summarizeMatrixThreadStarterEvent({
        content: {
          body: " Thread starter body ",
          msgtype: "m.text",
        },
        event_id: "$root",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.room.message",
      } as MatrixRawEvent),
    ).toBe("Thread starter body");
  });

  it("marks media-only thread starter events instead of returning bare filenames", () => {
    expect(
      summarizeMatrixThreadStarterEvent({
        content: {
          body: "photo.jpg",
          msgtype: "m.image",
        },
        event_id: "$root",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.room.message",
      } as MatrixRawEvent),
    ).toBe("[matrix image attachment]");
  });

  it("resolves and caches thread starter context", async () => {
    const getEvent = vi.fn(async () => ({
      content: {
        body: "Root topic",
        msgtype: "m.text",
      },
      event_id: "$root",
      origin_server_ts: Date.now(),
      sender: "@alice:example.org",
      type: "m.room.message",
    }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveThreadContext = createMatrixThreadContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      senderId: "@alice:example.org",
      senderLabel: "Alice",
      summary: "Root topic",
      threadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
    });

    await resolveThreadContext({
      roomId: "!room:example.org",
      threadRootId: "$root",
    });

    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("does not cache thread starter fetch failures", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({
        content: {
          body: "Recovered topic",
          msgtype: "m.text",
        },
        event_id: "$root",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.room.message",
      });
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveThreadContext = createMatrixThreadContextResolver({
      client: {
        getEvent,
      } as never,
      getMemberDisplayName,
      logVerboseMessage: () => {},
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      threadStarterBody: "Matrix thread root $root",
    });

    await expect(
      resolveThreadContext({
        roomId: "!room:example.org",
        threadRootId: "$root",
      }),
    ).resolves.toEqual({
      senderId: "@alice:example.org",
      senderLabel: "Alice",
      summary: "Recovered topic",
      threadStarterBody: "Matrix thread root $root from Alice:\nRecovered topic",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("summarizes poll start thread roots from poll content", () => {
    expect(
      summarizeMatrixThreadStarterEvent({
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
        event_id: "$root",
        origin_server_ts: Date.now(),
        sender: "@alice:example.org",
        type: "m.poll.start",
      } as MatrixRawEvent),
    ).toBe("[Poll]\nLunch?\n\n1. Pizza\n2. Sushi");
  });
});
