import { describe, expect, it } from "vitest";
import { createExpiringMapCache, resolveCacheTtlMs } from "./cache-utils.js";

describe("resolveCacheTtlMs", () => {
  it("accepts exact non-negative integers", () => {
    expect(resolveCacheTtlMs({ defaultTtlMs: 60_000, envValue: "0" })).toBe(0);
    expect(resolveCacheTtlMs({ defaultTtlMs: 60_000, envValue: "120000" })).toBe(120_000);
  });

  it("rejects malformed env values and falls back to the default", () => {
    expect(resolveCacheTtlMs({ defaultTtlMs: 60_000, envValue: "0abc" })).toBe(60_000);
    expect(resolveCacheTtlMs({ defaultTtlMs: 60_000, envValue: "15ms" })).toBe(60_000);
  });
});

describe("createExpiringMapCache", () => {
  it("expires entries on read after the TTL", () => {
    let now = 1000;
    const cache = createExpiringMapCache<string, string>({
      clock: () => now,
      ttlMs: 5000,
    });

    cache.set("alpha", "a");
    expect(cache.get("alpha")).toBe("a");

    now = 6001;
    expect(cache.get("alpha")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("supports dynamic TTLs and opportunistic pruning", () => {
    let now = 1000;
    let ttlMs = 5000;
    const cache = createExpiringMapCache<string, string>({
      clock: () => now,
      pruneIntervalMs: 1000,
      ttlMs: () => ttlMs,
    });

    cache.set("stale", "old");
    now = 7000;
    ttlMs = 2000;

    cache.set("fresh", "new");

    expect(cache.get("stale")).toBeUndefined();
    expect(cache.keys()).toEqual(["fresh"]);
  });
});
