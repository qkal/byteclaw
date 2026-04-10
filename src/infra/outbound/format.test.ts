import { describe, expect, it, vi } from "vitest";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "./format.js";

const getChannelPluginMock = vi.hoisted(() => vi.fn((_channel: unknown) => undefined));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));
describe("formatOutboundDeliverySummary", () => {
  it.each([
    {
      channel: "telegram" as const,
      expected: "✅ Sent via Telegram. Message ID: unknown",
      result: undefined,
    },
    {
      channel: "imessage" as const,
      expected: "✅ Sent via iMessage. Message ID: unknown",
      result: undefined,
    },
    {
      channel: "telegram" as const,
      expected: "✅ Sent via Telegram. Message ID: m1 (chat c1)",
      result: {
        channel: "telegram" as const,
        chatId: "c1",
        messageId: "m1",
      },
    },
    {
      channel: "discord" as const,
      expected: "✅ Sent via Discord. Message ID: d1 (channel chan)",
      result: {
        channel: "discord" as const,
        channelId: "chan",
        messageId: "d1",
      },
    },
    {
      channel: "slack" as const,
      expected: "✅ Sent via Slack. Message ID: s1 (room room-1)",
      result: {
        channel: "slack" as const,
        messageId: "s1",
        roomId: "room-1",
      },
    },
    {
      channel: "msteams" as const,
      expected: "✅ Sent via Microsoft Teams. Message ID: t1 (conversation conv-1)",
      result: {
        channel: "msteams" as const,
        conversationId: "conv-1",
        messageId: "t1",
      },
    },
  ])("formats delivery summary for %j", ({ channel, result, expected }) => {
    expect(formatOutboundDeliverySummary(channel, result)).toBe(expected);
  });
});

describe("buildOutboundDeliveryJson", () => {
  it.each([
    {
      expected: {
        channel: "telegram",
        chatId: "c1",
        mediaUrl: "https://example.com/a.png",
        messageId: "m1",
        to: "123",
        via: "direct",
      },
      input: {
        channel: "telegram" as const,
        mediaUrl: "https://example.com/a.png",
        result: { channel: "telegram" as const, chatId: "c1", messageId: "m1" },
        to: "123",
      },
    },
    {
      expected: {
        channel: "whatsapp",
        mediaUrl: null,
        messageId: "w1",
        to: "+1",
        toJid: "jid",
        via: "direct",
      },
      input: {
        channel: "whatsapp" as const,
        result: { channel: "whatsapp" as const, messageId: "w1", toJid: "jid" },
        to: "+1",
      },
    },
    {
      expected: {
        channel: "signal",
        mediaUrl: null,
        messageId: "s1",
        timestamp: 123,
        to: "+1",
        via: "direct",
      },
      input: {
        channel: "signal" as const,
        result: { channel: "signal" as const, messageId: "s1", timestamp: 123 },
        to: "+1",
      },
    },
    {
      expected: {
        channel: "discord",
        channelId: "1",
        mediaUrl: null,
        messageId: "g1",
        meta: { thread: "2" },
        to: "channel:1",
        via: "gateway",
      },
      input: {
        channel: "discord" as const,
        result: {
          channelId: "1",
          messageId: "g1",
          meta: { thread: "2" },
        },
        to: "channel:1",
        via: "gateway" as const,
      },
    },
  ])("builds delivery JSON for %j", ({ input, expected }) => {
    expect(buildOutboundDeliveryJson(input)).toEqual(expected);
  });
});

describe("formatGatewaySummary", () => {
  it.each([
    {
      expected: "✅ Sent via gateway (whatsapp). Message ID: m1",
      input: { channel: "whatsapp", messageId: "m1" },
    },
    {
      expected: "✅ Poll sent via gateway (discord). Message ID: p1",
      input: { action: "Poll sent", channel: "discord", messageId: "p1" },
    },
    {
      expected: "✅ Sent via gateway. Message ID: unknown",
      input: {},
    },
  ])("formats gateway summary for %j", ({ input, expected }) => {
    expect(formatGatewaySummary(input)).toBe(expected);
  });
});
