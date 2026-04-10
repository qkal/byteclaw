import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../../src/channels/plugins/contracts/inbound-testkit.js";

type SignalMsgContext = Pick<MsgContext, "Body" | "WasMentioned"> & {
  Body?: string;
  WasMentioned?: boolean;
};

let capturedCtx: SignalMsgContext | undefined;

function getCapturedCtx() {
  return capturedCtx as SignalMsgContext;
}

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as SignalMsgContext;
  });
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
  { renderSignalMentions },
] = await Promise.all([
  import("./event-handler.test-harness.js"),
  import("./event-handler.js"),
  import("./mentions.js"),
]);

interface GroupEventOpts {
  message?: string;
  attachments?: unknown[];
  quoteText?: string;
  mentions?: {
    uuid?: string;
    number?: string;
    start?: number;
    length?: number;
  }[] | null;
}

function makeGroupEvent(opts: GroupEventOpts) {
  return createSignalReceiveEvent({
    dataMessage: {
      attachments: opts.attachments ?? [],
      groupInfo: { groupId: "g1", groupName: "Test Group" },
      mentions: opts.mentions ?? undefined,
      message: opts.message ?? "",
      quote: opts.quoteText ? { text: opts.quoteText } : undefined,
    },
  });
}

function createMentionHandler(params: {
  requireMention: boolean;
  mentionPattern?: string;
  historyLimit?: number;
  groupHistories?: ReturnType<typeof createBaseSignalEventHandlerDeps>["groupHistories"];
}) {
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: createSignalConfig({
        mentionPattern: params.mentionPattern,
        requireMention: params.requireMention,
      }),
      ...(typeof params.historyLimit === "number" ? { historyLimit: params.historyLimit } : {}),
      ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    }),
  );
}

function createMentionGatedHistoryHandler() {
  const groupHistories = new Map();
  const handler = createMentionHandler({ groupHistories, historyLimit: 5, requireMention: true });
  return { groupHistories, handler };
}

function createSignalConfig(params: { requireMention: boolean; mentionPattern?: string }) {
  return {
    channels: {
      signal: {
        groups: { "*": { requireMention: params.requireMention } },
      },
    },
    messages: {
      groupChat: { mentionPatterns: [params.mentionPattern ?? "@bot"] },
      inbound: { debounceMs: 0 },
    },
  } as unknown as OpenClawConfig;
}

async function expectSkippedGroupHistory(opts: GroupEventOpts, expectedBody: string) {
  capturedCtx = undefined;
  const { handler, groupHistories } = createMentionGatedHistoryHandler();
  await handler(makeGroupEvent(opts));
  expect(capturedCtx).toBeUndefined();
  const entries = groupHistories.get("g1");
  expect(entries).toBeTruthy();
  expect(entries).toHaveLength(1);
  expect(entries[0].body).toBe(expectedBody);
}

