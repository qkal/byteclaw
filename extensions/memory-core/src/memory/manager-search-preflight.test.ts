import { describe, expect, it } from "vitest";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";

describe("memory manager search preflight", () => {
  it("skips search and provider init for blank queries", () => {
    expect(
      resolveMemorySearchPreflight({
        hasIndexedContent: true,
        query: "   ",
      }),
    ).toEqual({
      normalizedQuery: "",
      shouldInitializeProvider: false,
      shouldSearch: false,
    });
  });

  it("skips provider init when the index is empty", () => {
    expect(
      resolveMemorySearchPreflight({
        hasIndexedContent: false,
        query: "hello",
      }),
    ).toEqual({
      normalizedQuery: "hello",
      shouldInitializeProvider: false,
      shouldSearch: false,
    });
  });

  it("allows provider init when query and indexed content are present", () => {
    expect(
      resolveMemorySearchPreflight({
        hasIndexedContent: true,
        query: " hello ",
      }),
    ).toEqual({
      normalizedQuery: "hello",
      shouldInitializeProvider: true,
      shouldSearch: true,
    });
  });
});
