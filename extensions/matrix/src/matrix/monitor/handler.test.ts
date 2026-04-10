import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSessionMetaFromInbound } from "openclaw/plugin-sdk/config-runtime";
import {
  registerSessionBindingAdapter,
  __testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReactionEvent,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const prepareMatrixSingleTextMock = vi.hoisted(() =>
  vi.fn((text: string) => {
    const trimmedText = text.trim();
    return {
      convertedText: trimmedText,
      fitsInSingleEvent: true,
      singleEventLimit: 4000,
      trimmedText,
    };
  }),
);

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  sendMessageMatrix: sendMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendTypingMatrix: vi.fn(async () => {}),
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./replies.js", () => ({
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  prepareMatrixSingleTextMock.mockReset().mockImplementation((text: string) => {
    const trimmedText = text.trim();
    return {
      convertedText: trimmedText,
      fitsInSingleEvent: true,
      singleEventLimit: 4000,
      trimmedText,
    };
  });
});

function createReactionHarness(params?: {
  cfg?: unknown;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  storeAllowFrom?: string[];
  targetSender?: string;
  isDirectMessage?: boolean;
  senderName?: string;
  client?: NonNullable<Parameters<typeof createMatrixHandlerTestHarness>[0]>["client"];
}) {
  return createMatrixHandlerTestHarness({
    allowFrom: params?.allowFrom,
    cfg: params?.cfg,
    client: {
      getEvent: async () => ({ sender: params?.targetSender ?? "@bot:example.org" }),
      ...params?.client,
    },
    dmPolicy: params?.dmPolicy,
    getMemberDisplayName: async () => params?.senderName ?? "sender",
    isDirectMessage: params?.isDirectMessage,
    readAllowFromStore: vi.fn(async () => params?.storeAllowFrom ?? []),
  });
}

