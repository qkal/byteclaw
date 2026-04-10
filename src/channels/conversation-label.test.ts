import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveConversationLabel } from "./conversation-label.js";

describe("resolveConversationLabel", () => {
  it.each([
    {
      ctx: { ChatType: "group", ConversationLabel: "Pinned Label" },
      expected: "Pinned Label",
      name: "prefers ConversationLabel when present",
    },
    {
      ctx: {
        ChatType: "group",
        From: "demo-channel:group:42",
        GroupSubject: "Ops",
        ThreadLabel: "Thread Alpha",
      },
      expected: "Thread Alpha",
      name: "prefers ThreadLabel over derived chat labels",
    },
    {
      ctx: { ChatType: "direct", From: "demo-channel:99", SenderName: "Ada" },
      expected: "Ada",
      name: "uses SenderName for direct chats when available",
    },
    {
      ctx: { ChatType: "direct", From: "demo-channel:99" },
      expected: "demo-channel:99",
      name: "falls back to From for direct chats when SenderName is missing",
    },
    {
      ctx: { ChatType: "group", From: "demo-channel:group:42", GroupSubject: "Ops" },
      expected: "Ops id:42",
      name: "derives numeric-id group labels",
    },
    {
      ctx: {
        ChatType: "channel",
        From: "slack:channel:C123",
        GroupSubject: "#general",
      },
      expected: "#general",
      name: "does not append ids for #rooms/channels",
    },
    {
      ctx: {
        ChatType: "group",
        From: "whatsapp:group:123@g.us",
        GroupSubject: "Family id:123@g.us",
      },
      expected: "Family id:123@g.us",
      name: "does not append ids when the base already contains the id",
    },
    {
      ctx: {
        ChatType: "group",
        From: "whatsapp:group:123@g.us",
        GroupSubject: "Family",
      },
      expected: "Family id:123@g.us",
      name: "appends ids for WhatsApp-like group ids when a subject exists",
    },
  ] satisfies { name: string; ctx: MsgContext; expected: string }[])(
    "$name",
    ({ ctx, expected }) => {
      expect(resolveConversationLabel(ctx)).toBe(expected);
    },
  );
});
