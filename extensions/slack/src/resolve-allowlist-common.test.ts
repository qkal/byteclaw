import { describe, expect, it, vi } from "vitest";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries,
} from "./resolve-allowlist-common.js";

describe("collectSlackCursorItems", () => {
  it("collects items across cursor pages", async () => {
    interface MockPage {
      items: string[];
      response_metadata?: { next_cursor?: string };
    }
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: ["a", "b"],
        response_metadata: { next_cursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        items: ["c"],
        response_metadata: { next_cursor: "" },
      });

    const items = await collectSlackCursorItems<string, MockPage>({
      collectPageItems: (response) => response.items,
      fetchPage,
    });

    expect(items).toEqual(["a", "b", "c"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("resolveSlackAllowlistEntries", () => {
  it("handles id, non-id, and unresolved entries", () => {
    const results = resolveSlackAllowlistEntries({
      buildIdResolved: ({ input, match }) => ({ input, name: match?.name, resolved: true }),
      buildUnresolved: (input) => ({ input, resolved: false }),
      entries: ["id:1", "name:beta", "missing"],
      findById: (lookup, id) => lookup.find((entry) => entry.id === id),
      lookup: [
        { id: "1", name: "alpha" },
        { id: "2", name: "beta" },
      ],
      parseInput: (input) => {
        if (input.startsWith("id:")) {
          return { id: input.slice("id:".length) };
        }
        if (input.startsWith("name:")) {
          return { name: input.slice("name:".length) };
        }
        return {};
      },
      resolveNonId: ({ input, parsed, lookup }) => {
        const {name} = (parsed as { name?: string });
        if (!name) {
          return undefined;
        }
        const match = lookup.find((entry) => entry.name === name);
        return match ? { input, name: match.name, resolved: true } : undefined;
      },
    });

    expect(results).toEqual([
      { input: "id:1", name: "alpha", resolved: true },
      { input: "name:beta", name: "beta", resolved: true },
      { input: "missing", resolved: false },
    ]);
  });
});