describe("matrix monitor handler pairing account scope", () => {
  it("caches account-scoped allowFrom store reads on hot path", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    sendMessageMatrixMock.mockClear();

    const { handler } = createMatrixHandlerTestHarness({
      buildPairingReply: () => "pairing",
      dmPolicy: "pairing",
      readAllowFromStore,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room hello",
        eventId: "$event1",
        mentions: { room: true },
      }),
    );

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room hello again",
        eventId: "$event2",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
  });

  it("refreshes the account-scoped allowFrom cache after its ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      const { handler } = createMatrixHandlerTestHarness({
        buildPairingReply: () => "pairing",
        dmPolicy: "pairing",
        readAllowFromStore,
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          body: "@room hello",
          eventId: id,
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(readAllowFromStore).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_001);
      await handler("!room:example.org", makeEvent("$event3"));

      expect(readAllowFromStore).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends pairing reminders for pending requests with cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    try {
      const readAllowFromStore = vi.fn(async () => [] as string[]);
      sendMessageMatrixMock.mockClear();

      const { handler } = createMatrixHandlerTestHarness({
        buildPairingReply: () => "Pairing code: ABCDEFGH",
        dmPolicy: "pairing",
        getMemberDisplayName: async () => "sender",
        isDirectMessage: true,
        readAllowFromStore,
      });

      const makeEvent = (id: string): MatrixRawEvent =>
        createMatrixTextMessageEvent({
          body: "hello",
          eventId: id,
          mentions: { room: true },
        });

      await handler("!room:example.org", makeEvent("$event1"));
      await handler("!room:example.org", makeEvent("$event2"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(String(sendMessageMatrixMock.mock.calls[0]?.[1] ?? "")).toContain(
        "Pairing request is still pending approval.",
      );

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await handler("!room:example.org", makeEvent("$event3"));
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses account-scoped pairing store reads and upserts for dm pairing", async () => {
    const readAllowFromStore = vi.fn(async () => [] as string[]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "ABCDEFGH", created: false }));

    const { handler } = createMatrixHandlerTestHarness({
      dmPolicy: "pairing",
      dropPreStartupMessages: true,
      getMemberDisplayName: async () => "sender",
      isDirectMessage: true,
      needsRoomAliasesForConfig: false,
      readAllowFromStore,
      upsertPairingRequest,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$event1",
        mentions: { room: true },
      }),
    );

    expect(readAllowFromStore).toHaveBeenCalledWith({
      accountId: "ops",
      channel: "matrix",
      env: process.env,
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      accountId: "ops",
      channel: "matrix",
      id: "@user:example.org",
      meta: { name: "sender" },
    });
  });

  it("passes accountId into route resolution for inbound dm messages", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      accountId: "ops",
      agentId: "ops",
      channel: "matrix",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
      sessionKey: "agent:ops:main",
    }));

    const { handler } = createMatrixHandlerTestHarness({
      getMemberDisplayName: async () => "sender",
      isDirectMessage: true,
      resolveAgentRoute,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$event2",
        mentions: { room: true },
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        channel: "matrix",
      }),
    );
  });

  it("does not enqueue delivered text messages into system events", async () => {
    const dispatchReplyFromConfig = vi.fn(async () => ({
      counts: { block: 0, final: 1, tool: 0 },
      queuedFinal: true,
    }));
    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig,
      getMemberDisplayName: async () => "sender",
      isDirectMessage: true,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from matrix",
        eventId: "$event-system-preview",
        mentions: { room: true },
      }),
    );

    expect(dispatchReplyFromConfig).toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops room messages from configured Matrix bot accounts when allowBots is off", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from bot",
        eventId: "$bot-off",
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("accepts room messages from configured Matrix bot accounts when allowBots is true", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from bot",
        eventId: "$bot-on",
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("does not treat unconfigured Matrix users as bots when allowBots is off", async () => {
    const { handler, resolveAgentRoute, recordInboundSession } = createMatrixHandlerTestHarness({
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "human",
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from human",
        eventId: "$non-bot",
        sender: "@alice:example.org",
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalled();
    expect(recordInboundSession).toHaveBeenCalled();
  });

  it('drops configured Matrix bot room messages without a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from bot",
        eventId: "$bot-mentions-off",
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it('accepts configured Matrix bot room messages with a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
      roomsConfig: {
        "!room:example.org": { requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello @bot",
        eventId: "$bot-mentions-on",
        mentions: { user_ids: ["@bot:example.org"] },
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it('accepts configured Matrix bot DMs without a mention when allowBots="mentions"', async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: "mentions",
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: true,
    });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        body: "hello from dm bot",
        eventId: "$bot-dm-mentions",
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("lets room-level allowBots override a permissive account default", async () => {
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      accountAllowBots: true,
      configuredBotUserIds: new Set(["@ops:example.org"]),
      getMemberDisplayName: async () => "ops-bot",
      isDirectMessage: false,
      roomsConfig: {
        "!room:example.org": { allowBots: false, requireMention: false },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello from bot",
        eventId: "$bot-room-override",
        sender: "@ops:example.org",
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
  });

  it("processes room messages mentioned via displayName in formatted_body", async () => {
    const recordInboundSession = vi.fn(async () => {});
    const { handler } = createMatrixHandlerTestHarness({
      getMemberDisplayName: async () => "Tom Servo",
      isDirectMessage: false,
      recordInboundSession,
    });

    await handler(
      "!room:example.org",
      createMatrixRoomMessageEvent({
        content: {
          body: "Tom Servo: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:example.org">Tom Servo</a>: hello',
          msgtype: "m.text",
        },
        eventId: "$display-name-mention",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
  });

  it("does not fetch self displayName for plain-text room mentions", async () => {
    const getMemberDisplayName = vi.fn(async () => "Tom Servo");
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      getMemberDisplayName,
      isDirectMessage: false,
      mentionRegexes: [/\btom servo\b/i],
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "Tom Servo: hello",
        eventId: "$plain-text-mention",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalledWith("!room:example.org", "@bot:example.org");
  });

  it("drops forged metadata-only mentions before session recording", async () => {
    const { handler, recordInboundSession, resolveAgentRoute } = createMatrixHandlerTestHarness({
      getMemberDisplayName: async () => "sender",
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello there",
        eventId: "$spoofed-mention",
        mentions: { user_ids: ["@bot:example.org"] },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });

  it("skips media downloads for unmentioned group media messages", async () => {
    const downloadContent = vi.fn(async () => Buffer.from("image"));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        downloadContent,
      },
      getMemberDisplayName,
      getRoomInfo,
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
    });

    await handler("!room:example.org", {
      content: {
        body: "",
        info: {
          mimetype: "image/png",
          size: 5,
        },
        msgtype: "m.image",
        url: "mxc://example.org/media",
      },
      event_id: "$media1",
      origin_server_ts: Date.now(),
      sender: "@user:example.org",
      type: EventType.RoomMessage,
    } as MatrixRawEvent);

    expect(downloadContent).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
  });

  it("skips poll snapshot fetches for unmentioned group poll responses", async () => {
    const getEvent = vi.fn(async () => ({
      content: {
        "m.poll.start": {
          answers: [{ id: "a1", "m.text": "Pizza" }],
          kind: "m.poll.disclosed",
          max_selections: 1,
          question: { "m.text": "Lunch?" },
        },
      },
      event_id: "$poll",
      origin_server_ts: Date.now(),
      sender: "@user:example.org",
      type: "m.poll.start",
    }));
    const getRelations = vi.fn(async () => ({
      events: [],
      nextBatch: null,
      prevBatch: null,
    }));
    const getMemberDisplayName = vi.fn(async () => "sender");
    const getRoomInfo = vi.fn(async () => ({ altAliases: [] }));
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        getEvent,
        getRelations,
      },
      getMemberDisplayName,
      getRoomInfo,
      isDirectMessage: false,
      mentionRegexes: [/@bot/i],
    });

    await handler("!room:example.org", {
      content: {
        "m.poll.response": {
          answers: ["a1"],
        },
        "m.relates_to": {
          event_id: "$poll",
          rel_type: "m.reference",
        },
      },
      event_id: "$poll-response-1",
      origin_server_ts: Date.now(),
      sender: "@user:example.org",
      type: "m.poll.response",
    } as MatrixRawEvent);

    expect(getEvent).not.toHaveBeenCalled();
    expect(getRelations).not.toHaveBeenCalled();
    expect(getMemberDisplayName).not.toHaveBeenCalled();
    expect(getRoomInfo).not.toHaveBeenCalled();
  });

  it("records thread starter context for inbound thread replies", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async () =>
            createMatrixTextMessageEvent({
              body: "Root topic",
              eventId: "$root",
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
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: "$root",
        ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main:thread:$root",
      }),
    );
  });

  it("keeps threaded DMs flat when dm threadReplies is off", async () => {
    const { handler, finalizeInboundContext, recordInboundSession } =
      createMatrixHandlerTestHarness({
        client: {
          getEvent: async (_roomId, eventId) =>
            eventId === "$root"
              ? createMatrixTextMessageEvent({
                  body: "Root topic",
                  eventId: "$root",
                  sender: "@alice:example.org",
                })
              : ({ sender: "@bot:example.org" } as never),
        },
        dmThreadReplies: "off",
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
        isDirectMessage: true,
        threadReplies: "always",
      });

    await handler(
      "!dm:example.org",
      createMatrixTextMessageEvent({
        body: "follow up",
        eventId: "$reply1",
        relatesTo: {
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageThreadId: undefined,
        ReplyToId: "$root",
        ThreadStarterBody: "Matrix thread root $root from Alice:\nRoot topic",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("posts a one-time notice when another Matrix DM room already owns the shared DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "direct",
          From: "matrix:@user:example.org",
          NativeChannelId: "!other:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!other:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:main",
          Surface: "matrix",
          To: "room:!other:example.org",
        },
        sessionKey: "agent:ops:main",
        storePath,
      });

      const { handler } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        isDirectMessage: true,
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm1",
        }),
      );

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
          msgtype: "m.notice",
        }),
      );

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "again",
          eventId: "$dm2",
        }),
      );

      expect(sendNotice).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("checks flat DM collision notices against the current DM session key", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-flat-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "direct",
          From: "matrix:@user:example.org",
          NativeChannelId: "!other:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!other:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:matrix:direct:@user:example.org",
          Surface: "matrix",
          To: "room:!other:example.org",
        },
        sessionKey: "agent:ops:matrix:direct:@user:example.org",
        storePath,
      });

      const { handler } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        isDirectMessage: true,
        resolveAgentRoute: () => ({
          accountId: "ops",
          agentId: "ops",
          channel: "matrix",
          mainSessionKey: "agent:ops:main",
          matchedBy: "binding.account" as const,
          sessionKey: "agent:ops:matrix:direct:@user:example.org",
        }),
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm-flat-1",
        }),
      );

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
          msgtype: "m.notice",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("checks threaded DM collision notices against the parent DM session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-thread-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "direct",
          From: "matrix:@user:example.org",
          NativeChannelId: "!other:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!other:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:main",
          Surface: "matrix",
          To: "room:!other:example.org",
        },
        sessionKey: "agent:ops:main",
        storePath,
      });

      const { handler } = createMatrixHandlerTestHarness({
        client: {
          getEvent: async (_roomId, eventId) =>
            eventId === "$root"
              ? createMatrixTextMessageEvent({
                  body: "Root topic",
                  eventId: "$root",
                  sender: "@alice:example.org",
                })
              : ({ sender: "@bot:example.org" } as never),
          sendMessage: sendNotice,
        },
        getMemberDisplayName: async (_roomId, userId) =>
          userId === "@alice:example.org" ? "Alice" : "sender",
        isDirectMessage: true,
        resolveStorePath: () => storePath,
        threadReplies: "always",
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$reply1",
          relatesTo: {
            event_id: "$root",
            "m.in_reply_to": { event_id: "$root" },
            rel_type: "m.thread",
          },
        }),
      );

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
          msgtype: "m.notice",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps the shared-session notice after user-target outbound metadata overwrites latest room fields", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-stable-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "direct",
          From: "matrix:@user:example.org",
          NativeChannelId: "!other:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!other:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:main",
          Surface: "matrix",
          To: "room:!other:example.org",
        },
        sessionKey: "agent:ops:main",
        storePath,
      });
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "direct",
          From: "matrix:@other:example.org",
          NativeDirectUserId: "@user:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:@other:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:main",
          Surface: "matrix",
          To: "room:@other:example.org",
        },
        sessionKey: "agent:ops:main",
        storePath,
      });

      const { handler } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        isDirectMessage: true,
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm1",
        }),
      );

      expect(sendNotice).toHaveBeenCalledWith(
        "!dm:example.org",
        expect.objectContaining({
          body: expect.stringContaining("channels.matrix.dm.sessionScope"),
          msgtype: "m.notice",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("skips the shared-session notice when the prior Matrix session metadata is not a DM", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-shared-notice-room-"));
    const storePath = path.join(tempDir, "sessions.json");
    const sendNotice = vi.fn(async () => "$notice");

    try {
      await recordSessionMetaFromInbound({
        ctx: {
          AccountId: "ops",
          ChatType: "group",
          From: "matrix:channel:!group:example.org",
          NativeChannelId: "!group:example.org",
          OriginatingChannel: "matrix",
          OriginatingTo: "room:!group:example.org",
          Provider: "matrix",
          SessionKey: "agent:ops:main",
          Surface: "matrix",
          To: "room:!group:example.org",
        },
        sessionKey: "agent:ops:main",
        storePath,
      });

      const { handler } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        isDirectMessage: true,
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm1",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("skips the shared-session notice when Matrix DMs are isolated per room", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-room-scope-"));
    const storePath = path.join(tempDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:main": {
          deliveryContext: {
            accountId: "ops",
            channel: "matrix",
            to: "room:!other:example.org",
          },
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    const sendNotice = vi.fn(async () => "$notice");

    try {
      const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        dmSessionScope: "per-room",
        isDirectMessage: true,
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm1",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
      expect(recordInboundSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:ops:matrix:channel:!dm:example.org",
        }),
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("skips the shared-session notice when a Matrix DM is explicitly bound", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-dm-bound-notice-"));
    const storePath = path.join(tempDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:bound:session-1": {
          deliveryContext: {
            accountId: "ops",
            channel: "matrix",
            to: "room:!other:example.org",
          },
          sessionId: "sess-bound",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    const sendNotice = vi.fn(async () => "$notice");
    const touch = vi.fn();
    registerSessionBindingAdapter({
      accountId: "ops",
      channel: "matrix",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "!dm:example.org"
          ? {
              bindingId: "ops:!dm:example.org",
              boundAt: Date.now(),
              conversation: {
                accountId: "ops",
                channel: "matrix",
                conversationId: "!dm:example.org",
              },
              metadata: {
                boundBy: "user-1",
              },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:bound:session-1",
            }
          : null,
      touch,
    });

    try {
      const { handler } = createMatrixHandlerTestHarness({
        client: {
          sendMessage: sendNotice,
        },
        isDirectMessage: true,
        resolveStorePath: () => storePath,
      });

      await handler(
        "!dm:example.org",
        createMatrixTextMessageEvent({
          body: "follow up",
          eventId: "$dm-bound-1",
        }),
      );

      expect(sendNotice).not.toHaveBeenCalled();
      expect(touch).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses stable room ids instead of room-declared aliases in group context", async () => {
    const { handler, finalizeInboundContext } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 0, tool: 0 },
        queuedFinal: false,
      }),
      getMemberDisplayName: async () => "sender",
      getRoomInfo: async () => ({
        altAliases: ["#alt:example.org"],
        canonicalAlias: "#spoofed:example.org",
        name: "Ops Room",
      }),
      isDirectMessage: false,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "@room hello",
        eventId: "$group1",
        mentions: { room: true },
      }),
    );

    const finalized = vi.mocked(finalizeInboundContext).mock.calls.at(-1)?.[0];
    expect(finalized).toEqual(
      expect.objectContaining({
        GroupId: "!room:example.org",
        GroupSubject: "Ops Room",
      }),
    );
    expect(finalized).not.toHaveProperty("GroupChannel");
  });

  it("routes bound Matrix threads to the target session key", async () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      accountId: "ops",
      channel: "matrix",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example:$root",
              boundAt: Date.now(),
              conversation: {
                accountId: "ops",
                channel: "matrix",
                conversationId: "$root",
                parentConversationId: "!room:example",
              },
              metadata: {
                boundBy: "user-1",
              },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:bound:session-1",
            }
          : null,
      touch,
    });
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "Root topic",
            eventId: "$root",
            sender: "@alice:example.org",
          }),
      },
      finalizeInboundContext: (ctx: unknown) => ctx,
      getMemberDisplayName: async () => "sender",
      isDirectMessage: false,
    });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        body: "@room follow up",
        eventId: "$reply1",
        mentions: { room: true },
        relatesTo: {
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:bound:session-1",
      }),
    );
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh bound Matrix thread bindings for room messages dropped before routing", async () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      accountId: "ops",
      channel: "matrix",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example:$root",
              boundAt: Date.now(),
              conversation: {
                accountId: "ops",
                channel: "matrix",
                conversationId: "$root",
                parentConversationId: "!room:example",
              },
              metadata: {
                boundBy: "user-1",
              },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:bound:session-1",
            }
          : null,
      touch,
    });
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "Root topic",
            eventId: "$root",
            sender: "@alice:example.org",
          }),
      },
      getMemberDisplayName: async () => "sender",
      isDirectMessage: false,
    });

    await handler(
      "!room:example",
      createMatrixTextMessageEvent({
        body: "follow up without mention",
        eventId: "$reply-no-mention",
        relatesTo: {
          event_id: "$root",
          "m.in_reply_to": { event_id: "$root" },
          rel_type: "m.thread",
        },
      }),
    );

    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it("does not enqueue system events for delivered text replies", async () => {
    const enqueueSystemEvent = vi.fn();

    const handler = createMatrixRoomMessageHandler({
      accountId: "ops",
      allowFrom: [],
      blockStreamingEnabled: false,
      cfg: {} as never,
      client: {
        getUserId: async () => "@bot:example.org",
      } as never,
      core: {
        channel: {
          commands: {
            shouldHandleTextCommands: () => false,
          },
          mentions: {
            buildMentionRegexes: () => [],
          },
          pairing: {
            buildPairingReply: () => "pairing",
            readAllowFromStore: async () => [] as string[],
            upsertPairingRequest: async () => ({ code: "ABCDEFGH", created: false }),
          },
          reactions: {
            shouldAckReaction: () => false,
          },
          reply: {
            createReplyDispatcherWithTyping: () => ({
              dispatcher: {},
              replyOptions: {},
              markDispatchIdle: () => {},
              markRunComplete: () => {},
            }),
            dispatchReplyFromConfig: async () => ({
              queuedFinal: true,
              counts: { final: 1, block: 0, tool: 0 },
            }),
            finalizeInboundContext: (ctx: unknown) => ctx,
            formatAgentEnvelope: ({ body }: { body: string }) => body,
            resolveEnvelopeFormatOptions: () => ({}),
            resolveHumanDelayConfig: () => undefined,
            withReplyDispatcher: async <T>({
              dispatcher,
              run,
              onSettled,
            }: {
              dispatcher: {
                markComplete?: () => void;
                waitForIdle?: () => Promise<void>;
              };
              run: () => Promise<T>;
              onSettled?: () => void | Promise<void>;
            }) => {
              try {
                return await run();
              } finally {
                dispatcher.markComplete?.();
                try {
                  await dispatcher.waitForIdle?.();
                } finally {
                  await onSettled?.();
                }
              }
            },
          },
          routing: {
            resolveAgentRoute: () => ({
              agentId: "ops",
              channel: "matrix",
              accountId: "ops",
              sessionKey: "agent:ops:main",
              mainSessionKey: "agent:ops:main",
              matchedBy: "binding.account",
            }),
          },
          session: {
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: vi.fn(async () => {}),
            resolveStorePath: () => "/tmp/session-store",
          },
          text: {
            hasControlCommand: () => false,
            resolveMarkdownTableMode: () => "preserve",
          },
        },
        system: {
          enqueueSystemEvent,
        },
      } as never,
      directTracker: {
        isDirectMessage: async () => false,
      },
      dmEnabled: true,
      dmPolicy: "open",
      dropPreStartupMessages: true,
      getMemberDisplayName: async () => "sender",
      getRoomInfo: async () => ({ altAliases: [] }),
      groupPolicy: "open",
      historyLimit: 0,
      logVerboseMessage: () => {},
      logger: {
        info: () => {},
        warn: () => {},
      } as never,
      mediaMaxBytes: 10_000_000,
      needsRoomAliasesForConfig: false,
      replyToMode: "off",
      runtime: {
        error: () => {},
      } as never,
      startupGraceMs: 0,
      startupMs: 0,
      streaming: "off",
      textLimit: 8000,
      threadReplies: "inbound",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello there",
        eventId: "$message1",
        mentions: { room: true },
        sender: "@user:example.org",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues system events for reactions on bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness();

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction1",
        key: "👍",
        targetEventId: "$msg1",
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        channel: "matrix",
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by sender on msg $msg1",
      {
        contextKey: "matrix:reaction:add:!room:example.org:$msg1:@user:example.org:👍",
        sessionKey: "agent:ops:main",
      },
    );
  });

  it("routes reaction notifications for bound thread messages to the bound session", async () => {
    registerSessionBindingAdapter({
      accountId: "ops",
      channel: "matrix",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "$root"
          ? {
              bindingId: "ops:!room:example.org:$root",
              boundAt: Date.now(),
              conversation: {
                accountId: "ops",
                channel: "matrix",
                conversationId: "$root",
                parentConversationId: "!room:example.org",
              },
              metadata: {
                boundBy: "user-1",
              },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:bound:session-1",
            }
          : null,
      touch: vi.fn(),
    });

    const { handler, enqueueSystemEvent } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "follow up",
            eventId: "$reply1",
            relatesTo: {
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
              rel_type: "m.thread",
            },
            sender: "@bot:example.org",
          }),
      },
      isDirectMessage: false,
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-thread",
        key: "🎯",
        targetEventId: "$reply1",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🎯 by sender on msg $reply1",
      {
        contextKey: "matrix:reaction:add:!room:example.org:$reply1:@user:example.org:🎯",
        sessionKey: "agent:bound:session-1",
      },
    );
  });

  it("keeps threaded DM reaction notifications on the flat session when dm threadReplies is off", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            dm: { threadReplies: "off" },
            threadReplies: "always",
          },
        },
      },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "follow up",
            eventId: "$reply1",
            relatesTo: {
              event_id: "$root",
              "m.in_reply_to": { event_id: "$root" },
              rel_type: "m.thread",
            },
            sender: "@bot:example.org",
          }),
      },
      isDirectMessage: true,
    });

    await handler(
      "!dm:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-thread",
        key: "🎯",
        targetEventId: "$reply1",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🎯 by sender on msg $reply1",
      {
        contextKey: "matrix:reaction:add:!dm:example.org:$reply1:@user:example.org:🎯",
        sessionKey: "agent:ops:main",
      },
    );
  });

  it("routes thread-root reaction notifications to the thread session when threadReplies is always", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            threadReplies: "always",
          },
        },
      },
      client: {
        getEvent: async () =>
          createMatrixTextMessageEvent({
            body: "start thread",
            eventId: "$root",
            sender: "@bot:example.org",
          }),
      },
      isDirectMessage: false,
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction-root",
        key: "🧵",
        targetEventId: "$root",
      }),
    );

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 🧵 by sender on msg $root",
      {
        contextKey: "matrix:reaction:add:!room:example.org:$root:@user:example.org:🧵",
        sessionKey: "agent:ops:main:thread:$root",
      },
    );
  });

  it("ignores reactions that do not target bot-authored messages", async () => {
    const { handler, enqueueSystemEvent, resolveAgentRoute } = createReactionHarness({
      targetSender: "@other:example.org",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction2",
        key: "👀",
        targetEventId: "$msg2",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("does not create pairing requests for unauthorized dm reactions", async () => {
    const { handler, enqueueSystemEvent, upsertPairingRequest } = createReactionHarness({
      dmPolicy: "pairing",
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction3",
        key: "🔥",
        targetEventId: "$msg3",
      }),
    );

    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("honors account-scoped reaction notification overrides", async () => {
    const { handler, enqueueSystemEvent } = createReactionHarness({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              ops: {
                reactionNotifications: "off",
              },
            },
            reactionNotifications: "own",
          },
        },
      },
    });

    await handler(
      "!room:example.org",
      createMatrixReactionEvent({
        eventId: "$reaction4",
        key: "✅",
        targetEventId: "$msg4",
      }),
    );

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("drops pre-startup dm messages on cold start", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      accountId: "ops",
      agentId: "ops",
      channel: "matrix",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
      sessionKey: "agent:ops:main",
    }));
    const { handler } = createMatrixHandlerTestHarness({
      dropPreStartupMessages: true,
      isDirectMessage: true,
      resolveAgentRoute,
      startupGraceMs: 0,
      startupMs: 1000,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$old-cold-start",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("replays pre-startup dm messages when persisted sync state exists", async () => {
    const resolveAgentRoute = vi.fn(() => ({
      accountId: "ops",
      agentId: "ops",
      channel: "matrix",
      mainSessionKey: "agent:ops:main",
      matchedBy: "binding.account" as const,
      sessionKey: "agent:ops:main",
    }));
    const { handler } = createMatrixHandlerTestHarness({
      dropPreStartupMessages: false,
      isDirectMessage: true,
      resolveAgentRoute,
      startupGraceMs: 0,
      startupMs: 1000,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$old-resume",
        originServerTs: 999,
      }),
    );

    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });
});

