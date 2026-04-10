import { describe, expect, it } from "vitest";
import { resolveEmojiAndHomepage } from "./entry-metadata.js";

describe("shared/entry-metadata", () => {
  it("prefers metadata emoji and homepage when present", () => {
    expect(
      resolveEmojiAndHomepage({
        frontmatter: { emoji: "🙂", homepage: "https://example.com" },
        metadata: { emoji: "🦀", homepage: " https://openclaw.ai " },
      }),
    ).toEqual({
      emoji: "🦀",
      homepage: "https://openclaw.ai",
    });
  });

  it("keeps metadata precedence even when metadata values are blank", () => {
    expect(
      resolveEmojiAndHomepage({
        frontmatter: { emoji: "🙂", homepage: "https://example.com" },
        metadata: { emoji: "", homepage: "   " },
      }),
    ).toEqual({});
  });

  it("falls back through frontmatter homepage aliases and drops blanks", () => {
    expect(
      resolveEmojiAndHomepage({
        frontmatter: { emoji: "🙂", website: " https://docs.openclaw.ai " },
      }),
    ).toEqual({
      emoji: "🙂",
      homepage: "https://docs.openclaw.ai",
    });
    expect(
      resolveEmojiAndHomepage({
        frontmatter: { url: "   " },
        metadata: { homepage: "   " },
      }),
    ).toEqual({});
    expect(
      resolveEmojiAndHomepage({
        frontmatter: { url: " https://openclaw.ai/install " },
      }),
    ).toEqual({
      homepage: "https://openclaw.ai/install",
    });
  });

  it("does not fall back once frontmatter homepage aliases are present but blank", () => {
    expect(
      resolveEmojiAndHomepage({
        frontmatter: {
          homepage: " ",
          url: "https://openclaw.ai/install",
          website: "https://docs.openclaw.ai",
        },
      }),
    ).toEqual({});
  });
});
