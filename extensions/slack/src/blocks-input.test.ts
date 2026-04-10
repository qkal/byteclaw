import { describe, expect, it } from "vitest";
import { parseSlackBlocksInput } from "./blocks-input.js";

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ text: { text: "hi", type: "mrkdwn" }, type: "section" }]);
  });

  it("rejects invalid block payloads", () => {
    const cases = [
      {
        expectedMessage: /valid JSON/i,
        input: "{bad-json",
        name: "invalid JSON",
      },
      {
        expectedMessage: /must be an array/i,
        input: { type: "divider" },
        name: "non-array payload",
      },
      {
        expectedMessage: /at least one block/i,
        input: [],
        name: "empty array",
      },
      {
        expectedMessage: /must be an object/i,
        input: ["not-a-block"],
        name: "non-object block",
      },
      {
        expectedMessage: /non-empty string type/i,
        input: [{}],
        name: "missing block type",
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => parseSlackBlocksInput(testCase.input), testCase.name).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});
