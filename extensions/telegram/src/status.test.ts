import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it } from "vitest";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import {
  buildTelegramStatusReactionVariants,
  extractTelegramAllowedEmojiReactions,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";

describe("collectTelegramStatusIssues", () => {
  it("reports privacy-mode and wildcard unmentioned-group configuration risks", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        allowUnmentionedGroups: true,
        audit: {
          hasWildcardUnmentionedGroups: true,
          unresolvedGroups: 2,
        },
        configured: true,
        enabled: true,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "main",
          channel: "telegram",
          kind: "config",
        }),
      ]),
    );
    expect(issues.some((issue) => issue.message.includes("privacy mode"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('uses "*"'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("unresolvedGroups=2"))).toBe(true);
  });

  it("reports unreachable groups with match metadata", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        audit: {
          groups: [
            {
              chatId: "-100123",
              error: "403",
              matchKey: "alerts",
              matchSource: "channels.telegram.groups",
              ok: false,
              status: "left",
            },
          ],
        },
        configured: true,
        enabled: true,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      accountId: "main",
      channel: "telegram",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("Group -100123 not reachable");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("channels.telegram.groups");
  });

  it("ignores accounts that are not both enabled and configured", () => {
    expect(
      collectTelegramStatusIssues([
        {
          accountId: "main",
          configured: true,
          enabled: false,
        } as ChannelAccountSnapshot,
      ]),
    ).toEqual([]);
  });
});

describe("resolveTelegramStatusReactionEmojis", () => {
  it("falls back to Telegram-safe defaults for empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "👀",
      overrides: {
        done: "\n",
        thinking: "   ",
      },
    });

    expect(result.queued).toBe("👀");
    expect(result.thinking).toBe(DEFAULT_EMOJIS.thinking);
    expect(result.done).toBe(DEFAULT_EMOJIS.done);
  });

  it("preserves explicit non-empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "👀",
      overrides: {
        done: "🎉",
        thinking: "🫡",
      },
    });

    expect(result.thinking).toBe("🫡");
    expect(result.done).toBe("🎉");
  });
});

describe("buildTelegramStatusReactionVariants", () => {
  it("puts requested emoji first and appends Telegram fallbacks", () => {
    const variants = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "🛠️",
    });

    expect(variants.get("🛠️")).toEqual(["🛠️", "👨‍💻", "🔥", "⚡"]);
  });
});

describe("isTelegramSupportedReactionEmoji", () => {
  it("accepts Telegram-supported reaction emojis", () => {
    expect(isTelegramSupportedReactionEmoji("👀")).toBe(true);
    expect(isTelegramSupportedReactionEmoji("👨‍💻")).toBe(true);
  });

  it("rejects unsupported emojis", () => {
    expect(isTelegramSupportedReactionEmoji("🫠")).toBe(false);
  });
});

describe("extractTelegramAllowedEmojiReactions", () => {
  it("returns undefined when chat does not include available_reactions", () => {
    const result = extractTelegramAllowedEmojiReactions({ id: 1 } satisfies TelegramChatDetails);
    expect(result).toBeUndefined();
  });

  it("returns null when available_reactions is omitted/null", () => {
    const result = extractTelegramAllowedEmojiReactions({
      available_reactions: null,
    } satisfies TelegramChatDetails);
    expect(result).toBeNull();
  });

  it("extracts emoji reactions only", () => {
    const result = extractTelegramAllowedEmojiReactions({
      available_reactions: [
        { emoji: "👍", type: "emoji" },
        { custom_emoji_id: "abc", type: "custom_emoji" },
        { emoji: "🔥", type: "emoji" },
      ],
    } satisfies TelegramChatDetails);
    expect(result ? [...result].toSorted() : null).toEqual(["👍", "🔥"]);
  });

  it("treats malformed available_reactions payloads as an empty allowlist instead of throwing", () => {
    expect(
      extractTelegramAllowedEmojiReactions({
        available_reactions: { emoji: "👍", type: "emoji" },
      } as never),
    ).toEqual(new Set<string>());
  });
});

describe("resolveTelegramAllowedEmojiReactions", () => {
  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat: TelegramGetChat = async () => ({
      available_reactions: [{ emoji: "👍", type: "emoji" }],
    });

    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 } satisfies TelegramChatDetails,
      chatId: 1,
      getChat,
    });

    expect(result ? [...result] : null).toEqual(["👍"]);
  });

  it("falls back to unrestricted reactions when getChat lookup fails", async () => {
    const getChat = async () => {
      throw new Error("lookup failed");
    };

    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 } satisfies TelegramChatDetails,
      chatId: 1,
      getChat,
    });

    expect(result).toBeNull();
  });
});

describe("resolveTelegramReactionVariant", () => {
  it("returns requested emoji when already Telegram-supported", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBe("👨‍💻");
  });

  it("returns first Telegram-supported fallback for unsupported requested emoji", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "🛠️",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "🛠️",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBe("👨‍💻");
  });

  it("uses generic Telegram fallbacks for unknown emojis", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "🫠",
      variantsByRequestedEmoji: new Map(),
    });

    expect(result).toBe("👍");
  });

  it("respects chat allowed reactions", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      allowedEmojiReactions: new Set(["👍"]),
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBe("👍");
  });

  it("returns undefined when no candidate is chat-allowed", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      allowedEmojiReactions: new Set(["🎉"]),
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for empty requested emoji", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "   ",
      variantsByRequestedEmoji: new Map(),
    });

    expect(result).toBeUndefined();
  });
});
