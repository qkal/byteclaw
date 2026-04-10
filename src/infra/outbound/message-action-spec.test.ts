import { describe, expect, it } from "vitest";
import { actionHasTarget, actionRequiresTarget } from "./message-action-spec.js";

describe("actionRequiresTarget", () => {
  it.each([
    ["send", true],
    ["channel-info", true],
    ["broadcast", false],
    ["search", false],
  ])("returns %s for %s", (action, expected) => {
    expect(actionRequiresTarget(action as never)).toBe(expected);
  });
});

describe("actionHasTarget", () => {
  it.each([
    { action: "send", expected: true, params: { to: "  channel:C1  " } },
    { action: "channel-info", expected: true, params: { channelId: "  C123  " } },
    { action: "send", expected: false, params: { channelId: "", to: "   " } },
    {
      action: "read",
      ctx: { channel: "feishu" },
      expected: true,
      params: { messageId: "msg_123" },
    },
    { action: "edit", expected: true, params: { messageId: "  msg_123  " } },
    {
      action: "pin",
      ctx: { channel: "feishu" },
      expected: true,
      params: { messageId: "msg_123" },
    },
    {
      action: "unpin",
      ctx: { channel: "feishu" },
      expected: true,
      params: { messageId: "msg_123" },
    },
    {
      action: "list-pins",
      ctx: { channel: "feishu" },
      expected: true,
      params: { chatId: "oc_123" },
    },
    {
      action: "channel-info",
      ctx: { channel: "feishu" },
      expected: true,
      params: { chatId: "oc_123" },
    },
    { action: "react", expected: true, params: { chatGuid: "chat-guid" } },
    { action: "react", expected: true, params: { chatIdentifier: "chat-id" } },
    { action: "react", expected: true, params: { chatId: 42 } },
    { action: "read", expected: false, params: { messageId: "msg_123" } },
    {
      action: "pin",
      ctx: { channel: "slack" },
      expected: false,
      params: { messageId: "msg_123" },
    },
    {
      action: "channel-info",
      ctx: { channel: "discord" },
      expected: false,
      params: { chatId: "oc_123" },
    },
    { action: "edit", expected: false, params: { messageId: "   " } },
    { action: "react", expected: false, params: { chatGuid: "" } },
    { action: "react", expected: false, params: { chatId: Number.NaN } },
    { action: "react", expected: false, params: { chatId: Number.POSITIVE_INFINITY } },
    {
      action: "send",
      expected: false,
      params: { chatId: 42, messageId: "msg_123" },
    },
  ])("resolves target presence for %j", ({ action, params, ctx, expected }) => {
    expect(actionHasTarget(action as never, params, ctx)).toBe(expected);
  });
});
