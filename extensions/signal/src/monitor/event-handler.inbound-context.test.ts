import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../../../src/channels/plugins/contracts/test-helpers.js";
vi.useRealTimers();
const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock, capture } = vi.hoisted(
  () => {
    const captureState: { ctx: MsgContext | undefined } = { ctx: undefined };
    return {
      capture: captureState,
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: { onReplyStart?: () => void | Promise<void> };
        }) => {
          captureState.ctx = params.ctx;
          await Promise.resolve(params.replyOptions?.onReplyStart?.());
          return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
        },
      ),
      sendReadReceiptMock: vi.fn(),
      sendTypingMock: vi.fn(),
    };
  },
);

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendReadReceiptSignal: sendReadReceiptMock,
  sendTypingSignal: sendTypingMock,
}));

vi.mock("../../../../src/auto-reply/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../src/auto-reply/dispatch.js")>(
    "../../../../src/auto-reply/dispatch.js",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal createSignalEventHandler inbound context", () => {
  beforeEach(() => {
    capture.ctx = undefined;
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          message: "hi",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const contextWithBody = capture.ctx;
    if (!contextWithBody) {
      throw new Error("expected inbound MsgContext");
    }
    expectInboundContextContract(contextWithBody);
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          message: "hello",
        },
        sourceName: "Bob",
        sourceNumber: "+15550002222",
        timestamp: 1_700_000_000_001,
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx!;
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        account: "+15550009999",
        blockStreaming: false,
        cfg: {
          channels: { signal: { allowFrom: ["*"], dmPolicy: "open" } },
          messages: { inbound: { debounceMs: 0 } },
        },
        groupHistories: new Map(),
        historyLimit: 0,
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith("+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1_700_000_000_000,
      expect.any(Object),
    );
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        account: "+15550009999",
        allowFrom: [],
        blockStreaming: false,
        cfg: {
          channels: { signal: { allowFrom: [], dmPolicy: "open" } },
          messages: { inbound: { debounceMs: 0 } },
        },
        groupAllowFrom: [],
        groupHistories: new Map(),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          message: "/status",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.CommandAuthorized).toBe(false);
  });

  it("drops quote-only group context from non-allowlisted quoted senders in allowlist mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: {
            signal: {
              contextVisibility: "allowlist",
              groupAllowFrom: ["+15550001111"],
              groupPolicy: "allowlist",
            },
          },
          messages: { inbound: { debounceMs: 0 } },
        },
        groupAllowFrom: ["+15550001111"],
        groupPolicy: "allowlist",
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          message: "",
          quote: { author: "+15550002222", text: "blocked quote" },
        },
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("keeps quote-only group context in allowlist_quote mode", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: {
            signal: {
              contextVisibility: "allowlist_quote",
              groupAllowFrom: ["+15550001111"],
              groupPolicy: "allowlist",
            },
          },
          messages: { inbound: { debounceMs: 0 } },
        },
        groupAllowFrom: ["+15550001111"],
        groupPolicy: "allowlist",
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
          message: "",
          quote: { author: "+15550002222", text: "quoted context" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.BodyForAgent).toBe("quoted context");
    expect(capture.ctx?.ReplyToBody).toBe("quoted context");
    expect(capture.ctx?.ReplyToSender).toBe("+15550002222");
    expect(capture.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("forwards all fetched attachments via MediaPaths/MediaTypes", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: { signal: { allowFrom: ["*"], dmPolicy: "open" } },
          messages: { inbound: { debounceMs: 0 } },
        },
        fetchAttachment: async ({ attachment }) => ({
          contentType: attachment.id === "a1" ? "image/jpeg" : undefined,
          path: `/tmp/${String(attachment.id)}.dat`,
        }),
        historyLimit: 0,
        ignoreAttachments: false,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [{ contentType: "image/jpeg", id: "a1" }, { id: "a2" }],
          message: "",
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.MediaPath).toBe("/tmp/a1.dat");
    expect(capture.ctx?.MediaType).toBe("image/jpeg");
    expect(capture.ctx?.MediaPaths).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaUrls).toEqual(["/tmp/a1.dat", "/tmp/a2.dat"]);
    expect(capture.ctx?.MediaTypes).toEqual(["image/jpeg", "application/octet-stream"]);
  });

  it("drops own UUID inbound messages when only accountUuid is configured", async () => {
    const ownUuid = "123e4567-e89b-12d3-a456-426614174000";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        account: undefined,
        accountUuid: ownUuid,
        cfg: {
          channels: { signal: { accountUuid: ownUuid, allowFrom: ["*"], dmPolicy: "open" } },
          messages: { inbound: { debounceMs: 0 } },
        },
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          message: "self message",
        },
        sourceNumber: null,
        sourceUuid: ownUuid,
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("drops sync envelopes when syncMessage is present but null", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          channels: { signal: { allowFrom: ["*"], dmPolicy: "open" } },
          messages: { inbound: { debounceMs: 0 } },
        },
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          attachments: [],
          message: "replayed sentTranscript envelope",
        },
        syncMessage: null,
      }),
    );

    expect(capture.ctx).toBeUndefined();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });
});
