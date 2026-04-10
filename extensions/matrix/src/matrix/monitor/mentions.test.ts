import { describe, expect, it, vi } from "vitest";

// Mock the runtime before importing resolveMentions
vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      mentions: {
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((p) => p.test(text)),
      },
    },
  }),
}));

import { resolveMentions } from "./mentions.js";

describe("resolveMentions", () => {
  const userId = "@bot:matrix.org";
  const mentionRegexes = [/@bot/i];

  describe("m.mentions field", () => {
    it("detects mention via m.mentions.user_ids when the visible text also mentions the bot", () => {
      const result = resolveMentions({
        content: {
          body: "hello @bot",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "hello @bot",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
      expect(result.hasExplicitMention).toBe(true);
    });

    it("does not trust forged m.mentions.user_ids without a visible mention", () => {
      const result = resolveMentions({
        content: {
          body: "hello",
          "m.mentions": { user_ids: ["@bot:matrix.org"] },
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "hello",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });

    it("detects room mention via visible @room text", () => {
      const result = resolveMentions({
        content: {
          body: "@room hello everyone",
          "m.mentions": { room: true },
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "@room hello everyone",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not trust forged m.mentions.room without visible @room text", () => {
      const result = resolveMentions({
        content: {
          body: "hello everyone",
          "m.mentions": { room: true },
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "hello everyone",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });

  describe("formatted_body matrix.to links", () => {
    it("detects mention in formatted_body with plain user ID", () => {
      const result = resolveMentions({
        content: {
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Bot</a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention in formatted_body with URL-encoded user ID", () => {
      const result = resolveMentions({
        content: {
          body: "Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/%40bot%3Amatrix.org">Bot</a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention with single quotes in href", () => {
      const result = resolveMentions({
        content: {
          body: "Bot: hello",
          formatted_body: "<a href='https://matrix.to/#/@bot:matrix.org'>Bot</a>: hello",
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("does not detect mention for different user ID", () => {
      const result = resolveMentions({
        content: {
          body: "Other: hello",
          formatted_body: '<a href="https://matrix.to/#/@other:matrix.org">Other</a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "Other: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not false-positive on partial user ID match", () => {
      const result = resolveMentions({
        content: {
          body: "Bot2: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot2:matrix.org">Bot2</a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "Bot2: hello",
        userId: "@bot:matrix.org",
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("does not trust hidden matrix.to links behind unrelated visible text", () => {
      const result = resolveMentions({
        content: {
          body: "click here: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">click here</a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "click here: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
    });

    it("detects mention when the visible label still names the bot", () => {
      const result = resolveMentions({
        content: {
          body: "@bot: hello",
          formatted_body:
            '<a href="https://matrix.to/#/@bot:matrix.org"><span>@bot</span></a>: hello',
          msgtype: "m.text",
        },
        mentionRegexes: [],
        text: "@bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label matches the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          body: "Wonderful Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Wonderful Bot</a>: hello',
          msgtype: "m.text",
        },
        displayName: "Wonderful Bot",
        mentionRegexes: [],
        text: "Wonderful Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("detects mention when the visible label encodes the bot's displayName", () => {
      const result = resolveMentions({
        content: {
          body: "R&D Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">R&amp;D Bot</a>: hello',
          msgtype: "m.text",
        },
        displayName: "R&D Bot",
        mentionRegexes: [],
        text: "R&D Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });

    it("ignores out-of-range hexadecimal HTML entities in visible labels", () => {
      expect(() =>
        resolveMentions({
          content: {
            body: "hello",
            formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">&#x110000;</a>: hello',
            msgtype: "m.text",
          },
          mentionRegexes: [],
          text: "hello",
          userId,
        }),
      ).not.toThrow();
    });

    it("ignores oversized decimal HTML entities in visible labels", () => {
      expect(() =>
        resolveMentions({
          content: {
            body: "hello",
            formatted_body:
              '<a href="https://matrix.to/#/@bot:matrix.org">&#9999999999999999999999999999999999999999;</a>: hello',
            msgtype: "m.text",
          },
          mentionRegexes: [],
          text: "hello",
          userId,
        }),
      ).not.toThrow();
    });

    it("does not detect mention when displayName is spoofed", () => {
      const result = resolveMentions({
        content: {
          body: "Spoofed Bot: hello",
          formatted_body: '<a href="https://matrix.to/#/@bot:matrix.org">Spoofed Bot</a>: hello',
          msgtype: "m.text",
        },
        displayName: "Alice",
        mentionRegexes: [],
        text: "Spoofed Bot: hello",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
    });
  });

  describe("regex patterns", () => {
    it("detects mention via regex pattern in body text", () => {
      const result = resolveMentions({
        content: {
          body: "hey @bot can you help?",
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "hey @bot can you help?",
        userId,
      });
      expect(result.wasMentioned).toBe(true);
    });
  });

  describe("no mention", () => {
    it("returns false when no mention is present", () => {
      const result = resolveMentions({
        content: {
          body: "hello world",
          msgtype: "m.text",
        },
        mentionRegexes,
        text: "hello world",
        userId,
      });
      expect(result.wasMentioned).toBe(false);
      expect(result.hasExplicitMention).toBe(false);
    });
  });
});