describe("signal mention gating", () => {
  beforeEach(() => {
    capturedCtx = undefined;
  });

  it("drops group messages without mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeUndefined();
  });

  it("allows group messages with mention when requireMention is configured", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "hey @bot what's up" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("sets WasMentioned=false for group messages without mention when requireMention is off", async () => {
    const handler = createMentionHandler({ requireMention: false });

    await handler(makeGroupEvent({ message: "hello everyone" }));
    expect(capturedCtx).toBeTruthy();
    expect(getCapturedCtx()?.WasMentioned).toBe(false);
  });

  it("records pending history for skipped group messages", async () => {
    const { handler, groupHistories } = createMentionGatedHistoryHandler();
    await handler(makeGroupEvent({ message: "hello from alice" }));
    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].sender).toBe("Alice");
    expect(entries[0].body).toBe("hello from alice");
  });

  it("records attachment placeholder in pending history for skipped attachment-only group messages", async () => {
    await expectSkippedGroupHistory(
      { attachments: [{ id: "a1" }], message: "" },
      "<media:attachment>",
    );
  });

  it("normalizes mixed-case parameterized attachment MIME in skipped pending history", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        groupHistories,
        historyLimit: 5,
        ignoreAttachments: false,
      }),
    );

    await handler(
      makeGroupEvent({
        attachments: [{ contentType: " Audio/Ogg; codecs=opus " }],
        message: "",
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("<media:audio>");
  });

  it("summarizes multiple skipped attachments with stable file count wording", async () => {
    const groupHistories = new Map();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createSignalConfig({ requireMention: true }),
        fetchAttachment: async ({ attachment }) => ({
          path: `/tmp/${String(attachment.id)}.bin`,
        }),
        groupHistories,
        historyLimit: 5,
        ignoreAttachments: false,
      }),
    );

    await handler(
      makeGroupEvent({
        attachments: [{ id: "a1" }, { id: "a2" }],
        message: "",
      }),
    );

    expect(capturedCtx).toBeUndefined();
    const entries = groupHistories.get("g1");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("[2 files attached]");
  });

  it("records quote text in pending history for skipped quote-only group messages", async () => {
    await expectSkippedGroupHistory({ message: "", quoteText: "quoted context" }, "quoted context");
  });

  it("bypasses mention gating for authorized control commands", async () => {
    const handler = createMentionHandler({ requireMention: true });

    await handler(makeGroupEvent({ message: "/help" }));
    expect(capturedCtx).toBeTruthy();
  });

  it("hydrates mention placeholders before trimming so offsets stay aligned", async () => {
    const handler = createMentionHandler({ requireMention: false });

    const placeholder = "\uFFFC";
    const message = `\n${placeholder} hi ${placeholder}`;
    const firstStart = message.indexOf(placeholder);
    const secondStart = message.indexOf(placeholder, firstStart + 1);

    await handler(
      makeGroupEvent({
        mentions: [
          { length: placeholder.length, start: firstStart, uuid: "123e4567" },
          { length: placeholder.length, number: "+15550002222", start: secondStart },
        ],
        message,
      }),
    );

    expect(capturedCtx).toBeTruthy();
    const body = String(getCapturedCtx()?.Body ?? "");
    expect(body).toContain("@123e4567 hi @+15550002222");
    expect(body).not.toContain(placeholder);
  });

  it("counts mention metadata replacements toward requireMention gating", async () => {
    const handler = createMentionHandler({
      mentionPattern: "@123e4567",
      requireMention: true,
    });

    const placeholder = "\uFFFC";
    const message = ` ${placeholder} ping`;
    const start = message.indexOf(placeholder);

    await handler(
      makeGroupEvent({
        mentions: [{ length: placeholder.length, start, uuid: "123e4567" }],
        message,
      }),
    );

    expect(capturedCtx).toBeTruthy();
    expect(String(getCapturedCtx()?.Body ?? "")).toContain("@123e4567");
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });
});

describe("renderSignalMentions", () => {
  const PLACEHOLDER = "\uFFFC";

  it("returns the original message when no mentions are provided", () => {
    const message = `${PLACEHOLDER} ping`;
    expect(renderSignalMentions(message, null)).toBe(message);
    expect(renderSignalMentions(message, [])).toBe(message);
  });

  it("replaces placeholder code points using mention metadata", () => {
    const message = `${PLACEHOLDER} hi ${PLACEHOLDER}!`;
    const normalized = renderSignalMentions(message, [
      { length: 1, start: 0, uuid: "abc-123" },
      { length: 1, number: "+15550005555", start: message.lastIndexOf(PLACEHOLDER) },
    ]);

    expect(normalized).toBe("@abc-123 hi @+15550005555!");
  });

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const normalized = renderSignalMentions(message, [
      { name: "ignored" },
      { length: 1, start: 0, uuid: "valid" },
      { length: 1, number: "+1555", start: 999 },
    ]);

    expect(normalized).toBe("@valid hi");
  });

  it("clamps and truncates fractional mention offsets", () => {
    const message = `${PLACEHOLDER} ping`;
    const normalized = renderSignalMentions(message, [{ length: 1.9, start: -0.7, uuid: "valid" }]);

    expect(normalized).toBe("@valid ping");
  });
});
