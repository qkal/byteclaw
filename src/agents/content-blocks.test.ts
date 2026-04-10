import { describe, expect, it } from "vitest";
import { collectTextContentBlocks } from "./content-blocks.js";

describe("collectTextContentBlocks", () => {
  it("collects text content blocks in order", () => {
    const blocks = [
      { text: "first", type: "text" },
      { data: "abc", type: "image" },
      { text: "second", type: "text" },
    ];

    expect(collectTextContentBlocks(blocks)).toEqual(["first", "second"]);
  });

  it("ignores invalid entries and non-arrays", () => {
    expect(collectTextContentBlocks(null)).toEqual([]);
    expect(collectTextContentBlocks([{ text: 1, type: "text" }, undefined, "x"])).toEqual([]);
  });
});
