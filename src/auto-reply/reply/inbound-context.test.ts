import { describe, expect, it } from "vitest";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../channels/plugins/contracts/test-helpers.js";
import type { MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

describe("normalizeInboundTextNewlines", () => {
  it("normalizes real newlines and preserves literal backslash-n sequences", () => {
    const cases = [
      { expected: "hello\nworld", input: "hello\r\nworld" },
      { expected: "hello\nworld", input: "hello\rworld" },
      { expected: "C:\\Work\\nxxx\\README.md", input: "C:\\Work\\nxxx\\README.md" },
      {
        expected: "Please read the file at C:\\Work\\nxxx\\README.md",
        input: "Please read the file at C:\\Work\\nxxx\\README.md",
      },
      { expected: "C:\\new\\notes\\nested", input: "C:\\new\\notes\\nested" },
      { expected: "Line 1\nC:\\Work\\nxxx", input: "Line 1\r\nC:\\Work\\nxxx" },
    ] as const;

    for (const testCase of cases) {
      expect(normalizeInboundTextNewlines(testCase.input)).toBe(testCase.expected);
    }
  });
});

describe("inbound context contract (providers + extensions)", () => {
  const cases: { name: string; ctx: MsgContext }[] = [
    {
      ctx: {
        Body: "[WhatsApp 123@g.us] hi",
        ChatType: "group",
        CommandBody: "hi",
        From: "123@g.us",
        Provider: "whatsapp",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "whatsapp",
        To: "+15550001111",
      },
      name: "whatsapp group",
    },
    {
      ctx: {
        Body: "[Telegram group:123] hi",
        ChatType: "group",
        CommandBody: "hi",
        From: "group:123",
        GroupSubject: "Telegram Group",
        Provider: "telegram",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "telegram",
        To: "telegram:123",
      },
      name: "telegram group",
    },
    {
      ctx: {
        Body: "[Slack #general] hi",
        ChatType: "channel",
        CommandBody: "hi",
        From: "slack:channel:C123",
        GroupSubject: "#general",
        Provider: "slack",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "slack",
        To: "channel:C123",
      },
      name: "slack channel",
    },
    {
      ctx: {
        Body: "[Discord #general] hi",
        ChatType: "channel",
        CommandBody: "hi",
        From: "group:123",
        GroupSubject: "#general",
        Provider: "discord",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "discord",
        To: "channel:123",
      },
      name: "discord channel",
    },
    {
      ctx: {
        Body: "[Signal] hi",
        ChatType: "direct",
        CommandBody: "hi",
        From: "signal:+15550001111",
        Provider: "signal",
        RawBody: "hi",
        Surface: "signal",
        To: "signal:+15550002222",
      },
      name: "signal dm",
    },
    {
      ctx: {
        Body: "[iMessage Group] hi",
        ChatType: "group",
        CommandBody: "hi",
        From: "group:chat_id:123",
        GroupSubject: "iMessage Group",
        Provider: "imessage",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "imessage",
        To: "chat_id:123",
      },
      name: "imessage group",
    },
    {
      ctx: {
        Body: "[Matrix] hi",
        ChatType: "channel",
        CommandBody: "hi",
        From: "matrix:channel:!room:example.org",
        GroupSubject: "#general",
        Provider: "matrix",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "matrix",
        To: "room:!room:example.org",
      },
      name: "matrix channel",
    },
    {
      ctx: {
        Body: "[Teams] hi",
        ChatType: "channel",
        CommandBody: "hi",
        From: "msteams:channel:19:abc@thread.tacv2",
        GroupSubject: "Teams Channel",
        Provider: "msteams",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "msteams",
        To: "msteams:channel:19:abc@thread.tacv2",
      },
      name: "msteams channel",
    },
    {
      ctx: {
        Body: "[Zalo] hi",
        ChatType: "direct",
        CommandBody: "hi",
        From: "zalo:123",
        Provider: "zalo",
        RawBody: "hi",
        Surface: "zalo",
        To: "zalo:123",
      },
      name: "zalo dm",
    },
    {
      ctx: {
        Body: "[Zalo Personal] hi",
        ChatType: "group",
        CommandBody: "hi",
        From: "group:123",
        GroupSubject: "Zalouser Group",
        Provider: "zalouser",
        RawBody: "hi",
        SenderName: "Alice",
        Surface: "zalouser",
        To: "zalouser:123",
      },
      name: "zalouser group",
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const ctx = finalizeInboundContext({ ...entry.ctx });
      expectInboundContextContract(ctx);
    });
  }
});
