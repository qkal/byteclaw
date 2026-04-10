import { describe, expect, it } from "vitest";
import { stripThoughtSignatures } from "./bootstrap.js";

describe("stripThoughtSignatures", () => {
  it("preserves thinkingSignature while still stripping invalid thought signatures", () => {
    const thinkingBlock = {
      thinking: "internal",
      thinkingSignature: "keep_me",
      thoughtSignature: "msg_123",
      type: "thinking",
    };
    const redactedBlock = {
      redacted_thinking: "...",
      thinkingSignature: "keep_me_too",
      thoughtSignature: "msg_456",
      type: "redacted_thinking",
    };
    const textBlock = {
      text: "visible",
      thoughtSignature: "msg_789",
      type: "text",
    };

    const result = stripThoughtSignatures([thinkingBlock, redactedBlock, textBlock], {
      includeCamelCase: true,
    });

    expect(result[0]).toEqual({
      thinking: "internal",
      thinkingSignature: "keep_me",
      type: "thinking",
    });
    expect(result[1]).toEqual({
      redacted_thinking: "...",
      thinkingSignature: "keep_me_too",
      type: "redacted_thinking",
    });
    expect(result[2]).toEqual({
      text: "visible",
      type: "text",
    });
  });
});