describe("matrix monitor handler durable inbound dedupe", () => {
  it("skips replayed inbound events before session recording", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => false),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const { handler, recordInboundSession } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      })),
      inboundDeduper,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$dup",
      }),
    );

    expect(inboundDeduper.claimEvent).toHaveBeenCalledWith({
      eventId: "$dup",
      roomId: "!room:example.org",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });

  it("commits inbound events only after queued replies finish delivering", async () => {
    const callOrder: string[] = [];
    const inboundDeduper = {
      claimEvent: vi.fn(() => {
        callOrder.push("claim");
        return true;
      }),
      commitEvent: vi.fn(async () => {
        callOrder.push("commit");
      }),
      releaseEvent: vi.fn(() => {
        callOrder.push("release");
      }),
    };
    const recordInboundSession = vi.fn(async () => {
      callOrder.push("record");
    });
    const dispatchReplyFromConfig = vi.fn(async () => {
      callOrder.push("dispatch");
      return {
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      };
    });
    const { handler } = createMatrixHandlerTestHarness({
      createReplyDispatcherWithTyping: () => ({
        dispatcher: {
          markComplete: () => {
            callOrder.push("mark-complete");
          },
          waitForIdle: async () => {
            callOrder.push("wait-for-idle");
          },
        },
        markDispatchIdle: () => {
          callOrder.push("dispatch-idle");
        },
        markRunComplete: () => {
          callOrder.push("run-complete");
        },
        replyOptions: {},
      }),
      dispatchReplyFromConfig,
      inboundDeduper,
      recordInboundSession,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$commit-order",
      }),
    );

    expect(callOrder).toEqual([
      "claim",
      "record",
      "dispatch",
      "run-complete",
      "mark-complete",
      "wait-for-idle",
      "dispatch-idle",
      "commit",
    ]);
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });

  it("releases a claimed event when reply dispatch fails before completion", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => true),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      })),
      inboundDeduper,
      recordInboundSession: vi.fn(async () => {
        throw new Error("disk failed");
      }),
      runtime: runtime as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$release-on-error",
      }),
    );

    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
      eventId: "$release-on-error",
      roomId: "!room:example.org",
    });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("matrix handler failed"));
  });

  it("releases a claimed event when queued final delivery fails", async () => {
    const inboundDeduper = {
      claimEvent: vi.fn(() => true),
      commitEvent: vi.fn(async () => undefined),
      releaseEvent: vi.fn(),
    };
    const runtime = {
      error: vi.fn(),
    };
    const { handler } = createMatrixHandlerTestHarness({
      createReplyDispatcherWithTyping: (params) => ({
        dispatcher: {
          markComplete: () => {},
          waitForIdle: async () => {
            params?.onError?.(new Error("send failed"), { kind: "final" });
          },
        },
        markDispatchIdle: () => {},
        markRunComplete: () => {},
        replyOptions: {},
      }),
      dispatchReplyFromConfig: vi.fn(async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      })),
      inboundDeduper,
      runtime: runtime as never,
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$release-on-final-delivery-error",
      }),
    );

    expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
    expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
      eventId: "$release-on-final-delivery-error",
      roomId: "!room:example.org",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("matrix final reply failed"),
    );
  });

  it.each(["tool", "block"] as const)(
    "releases a claimed event when queued %s delivery fails and no final reply exists",
    async (kind) => {
      const inboundDeduper = {
        claimEvent: vi.fn(() => true),
        commitEvent: vi.fn(async () => undefined),
        releaseEvent: vi.fn(),
      };
      const runtime = {
        error: vi.fn(),
      };
      const { handler } = createMatrixHandlerTestHarness({
        createReplyDispatcherWithTyping: (params) => ({
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {
              params?.onError?.(new Error("send failed"), { kind });
            },
          },
          markDispatchIdle: () => {},
          markRunComplete: () => {},
          replyOptions: {},
        }),
        dispatchReplyFromConfig: vi.fn(async () => ({
          counts: {
            block: kind === "block" ? 1 : 0,
            final: 0,
            tool: kind === "tool" ? 1 : 0,
          },
          queuedFinal: false,
        })),
        inboundDeduper,
        runtime: runtime as never,
      });

      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({
          body: "hello",
          eventId: `$release-on-${kind}-delivery-error`,
        }),
      );

      expect(inboundDeduper.commitEvent).not.toHaveBeenCalled();
      expect(inboundDeduper.releaseEvent).toHaveBeenCalledWith({
        eventId: `$release-on-${kind}-delivery-error`,
        roomId: "!room:example.org",
      });
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(`matrix ${kind} reply failed`),
      );
    },
  );

  it("commits a claimed event when dispatch completes without a final reply", async () => {
    const callOrder: string[] = [];
    const inboundDeduper = {
      claimEvent: vi.fn(() => {
        callOrder.push("claim");
        return true;
      }),
      commitEvent: vi.fn(async () => {
        callOrder.push("commit");
      }),
      releaseEvent: vi.fn(() => {
        callOrder.push("release");
      }),
    };
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(async () => {
        callOrder.push("dispatch");
        return {
          counts: { block: 0, final: 0, tool: 0 },
          queuedFinal: false,
        };
      }),
      inboundDeduper,
      recordInboundSession: vi.fn(async () => {
        callOrder.push("record");
      }),
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({
        body: "hello",
        eventId: "$no-final",
      }),
    );

    expect(callOrder).toEqual(["claim", "record", "dispatch", "commit"]);
    expect(inboundDeduper.releaseEvent).not.toHaveBeenCalled();
  });
});

