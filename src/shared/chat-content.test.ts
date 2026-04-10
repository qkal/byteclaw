import { describe, expect, it } from "vitest";
import { extractTextFromChatContent } from "./chat-content.js";

describe("shared/chat-content", () => {
  it("normalizes plain string content", () => {
    expect(extractTextFromChatContent("  hello\nworld  ")).toBe("hello world");
  });

  it("extracts only text blocks from array content", () => {
    expect(
      extractTextFromChatContent([
        { text: " hello ", type: "text" },
        { image_url: "https://example.com", type: "image_url" },
        { text: "world", type: "text" },
        { text: "ignored without type" },
        null,
      ]),
    ).toBe("hello world");
  });

  it("applies sanitizers and custom join/normalization hooks", () => {
    expect(
      extractTextFromChatContent("Here [Tool Call: foo (ID: 1)] ok", {
        sanitizeText: (text) => text.replace(/\[Tool Call:[^\]]+\]\s*/g, ""),
      }),
    ).toBe("Here ok");

    expect(
      extractTextFromChatContent(
        [
          { text: " hello ", type: "text" },
          { text: "world ", type: "text" },
        ],
        {
          joinWith: "\n",
          normalizeText: (text) => text.trim(),
          sanitizeText: (text) => text.trim(),
        },
      ),
    ).toBe("hello\nworld");

    expect(
      extractTextFromChatContent(
        [
          { text: "keep", type: "text" },
          { text: "drop", type: "text" },
        ],
        {
          sanitizeText: (text) => (text === "drop" ? "   " : text),
        },
      ),
    ).toBe("keep");
  });

  it("returns null for unsupported or empty content", () => {
    expect(extractTextFromChatContent(123)).toBeNull();
    expect(extractTextFromChatContent([{ text: "   ", type: "text" }])).toBeNull();
    expect(
      extractTextFromChatContent("  ", {
        sanitizeText: () => "",
      }),
    ).toBeNull();
  });

  it("tolerates sanitize and normalize hooks that return non-string values", () => {
    expect(
      extractTextFromChatContent("hello", {
        sanitizeText: () => undefined as unknown as string,
      }),
    ).toBeNull();
    expect(
      extractTextFromChatContent([{ text: "hello", type: "text" }], {
        sanitizeText: () => 42 as unknown as string,
      }),
    ).toBe("42");
    expect(
      extractTextFromChatContent("hello", {
        normalizeText: () => undefined as unknown as string,
      }),
    ).toBeNull();
  });
});
