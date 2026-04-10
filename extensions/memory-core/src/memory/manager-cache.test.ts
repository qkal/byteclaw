import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ManagedCache,
  closeManagedCacheEntries,
  getOrCreateManagedCacheEntry,
  resolveSingletonManagedCache,
} from "./manager-cache.js";

interface TestEntry {
  id: string;
  close: () => Promise<void>;
}

function createTestCache(): ManagedCache<TestEntry> {
  return resolveSingletonManagedCache<TestEntry>(Symbol("openclaw.manager-cache.test"));
}

function createEntry(id: string): TestEntry {
  return {
    close: vi.fn(async () => {}),
    id,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("manager cache", () => {
  const cachesForCleanup: ManagedCache<TestEntry>[] = [];

  afterEach(async () => {
    await Promise.all(
      cachesForCleanup.splice(0).map((cache) =>
        closeManagedCacheEntries({
          cache: cache.cache,
          pending: cache.pending,
        }),
      ),
    );
  });

  it("deduplicates concurrent creation for the same cache key", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await getOrCreateManagedCacheEntry({
            cache: cache.cache,
            create: async () => {
              createCalls += 1;
              await Promise.resolve();
              return createEntry("shared");
            },
            key: "same",
            pending: cache.pending,
          }),
      ),
    );

    expect(results).toHaveLength(12);
    expect(new Set(results).size).toBe(1);
    expect(createCalls).toBe(1);
  });

  it("waits for pending creation before global teardown closes cached entries", async () => {
    const cache = createTestCache();
    const first = createEntry("first");
    const second = createEntry("second");
    cachesForCleanup.push(cache);
    const gate = createDeferred<void>();

    const pendingFirst = getOrCreateManagedCacheEntry({
      cache: cache.cache,
      create: async () => {
        await gate.promise;
        return first;
      },
      key: "same",
      pending: cache.pending,
    });

    const teardown = closeManagedCacheEntries({
      cache: cache.cache,
      pending: cache.pending,
    });
    gate.resolve();

    await teardown;
    expect(first.close).toHaveBeenCalledTimes(1);

    const resolvedFirst = await pendingFirst;
    const resolvedSecond = await getOrCreateManagedCacheEntry({
      cache: cache.cache,
      create: async () => second,
      key: "same",
      pending: cache.pending,
    });

    expect(resolvedFirst).toBe(first);
    expect(resolvedSecond).toBe(second);
    expect(resolvedSecond).not.toBe(resolvedFirst);
  });

  it("bypasses identity caching for status-only callers", async () => {
    const cache = createTestCache();
    cachesForCleanup.push(cache);
    let createCalls = 0;

    const first = await getOrCreateManagedCacheEntry({
      bypassCache: true,
      cache: cache.cache,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
      key: "same",
      pending: cache.pending,
    });
    const second = await getOrCreateManagedCacheEntry({
      bypassCache: true,
      cache: cache.cache,
      create: async () => {
        createCalls += 1;
        return createEntry(`status-${createCalls}`);
      },
      key: "same",
      pending: cache.pending,
    });

    expect(first).not.toBe(second);
    expect(createCalls).toBe(2);
    expect(cache.cache.size).toBe(0);
  });
});
