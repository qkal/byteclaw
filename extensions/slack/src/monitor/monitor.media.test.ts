import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSlackThreadStarterCacheForTest, resolveSlackThreadStarter } from "./media.js";

type ThreadStarterClient = Parameters<typeof resolveSlackThreadStarter>[0]["client"];

function createThreadStarterRepliesClient(
  response: { messages?: { text?: string; user?: string; ts?: string }[] } = {
    messages: [{ text: "root message", ts: "1000.1", user: "U1" }],
  },
): { replies: ReturnType<typeof vi.fn>; client: ThreadStarterClient } {
  const replies = vi.fn(async () => response);
  const client = {
    conversations: { replies },
  } as unknown as ThreadStarterClient;
  return { client, replies };
}

describe("resolveSlackThreadStarter cache", () => {
  afterEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.useRealTimers();
  });

  it("returns cached thread starter without refetching within ttl", async () => {
    const { replies, client } = createThreadStarterRepliesClient();

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("expires stale cache entries and refetches after ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { replies, client } = createThreadStarterRepliesClient();

    await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });

    vi.setSystemTime(new Date("2026-01-01T07:00:00.000Z"));
    await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });

    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not cache empty starter text", async () => {
    const { replies, client } = createThreadStarterRepliesClient({
      messages: [{ text: "   ", ts: "1000.1", user: "U1" }],
    });

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.1",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries once cache exceeds bounded size", async () => {
    const { replies, client } = createThreadStarterRepliesClient();

    for (let i = 0; i <= 2000; i += 1) {
      await resolveSlackThreadStarter({
        channelId: "C1",
        client,
        threadTs: `1000.${i}`,
      });
    }
    const callsAfterFill = replies.mock.calls.length;

    await resolveSlackThreadStarter({
      channelId: "C1",
      client,
      threadTs: "1000.0",
    });

    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
