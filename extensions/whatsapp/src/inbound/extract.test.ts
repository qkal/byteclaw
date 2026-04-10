import type { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { extractMentionedJids } from "./extract.js";

describe("extractMentionedJids", () => {
  const botJid = "5511999999999@s.whatsapp.net";
  const otherJid = "5511888888888@s.whatsapp.net";

  it("returns direct mentions from the current message", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
        text: "Hey @bot",
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("ignores mentionedJids from quoted messages", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: {
          // The quoted message originally @mentioned the bot, but the
          // Current message does not — this should NOT leak through.
          quotedMessage: {
            extendedTextMessage: {
              contextInfo: {
                mentionedJid: [botJid],
              },
              text: "Hey @bot what do you think?",
            },
          },
        },
        text: "I agree",
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns direct mentions even when quoted message also has mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: [otherJid],
          quotedMessage: {
            extendedTextMessage: {
              contextInfo: {
                mentionedJid: [botJid],
              },
              text: "Hey @bot",
            },
          },
        },
        text: "Hey @other",
      },
    };
    // Should return only the direct mention, not the quoted one.
    expect(extractMentionedJids(message)).toEqual([otherJid]);
  });

  it("returns mentions from media message types", () => {
    const message: proto.IMessage = {
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });

  it("returns undefined for messages with no mentions", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        text: "Just a regular message",
      },
    };
    expect(extractMentionedJids(message)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(extractMentionedJids(undefined)).toBeUndefined();
  });

  it("deduplicates mentions across message types", () => {
    const message: proto.IMessage = {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
        text: "Hey @bot",
      },
      imageMessage: {
        contextInfo: {
          mentionedJid: [botJid],
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([botJid]);
  });
});
