import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

function createGuildListProbeFetcher() {
  let guildsCalled = false;
  const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.endsWith("/users/@me/guilds")) {
      guildsCalled = true;
      return jsonResponse([]);
    }
    return new Response("not found", { status: 404 });
  });
  return {
    fetcher,
    wasGuildsCalled: () => guildsCalled,
  };
}

function createGuildsForbiddenFetcher() {
  return withFetchPreconnect(async (input: RequestInfo | URL) => {
    const url = urlToString(input);
    if (url.endsWith("/users/@me/guilds")) {
      throw new Error("Forbidden: Missing Access");
    }
    return new Response("not found", { status: 404 });
  });
}

describe("resolveDiscordUserAllowlist", () => {
  it("resolves plain user ids without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      entries: ["123456789012345678"],
      fetcher,
      token: "test",
    });

    expect(results).toEqual([
      {
        id: "123456789012345678",
        input: "123456789012345678",
        resolved: true,
      },
    ]);
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves mention-format ids without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      entries: ["<@!123456789012345678>"],
      fetcher,
      token: "test",
    });

    expect(results).toEqual([
      {
        id: "123456789012345678",
        input: "<@!123456789012345678>",
        resolved: true,
      },
    ]);
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves prefixed ids (user:, discord:) without calling listGuilds", async () => {
    const { fetcher, wasGuildsCalled } = createGuildListProbeFetcher();

    const results = await resolveDiscordUserAllowlist({
      entries: ["user:111", "discord:222"],
      fetcher,
      token: "test",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "111", resolved: true });
    expect(results[1]).toMatchObject({ id: "222", resolved: true });
    expect(wasGuildsCalled()).toBe(false);
  });

  it("resolves user ids even when listGuilds would fail", async () => {
    const fetcher = createGuildsForbiddenFetcher();

    // Before the fix, this would throw because listGuilds() was called eagerly
    const results = await resolveDiscordUserAllowlist({
      entries: ["994979735488692324"],
      fetcher,
      token: "test",
    });

    expect(results).toEqual([
      {
        id: "994979735488692324",
        input: "994979735488692324",
        resolved: true,
      },
    ]);
  });

  it("calls listGuilds lazily when resolving usernames", async () => {
    let guildsCalled = false;
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        guildsCalled = true;
        return jsonResponse([{ id: "g1", name: "Test Guild" }]);
      }
      if (url.includes("/guilds/g1/members/search")) {
        return jsonResponse([
          {
            nick: null,
            user: { bot: false, id: "u1", username: "alice" },
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      entries: ["alice"],
      fetcher,
      token: "test",
    });

    expect(guildsCalled).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "u1",
      input: "alice",
      name: "alice",
      resolved: true,
    });
  });

  it("fetches guilds only once for multiple username entries", async () => {
    let guildsCallCount = 0;
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        guildsCallCount++;
        return jsonResponse([{ id: "g1", name: "Test Guild" }]);
      }
      if (url.includes("/guilds/g1/members/search")) {
        const params = new URL(url).searchParams;
        const query = params.get("query") ?? "";
        return jsonResponse([
          {
            nick: null,
            user: { bot: false, id: `u-${query}`, username: query },
          },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const results = await resolveDiscordUserAllowlist({
      entries: ["alice", "bob"],
      fetcher,
      token: "test",
    });

    expect(guildsCallCount).toBe(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "u-alice", resolved: true });
    expect(results[1]).toMatchObject({ id: "u-bob", resolved: true });
  });

  it("handles mixed ids and usernames — ids resolve even if guilds fail", async () => {
    const fetcher = createGuildsForbiddenFetcher();

    // IDs should succeed, username should fail (listGuilds throws)
    await expect(
      resolveDiscordUserAllowlist({
        entries: ["123456789012345678", "alice"],
        fetcher,
        token: "test",
      }),
    ).rejects.toThrow("Forbidden");

    // But if we only pass IDs, it should work fine
    const results = await resolveDiscordUserAllowlist({
      entries: ["123456789012345678", "<@999>"],
      fetcher,
      token: "test",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "123456789012345678", resolved: true });
    expect(results[1]).toMatchObject({ id: "999", resolved: true });
  });

  it("returns unresolved for empty/blank entries", async () => {
    const fetcher = withFetchPreconnect(async () => new Response("not found", { status: 404 }));

    const results = await resolveDiscordUserAllowlist({
      entries: ["", "  "],
      fetcher,
      token: "test",
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ resolved: false });
    expect(results[1]).toMatchObject({ resolved: false });
  });

  it("returns all unresolved when token is empty", async () => {
    const results = await resolveDiscordUserAllowlist({
      entries: ["123456789012345678", "alice"],
      token: "",
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.resolved)).toBe(true);
  });
});
