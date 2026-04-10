import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

describe("createMatrixRoomMessageHandler inbound body formatting", () => {
  type MatrixHandlerHarness = ReturnType<typeof createMatrixHandlerTestHarness>;
  interface FinalizedReplyContext {
    ReplyToBody?: string;
    ReplyToSender?: string;
    ThreadStarterBody?: string;
  }

  function createQuotedReplyVisibilityHarness(contextVisibility: "allowlist" | "allowlist_quote") {
    return createMatrixHandlerTestHarness({
      cfg: {
        channels: {
          matrix: {
            contextVisibility,
          },
        },
      },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "Quoted payload",
            eventId: "$quoted",
            sender: "@mallory:example.org",
          }),
      },
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@alice:example.org" ? "Alice" : "Mallory",
      groupAllowFrom: ["@alice:example.org"],
      groupPolicy: "allowlist",
      isDirectMessage: false,
      replyToMode: "all",
      roomsConfig: { "*": {} },
    });
  }

  async function sendQuotedReply(handler: MatrixHandlerHarness["handler"]) {
    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          "m.in_reply_to": { event_id: "$quoted" },
        },
        sender: "@alice:example.org",
      }),
    );
  }

  function latestFinalizedReplyContext(
    finalizeInboundContext: MatrixHandlerHarness["finalizeInboundContext"],
  ) {
    return vi.mocked(finalizeInboundContext).mock.calls.at(-1)?.[0] as FinalizedReplyContext;
  }

  beforeEach(() => {
    installMatrixMonitorTestRuntime({
      matchesMentionPatterns: () => false,
      saveMediaBuffer: vi.fn(),
    });
  });

  it("records thread metadata for group thread messages", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              body: "Root topic",
              eventId: "$thread-root",
              sender: "@alice:example.org",
            }),
        },
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
        isDirectMessage: false,
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ThreadStarterBody: "Matrix thread root $thread-root from Alice:\nRoot topic",
      }),
    );
    // Thread messages get thread-scoped session keys (thread isolation feature).
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main:thread:$thread-root",
      }),
    );
  });

  it("starts the thread-scoped session from the triggering message when threadReplies is always", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        isDirectMessage: false,
        threadReplies: "always",
      });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room start thread",
        eventId: "$thread-root",
        mentions: { room: true },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ReplyToId: undefined,
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main:thread:$thread-root",
      }),
    );
  });

  it("records formatted poll results for inbound poll response events", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () => ({
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
            origin_server_ts: 1,
            sender: "@bot:example.org",
            type: "m.poll.start",
          }),
          getRelations: async () => ({
            events: [
              {
                content: {
                  "m.poll.response": { answers: ["a1"] },
                  "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
                },
                event_id: "$vote1",
                origin_server_ts: 2,
                sender: "@user:example.org",
                type: "m.poll.response",
              },
            ],
            nextBatch: null,
            prevBatch: null,
          }),
        } as unknown as Partial<MatrixClient>,
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@bot:example.org" ? "Bot" : "sender",
        isDirectMessage: true,
      });

    await handler("!room:example.org", {
      content: {
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
      },
      event_id: "$vote1",
      origin_server_ts: 2,
      sender: "@user:example.org",
      type: "m.poll.response",
    } as MatrixRawEvent);

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        RawBody: expect.stringMatching(/1\. Pizza \(1 vote\)[\s\S]*Total voters: 1/),
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("records reply context for quoted poll start events inside always-threaded replies", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async (_roomId: string, eventId: string) => {
          if (eventId === "$thread-root") {
            return createMatrixTextMessageEvent({
              body: "Root topic",
              eventId: "$thread-root",
              sender: "@bob:example.org",
            });
          }

          return {
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
            origin_server_ts: 1,
            sender: "@alice:example.org",
            type: "m.poll.start",
          } satisfies MatrixRawEvent;
        },
      } as unknown as Partial<MatrixClient>,
      getMemberDisplayName: async (_roomId, userId) => {
        if (userId === "@alice:example.org") {
          return "Alice";
        }
        if (userId === "@bob:example.org") {
          return "Bob";
        }
        return "sender";
      },
      isDirectMessage: false,
      threadReplies: "always",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$poll" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ReplyToBody: "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
        ReplyToId: undefined,
        ReplyToSender: "Alice",
        ThreadStarterBody: "Matrix thread root $thread-root from Bob:\nRoot topic",
      }),
    );
  });

  it("reuses the fetched thread root when reply context points at the same event", async () => {
    const getEvent = vi.fn(async () =>
      createMatrixTextMessageEvent({
        body: "Root topic",
        eventId: "$thread-root",
        sender: "@alice:example.org",
      }),
    );
    const getMemberDisplayName = vi.fn(async (_roomId: string, userId: string) =>
      userId === "@alice:example.org" ? "Alice" : "sender",
    );
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      client: { getEvent },
      getMemberDisplayName,
      isDirectMessage: false,
      threadReplies: "always",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$thread-root",
        ReplyToBody: "Root topic",
        ReplyToId: undefined,
        ReplyToSender: "Alice",
        ThreadStarterBody: "Matrix thread root $thread-root from Alice:\nRoot topic",
      }),
    );
    expect(getEvent).toHaveBeenCalledTimes(1);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(2);
  });

  it("drops thread and reply context fetched from non-allowlisted room senders", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      cfg: {
        channels: {
          matrix: {
            contextVisibility: "allowlist",
          },
        },
      },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "Malicious root topic",
            eventId: "$thread-root",
            sender: "@mallory:example.org",
          }),
      },
      getMemberDisplayName: async (_roomId, userId) =>
        userId === "@alice:example.org" ? "Alice" : "Mallory",
      groupAllowFrom: ["@alice:example.org"],
      groupPolicy: "allowlist",
      isDirectMessage: false,
      roomsConfig: { "*": {} },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          event_id: "$thread-root",
          "m.in_reply_to": { event_id: "$thread-root" },
          rel_type: "m.thread",
        },
        sender: "@alice:example.org",
      }),
    );

    const finalized = vi.mocked(finalizeInboundContext).mock.calls.at(-1)?.[0] as {
      ReplyToBody?: string;
      ReplyToSender?: string;
      ThreadStarterBody?: string;
    };
    expect(finalized.ThreadStarterBody).toBeUndefined();
    expect(finalized.ReplyToBody).toBeUndefined();
    expect(finalized.ReplyToSender).toBeUndefined();
  });

  it("drops quoted reply context fetched from non-allowlisted room senders", async () => {
    const { handler, finalizeInboundContext } = createQuotedReplyVisibilityHarness("allowlist");

    await sendQuotedReply(handler);

    const finalized = latestFinalizedReplyContext(finalizeInboundContext);
    expect(finalized.ReplyToBody).toBeUndefined();
    expect(finalized.ReplyToSender).toBeUndefined();
  });

  it("keeps quoted reply context in allowlist_quote mode", async () => {
    const { handler, finalizeInboundContext } =
      createQuotedReplyVisibilityHarness("allowlist_quote");

    await sendQuotedReply(handler);

    const finalized = latestFinalizedReplyContext(finalizeInboundContext);
    expect(finalized.ReplyToBody).toBe("Quoted payload");
    expect(finalized.ReplyToSender).toBe("Mallory");
  });
});
