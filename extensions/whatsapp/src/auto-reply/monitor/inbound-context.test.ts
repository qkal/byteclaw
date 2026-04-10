import { describe, expect, it } from "vitest";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";

describe("whatsapp inbound context visibility", () => {
  it("filters non-allowlisted group history from supplemental context", () => {
    const history = resolveVisibleWhatsAppGroupHistory({
      groupAllowFrom: ["+111"],
      groupPolicy: "allowlist",
      history: [
        {
          body: "Allowed context",
          sender: "Alice (+111)",
          senderJid: "111@s.whatsapp.net",
        },
        {
          body: "Blocked context",
          sender: "Mallory (+999)",
          senderJid: "999@s.whatsapp.net",
        },
      ],
      mode: "allowlist",
    });

    expect(history).toEqual([
      expect.objectContaining({
        body: "Allowed context",
        sender: "Alice (+111)",
      }),
    ]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      groupAllowFrom: ["+111"],
      groupPolicy: "allowlist",
      mode: "allowlist",
      msg: {
        body: "Current message",
        chatType: "group",
        conversationId: "123@g.us",
        from: "123@g.us",
        id: "msg-reply-1",
        replyToBody: "Blocked quoted text",
        replyToId: "blocked-reply",
        replyToSender: "Mallory (+999)",
        replyToSenderJid: "999@s.whatsapp.net",
        selfE164: "+999",
        senderE164: "+111",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        to: "+2000",
      },
    } as Parameters<typeof resolveVisibleWhatsAppReplyContext>[0]);

    expect(reply).toBeNull();
  });

  it("keeps blocked quoted replies in allowlist_quote mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      groupAllowFrom: ["+111"],
      groupPolicy: "allowlist",
      mode: "allowlist_quote",
      msg: {
        body: "Current message",
        chatType: "group",
        conversationId: "123@g.us",
        from: "123@g.us",
        id: "msg-reply-2",
        replyToBody: "Blocked quoted text",
        replyToId: "blocked-reply",
        replyToSender: "Mallory (+999)",
        replyToSenderJid: "999@s.whatsapp.net",
        selfE164: "+999",
        senderE164: "+111",
        senderJid: "111@s.whatsapp.net",
        senderName: "Alice",
        to: "+2000",
      },
    } as Parameters<typeof resolveVisibleWhatsAppReplyContext>[0]);

    expect(reply).toMatchObject({
      body: "Blocked quoted text",
      id: "blocked-reply",
      sender: expect.objectContaining({
        label: "Mallory (+999)",
      }),
    });
  });
});
