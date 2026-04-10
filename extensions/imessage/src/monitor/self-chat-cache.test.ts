import { describe, expect, it, vi } from "vitest";
import { createSelfChatCache } from "./self-chat-cache.js";

describe("createSelfChatCache", () => {
  const directLookup = {
    accountId: "default",
    isGroup: false,
    sender: "+15555550123",
  } as const;

  it("matches repeated lookups for the same scope, timestamp, and text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    cache.remember({
      ...directLookup,
      createdAt: 123,
      text: "  hello\r\nworld  ",
    });

    expect(
      cache.has({
        ...directLookup,
        createdAt: 123,
        text: "hello\nworld",
      }),
    ).toBe(true);
  });

  it("expires entries after the ttl window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    cache.remember({ ...directLookup, createdAt: 123, text: "hello" });

    vi.advanceTimersByTime(11_001);

    expect(cache.has({ ...directLookup, createdAt: 123, text: "hello" })).toBe(false);
  });

  it("evicts older entries when the cache exceeds its cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    for (let i = 0; i < 513; i += 1) {
      cache.remember({
        ...directLookup,
        createdAt: i,
        text: `message-${i}`,
      });
      vi.advanceTimersByTime(1001);
    }

    expect(cache.has({ ...directLookup, createdAt: 0, text: "message-0" })).toBe(false);
    expect(cache.has({ ...directLookup, createdAt: 512, text: "message-512" })).toBe(true);
  });

  it("does not collide long texts that differ only in the middle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T00:00:00Z"));

    const cache = createSelfChatCache();
    const prefix = "a".repeat(256);
    const suffix = "b".repeat(256);
    const longTextA = `${prefix}${"x".repeat(300)}${suffix}`;
    const longTextB = `${prefix}${"y".repeat(300)}${suffix}`;

    cache.remember({ ...directLookup, createdAt: 123, text: longTextA });

    expect(cache.has({ ...directLookup, createdAt: 123, text: longTextA })).toBe(true);
    expect(cache.has({ ...directLookup, createdAt: 123, text: longTextB })).toBe(false);
  });
});
