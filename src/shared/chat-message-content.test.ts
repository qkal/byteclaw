import { describe, expect, it } from "vitest";
import {
  extractAssistantTextForPhase,
  extractAssistantVisibleText,
  extractFirstTextBlock,
  resolveAssistantMessagePhase,
} from "./chat-message-content.js";

describe("shared/chat-message-content", () => {
  it("extracts the first text block from array content", () => {
    expect(
      extractFirstTextBlock({
        content: [{ text: "hello" }, { text: "world" }],
      }),
    ).toBe("hello");
  });

  it("returns plain string content", () => {
    expect(
      extractFirstTextBlock({
        content: "hello from string content",
      }),
    ).toBe("hello from string content");
  });

  it("preserves empty-string text in the first block", () => {
    expect(
      extractFirstTextBlock({
        content: [{ text: "" }, { text: "later" }],
      }),
    ).toBe("");
  });

  it("only considers the first content block even if later blocks have text", () => {
    expect(
      extractFirstTextBlock({
        content: [null, { text: "later" }],
      }),
    ).toBeUndefined();
    expect(
      extractFirstTextBlock({
        content: [{ type: "image" }, { text: "later" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for missing, empty, or non-text content", () => {
    expect(extractFirstTextBlock(null)).toBeUndefined();
    expect(extractFirstTextBlock({ content: [] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: [{ type: "image" }] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: ["hello"] })).toBeUndefined();
    expect(extractFirstTextBlock({ content: [{ text: 1 }, { text: "later" }] })).toBeUndefined();
  });
});

describe("extractAssistantVisibleText", () => {
  it("preserves boundary spacing when joining adjacent final_answer text blocks", () => {
    expect(
      extractAssistantTextForPhase(
        {
          content: [
            {
              text: "Hi ",
              textSignature: JSON.stringify({ v: 1, id: "msg_final_1", phase: "final_answer" }),
              type: "text",
            },
            {
              text: "there",
              textSignature: JSON.stringify({ v: 1, id: "msg_final_2", phase: "final_answer" }),
              type: "text",
            },
          ],
          role: "assistant",
        },
        { joinWith: "", phase: "final_answer" },
      ),
    ).toBe("Hi there");
  });

  it("prefers final_answer text over commentary text", () => {
    expect(
      extractAssistantVisibleText({
        content: [
          {
            text: "thinking like caveman",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            type: "text",
          },
          {
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        role: "assistant",
      }),
    ).toBe("Actual final answer");
  });

  it("does not fall back to commentary-only text", () => {
    expect(
      extractAssistantVisibleText({
        content: [
          {
            text: "thinking like caveman",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            type: "text",
          },
        ],
        role: "assistant",
      }),
    ).toBeUndefined();
  });

  it("does not fall back to unphased legacy text when final_answer is empty", () => {
    expect(
      extractAssistantVisibleText({
        content: [
          { text: "Legacy answer", type: "text" },
          {
            text: "   ",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        role: "assistant",
      }),
    ).toBeUndefined();
  });

  it("falls back to unphased legacy text", () => {
    expect(
      extractAssistantVisibleText({
        content: [{ text: "Legacy answer", type: "text" }],
        role: "assistant",
      }),
    ).toBe("Legacy answer");
  });

  it("does not mix unphased legacy text into final_answer output", () => {
    expect(
      extractAssistantVisibleText({
        content: [
          { text: "Legacy answer", type: "text" },
          {
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        phase: "final_answer",
        role: "assistant",
      }),
    ).toBe("Actual final answer");
  });
});

describe("resolveAssistantMessagePhase", () => {
  it("prefers the top-level assistant phase when present", () => {
    expect(resolveAssistantMessagePhase({ phase: "commentary", role: "assistant" })).toBe(
      "commentary",
    );
  });

  it("resolves a single explicit phase from textSignature metadata", () => {
    expect(
      resolveAssistantMessagePhase({
        content: [
          {
            text: "Actual final answer",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        role: "assistant",
      }),
    ).toBe("final_answer");
  });

  it("returns undefined when text blocks contain mixed explicit phases", () => {
    expect(
      resolveAssistantMessagePhase({
        content: [
          {
            text: "Working...",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            type: "text",
          },
          {
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            type: "text",
          },
        ],
        role: "assistant",
      }),
    ).toBeUndefined();
  });
});
