import { describe, expect, it } from "vitest";
import { pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  it.each([
    {
      entries: [
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ] as const,
      expected: [
        ["b", 2],
        ["c", 3],
      ],
      maxSize: 2.9,
      name: "keeps the newest entries after flooring fractional limits",
    },
    {
      entries: [
        ["a", 1],
        ["b", 2],
      ] as const,
      expected: [],
      maxSize: 0,
      name: "clears maps for zero limits",
    },
    {
      entries: [
        ["a", 1],
        ["b", 2],
      ] as const,
      expected: [],
      maxSize: -4,
      name: "clears maps for negative limits",
    },
    {
      entries: [["a", 1]] as const,
      expected: [["a", 1]],
      maxSize: 5,
      name: "leaves undersized maps untouched",
    },
  ])("$name", ({ entries, maxSize, expected }) => {
    const map = new Map(entries);
    pruneMapToMaxSize(map, maxSize);
    expect([...map.entries()]).toEqual(expected);
  });
});