describe("matrix monitor handler draft streaming", () => {
  type DeliverFn = (
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      isCompactionNotice?: boolean;
      replyToId?: string;
    },
    info: { kind: string },
  ) => Promise<void>;
  interface ReplyOpts {
    onPartialReply?: (payload: { text: string }) => void;
    onBlockReplyQueued?: (
      payload: {
        text?: string;
        isCompactionNotice?: boolean;
      },
      context?: { assistantMessageIndex?: number },
    ) => Promise<void> | void;
    onAssistantMessageStart?: () => void;
    disableBlockStreaming?: boolean;
  }

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet";
  }) {
    let capturedDeliver: DeliverFn | undefined;
    let capturedReplyOpts: ReplyOpts | undefined;
    // Gate that keeps the handler's model run alive until the test releases it.
    let resolveRunGate: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      resolveRunGate = resolve;
    });

    sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(undefined);

    const redactEventMock = vi.fn(async () => "$redacted");

    const { handler } = createMatrixHandlerTestHarness({
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      client: { redactEvent: redactEventMock },
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        capturedDeliver = params?.deliver as DeliverFn | undefined;
        return {
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {},
          },
          markDispatchIdle: () => {},
          markRunComplete: () => {},
          replyOptions: {},
        };
      },
      dispatchReplyFromConfig: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        // Block until the test is done exercising callbacks.
        await runGate;
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: true };
      }) as never,
      replyToMode: opts?.replyToMode ?? "off",
      streaming: opts?.streaming ?? "quiet",
      withReplyDispatcher: async <T>(params: {
        dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
        run: () => Promise<T>;
        onSettled?: () => void | Promise<void>;
      }) => {
        const result = await params.run();
        await params.onSettled?.();
        return result;
      },
    });

    const dispatch = async () => {
      // Start handler without awaiting — it blocks on runGate.
      const handlerDone = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
      );
      // Wait for callbacks to be captured.
      await vi.waitFor(() => {
        if (!capturedDeliver || !capturedReplyOpts) {
          throw new Error("Streaming callbacks not captured yet");
        }
      });
      return {
        deliver: capturedDeliver!,
        opts: capturedReplyOpts!,
        // Release the run gate and wait for the handler to finish
        // (including the finally block that stops the draft stream).
        finish: async () => {
          resolveRunGate?.();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock };
  }

  it("finalizes a single quiet-preview block in place when block streaming is enabled", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Single block" }, { kind: "final" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Single block",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps partial preview-first finalization on the existing draft when text is unchanged", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single block" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "Single block",
      expect.not.objectContaining({
        includeMentions: false,
        msgtype: "m.notice",
      }),
    );

    await deliver({ text: "Single block" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("still edits partial preview-first drafts when the final text changes", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await deliver({ text: "Single block" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Single block",
      expect.not.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("preserves completed blocks by rotating to a new quiet preview", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Block one" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Block one" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Block one",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();

    opts.onAssistantMessageStart?.();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    opts.onPartialReply?.({ text: "Block two" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });

    await deliver({ text: "Block two" }, { kind: "final" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft2",
      "Block two",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("queues late partials behind block-boundary rotation", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    opts.onPartialReply?.({ text: "AlphaBeta" });

    // The next block must not update the previous block's draft while the
    // Prior block delivery is still draining.
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();

    await deliver({ text: "Alpha" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[1]?.[1]).toBe("Beta");
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps delayed same-message block boundaries at the emitted block length", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    opts.onPartialReply?.({ text: "AlphaBeta" });
    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "AlphaBeta",
        expect.anything(),
      );
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("falls back to deliverMatrixReplies when final edit fails", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Hello" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));

    await deliver({ text: "Hello world" }, { kind: "block" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("does not reset draft stream after final delivery", async () => {
    vi.useFakeTimers();
    try {
      const { dispatch } = createStreamingHarness();
      const { deliver, opts, finish } = await dispatch();

      opts.onPartialReply?.({ text: "Hello" });
      await vi.waitFor(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      // Final delivery — stream should stay stopped.
      await deliver({ text: "Hello" }, { kind: "final" });

      // Further partial updates should NOT create new messages.
      sendSingleTextMessageMatrixMock.mockClear();
      opts.onPartialReply?.({ text: "Ghost" });

      await vi.advanceTimersByTimeAsync(50);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      await finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets draft block offsets on assistant message start", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    // Block 1: stream and deliver.
    opts.onPartialReply?.({ text: "Block one" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    await deliver({ text: "Block one" }, { kind: "block" });

    // Tool call delivered (bypasses draft stream).
    await deliver({ text: "tool result" }, { kind: "tool" });

    // New assistant message starts — payload.text will reset upstream.
    opts.onAssistantMessageStart?.();

    // Block 2: partial text starts fresh (no stale offset).
    sendSingleTextMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });

    opts.onPartialReply?.({ text: "Block two" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // The draft stream should have received "Block two", not empty string.
    const sentBody = sendSingleTextMessageMatrixMock.mock.calls[0]?.[1];
    expect(sentBody).toBeTruthy();
    await finish();
  });

  it("preserves queued block boundaries across assistant message start", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Beta" });

    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "Beta",
        expect.anything(),
      );
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");

    await deliver({ text: "Beta" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("queues late block boundaries against the source assistant message", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    opts.onAssistantMessageStart?.();
    await opts.onBlockReplyQueued?.({ text: "Alpha" }, { assistantMessageIndex: 1 });
    opts.onPartialReply?.({ text: "Beta" });

    await vi.waitFor(() => {
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        "Beta",
        expect.anything(),
      );
    });

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.anything(),
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");

    await deliver({ text: "Beta" }, { kind: "final" });

    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it("keeps queued block boundaries ordered while Matrix deliveries drain", async () => {
    const { dispatch } = createStreamingHarness({ blockStreamingEnabled: true });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Alpha" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Alpha");

    await opts.onBlockReplyQueued?.({ text: "Alpha" });
    opts.onPartialReply?.({ text: "AlphaBeta" });
    await opts.onBlockReplyQueued?.({ text: "Beta" });
    opts.onPartialReply?.({ text: "AlphaBetaGamma" });

    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver({ text: "Alpha" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Beta");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );

    sendSingleTextMessageMatrixMock.mockClear();
    editMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft3",
      roomId: "!room",
    });
    await deliver({ text: "Beta" }, { kind: "block" });

    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    expect(sendSingleTextMessageMatrixMock.mock.calls[0]?.[1]).toBe("Gamma");
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft2",
      "Beta",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );

    await finish();
  });

  it("stops draft stream on handler error (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      sendSingleTextMessageMatrixMock
        .mockReset()
        .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
      editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
      deliverMatrixRepliesMock.mockReset().mockResolvedValue(undefined);

      let capturedReplyOpts: ReplyOpts | undefined;

      const { handler } = createMatrixHandlerTestHarness({
        createReplyDispatcherWithTyping: () => ({
          dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
          markDispatchIdle: () => {},
          markRunComplete: () => {},
          replyOptions: {},
        }),
        dispatchReplyFromConfig: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
          capturedReplyOpts = args?.replyOptions;
          // Simulate streaming then model error.
          capturedReplyOpts?.onPartialReply?.({ text: "partial" });
          await vi.waitFor(() => {
            expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
          });
          throw new Error("model timeout");
        }) as never,
        streaming: "quiet",
        withReplyDispatcher: async <T>(params: {
          dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
          run: () => Promise<T>;
          onSettled?: () => void | Promise<void>;
        }) => {
          const result = await params.run();
          await params.onSettled?.();
          return result;
        },
      });

      // Handler should not throw (outer catch absorbs it).
      await handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
      );

      // After handler exits, draft stream timer must not fire.
      sendSingleTextMessageMatrixMock.mockClear();
      editMessageMatrixMock.mockClear();
      await vi.advanceTimersByTimeAsync(50);
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips compaction notices in draft finalization", async () => {
    const { dispatch } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Streaming" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Compaction notice should bypass draft path and go to normal delivery.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ isCompactionNotice: true, text: "Compacting..." }, { kind: "block" });

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    // Edit should NOT have been called for the compaction notice.
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
  });

  it("redacts stale draft when payload reply target mismatches", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode: "first" });
    const { deliver, opts, finish } = await dispatch();

    // Simulate streaming: partial reply creates draft message.
    opts.onPartialReply?.({ text: "Partial reply" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Final delivery carries a different replyToId than the draft's.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ replyToId: "$different_msg", text: "Final text" }, { kind: "final" });

    // Draft should be redacted since it can't change reply relation.
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    // Final answer delivered via normal path.
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("redacts stale draft when final payload intentionally drops reply threading", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ replyToMode: "first" });
    const { deliver, opts, finish } = await dispatch();

    // A tool payload can consume the first reply slot upstream while draft
    // Streaming for the next assistant block still starts from the original
    // Reply target.
    await deliver({ replyToId: "$msg1", text: "tool result" }, { kind: "tool" });
    opts.onAssistantMessageStart?.();

    opts.onPartialReply?.({ text: "Partial reply" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text" }, { kind: "final" });

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("redacts stale draft for media-only finals", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Partial reply" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });

  it("finalizes quiet drafts before reusing unchanged media captions", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "quiet" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "@room screenshot ready" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    deliverMatrixRepliesMock.mockClear();
    await deliver(
      {
        mediaUrl: "https://example.com/image.png",
        text: "@room screenshot ready",
      },
      { kind: "final" },
    );

    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "@room screenshot ready",
      expect.objectContaining({
        extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true },
      }),
    );
    expect(redactEventMock).not.toHaveBeenCalled();
    expect(deliverMatrixRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            mediaUrl: "https://example.com/image.png",
            text: undefined,
          }),
        ],
      }),
    );
    await finish();
  });

  it("redacts stale draft and sends the final once when a later preview exceeds the event limit", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness();
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "1234" });
    await vi.waitFor(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    prepareMatrixSingleTextMock.mockImplementation((text: string) => {
      const trimmedText = text.trim();
      return {
        convertedText: trimmedText,
        fitsInSingleEvent: trimmedText.length <= 5,
        singleEventLimit: 5,
        trimmedText,
      };
    });

    opts.onPartialReply?.({ text: "123456" });
    await deliver({ text: "123456" }, { kind: "final" });

    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    await finish();
  });
});

describe("matrix monitor handler block streaming config", () => {
  it("keeps final-only delivery when draft streaming is off by default", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ) as never,
      streaming: "off",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
    );

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("keeps block streaming disabled when partial previews are on and block streaming is off", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ) as never,
      streaming: "partial",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
    );

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("keeps block streaming disabled when quiet previews are on and block streaming is off", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ) as never,
      streaming: "quiet",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
    );

    expect(capturedDisableBlockStreaming).toBe(true);
  });

  it("allows shared block streaming when partial previews and block streaming are both enabled", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      blockStreamingEnabled: true,
      dispatchReplyFromConfig: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ) as never,
      streaming: "partial",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
    );

    expect(capturedDisableBlockStreaming).toBe(false);
  });

  it("uses shared block streaming when explicitly enabled for Matrix", async () => {
    let capturedDisableBlockStreaming: boolean | undefined;

    const { handler } = createMatrixHandlerTestHarness({
      blockStreamingEnabled: true,
      dispatchReplyFromConfig: vi.fn(
        async (args: { replyOptions?: { disableBlockStreaming?: boolean } }) => {
          capturedDisableBlockStreaming = args.replyOptions?.disableBlockStreaming;
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ) as never,
      streaming: "off",
    });

    await handler(
      "!room:example.org",
      createMatrixTextMessageEvent({ body: "hello", eventId: "$msg1" }),
    );

    expect(capturedDisableBlockStreaming).toBe(false);
  });
});
