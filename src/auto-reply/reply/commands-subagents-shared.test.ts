import { describe, expect, it } from "vitest";
import { extractMessageText } from "./commands-subagents-text.js";

describe("extractMessageText", () => {
  it("preserves user markers and sanitizes assistant markers", () => {
    const cases = [
      {
        expectedText: "Here [Tool Call: foo (ID: 1)] ok",
        message: { content: "Here [Tool Call: foo (ID: 1)] ok", role: "user" },
      },
      {
        expectedText: "Here ok",
        message: { content: "Here [Tool Call: foo (ID: 1)] ok", role: "assistant" },
      },
    ] as const;

    for (const testCase of cases) {
      const result = extractMessageText(testCase.message);
      expect(result?.text).toBe(testCase.expectedText);
    }
  });
});
