import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("ignores blank cache keys", () => {
    const cache = createDedupeCache({ maxSize: 10, ttlMs: 1000 });

    expect(cache.check("", 100)).toBe(false);
    expect(cache.check(undefined, 100)).toBe(false);
    expect(cache.peek(null, 100)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("keeps entries indefinitely when ttlMs is zero or negative", () => {
    const zeroTtlCache = createDedupeCache({ maxSize: 10, ttlMs: 0 });
    expect(zeroTtlCache.check("a", 100)).toBe(false);
    expect(zeroTtlCache.check("a", 10_000)).toBe(true);

    const negativeTtlCache = createDedupeCache({ maxSize: 10, ttlMs: -100 });
    expect(negativeTtlCache.check("b", 100)).toBe(false);
    expect(negativeTtlCache.peek("b", 10_000)).toBe(true);
  });

  it("touches duplicate reads so the newest key survives max-size pruning", () => {
    const cache = createDedupeCache({ maxSize: 2, ttlMs: 10_000 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.check("a", 300)).toBe(true);
    expect(cache.check("c", 400)).toBe(false);

    expect(cache.peek("a", 500)).toBe(true);
    expect(cache.peek("b", 500)).toBe(false);
    expect(cache.peek("c", 500)).toBe(true);
  });

  it("clears itself when maxSize floors to zero", () => {
    const cache = createDedupeCache({ maxSize: 0.9, ttlMs: 1000 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 200)).toBe(false);
  });

  it("supports explicit reset", () => {
    const cache = createDedupeCache({ maxSize: 10, ttlMs: 1000 });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.check("b", 200)).toBe(false);
    expect(cache.size()).toBe(2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.peek("a", 300)).toBe(false);
  });
});
