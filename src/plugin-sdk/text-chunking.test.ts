import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./text-chunking.js";

describe("chunkTextForOutbound", () => {
  it.each([
    {
      expected: [],
      maxLen: 10,
      name: "returns empty for empty input",
      text: "",
    },
    {
      expected: ["alpha", "beta", "gamma"],
      maxLen: 8,
      name: "splits on newline or whitespace boundaries",
      text: "alpha\nbeta gamma",
    },
    {
      expected: ["abcd", "efgh", "ij"],
      maxLen: 4,
      name: "falls back to hard limit when no separator exists",
      text: "abcdefghij",
    },
  ])("$name", ({ text, maxLen, expected }) => {
    expect(chunkTextForOutbound(text, maxLen)).toEqual(expected);
  });
});
