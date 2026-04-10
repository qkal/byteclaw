import { describe, expect, it } from "vitest";
import {
  attachChannelToResult,
  attachChannelToResults,
  buildChannelSendResult,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  createRawChannelSendResultAdapter,
} from "./channel-send-result.js";

describe("attachChannelToResult(s)", () => {
  it("stamps channel metadata on single and batch results", () => {
    expect(
      attachChannelToResult("discord", {
        extra: "value",
        messageId: "m1",
        ok: true,
      }),
    ).toEqual({
      channel: "discord",
      extra: "value",
      messageId: "m1",
      ok: true,
    });

    expect(
      attachChannelToResults("signal", [
        { messageId: "m1", timestamp: 1 },
        { messageId: "m2", timestamp: 2 },
      ]),
    ).toEqual([
      { channel: "signal", messageId: "m1", timestamp: 1 },
      { channel: "signal", messageId: "m2", timestamp: 2 },
    ]);
  });
});

describe("buildChannelSendResult", () => {
  it("normalizes raw send results", () => {
    const result = buildChannelSendResult("zalo", {
      error: "boom",
      messageId: null,
      ok: false,
    });

    expect(result.channel).toBe("zalo");
    expect(result.ok).toBe(false);
    expect(result.messageId).toBe("");
    expect(result.error).toEqual(new Error("boom"));
  });
});

describe("createEmptyChannelResult", () => {
  it("builds an empty outbound result with channel metadata", () => {
    expect(createEmptyChannelResult("line", { chatId: "u1" })).toEqual({
      channel: "line",
      chatId: "u1",
      messageId: "",
    });
  });
});

describe("createAttachedChannelResultAdapter", () => {
  it("wraps outbound delivery and poll results", async () => {
    const adapter = createAttachedChannelResultAdapter({
      channel: "discord",
      sendMedia: async () => ({ messageId: "m2" }),
      sendPoll: async () => ({ messageId: "m3", pollId: "p1" }),
      sendText: async () => ({ channelId: "c1", messageId: "m1" }),
    });

    const sendCases = [
      {
        expected: {
          channel: "discord",
          channelId: "c1",
          messageId: "m1",
        },
        name: "sendText",
        run: () => adapter.sendText!({ cfg: {} as never, text: "hi", to: "x" }),
      },
      {
        expected: {
          channel: "discord",
          messageId: "m2",
        },
        name: "sendMedia",
        run: () => adapter.sendMedia!({ cfg: {} as never, text: "hi", to: "x" }),
      },
      {
        expected: {
          channel: "discord",
          messageId: "m3",
          pollId: "p1",
        },
        name: "sendPoll",
        run: () =>
          adapter.sendPoll!({
            cfg: {} as never,
            poll: { options: ["a", "b"], question: "t" },
            to: "x",
          }),
      },
    ];

    for (const testCase of sendCases) {
      await expect(testCase.run()).resolves.toEqual(testCase.expected);
    }
  });
});

describe("createRawChannelSendResultAdapter", () => {
  it("normalizes raw send results", async () => {
    const adapter = createRawChannelSendResultAdapter({
      channel: "zalo",
      sendMedia: async () => ({ error: "boom", ok: false }),
      sendText: async () => ({ messageId: "m1", ok: true }),
    });

    const sendCases = [
      {
        expected: {
          channel: "zalo",
          error: undefined,
          messageId: "m1",
          ok: true,
        },
        name: "sendText",
        run: () => adapter.sendText!({ cfg: {} as never, text: "hi", to: "x" }),
      },
      {
        expected: {
          channel: "zalo",
          error: new Error("boom"),
          messageId: "",
          ok: false,
        },
        name: "sendMedia",
        run: () => adapter.sendMedia!({ cfg: {} as never, text: "hi", to: "x" }),
      },
    ];

    for (const testCase of sendCases) {
      await expect(testCase.run()).resolves.toEqual(testCase.expected);
    }
  });
});
