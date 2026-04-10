import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { jsonResponse, urlToString } from "./test-http-helpers.js";

describe("resolveDiscordChannelAllowlist", () => {
  interface DiscordChannel {
    id: string;
    name: string;
    guild_id: string;
    type: number;
  }

  async function resolveWithChannelLookup(params: {
    guilds: { id: string; name: string }[];
    channel: DiscordChannel;
    entry: string;
  }) {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse(params.guilds);
      }
      if (url.endsWith(`/channels/${params.channel.id}`)) {
        return jsonResponse(params.channel);
      }
      return new Response("not found", { status: 404 });
    });
    return resolveDiscordChannelAllowlist({
      entries: [params.entry],
      fetcher,
      token: "test",
    });
  }

  async function resolveGuild111Entry2024(params: {
    channelLookup: () => Response;
    guildChannels?: DiscordChannel[];
  }) {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111", name: "Test Server" }]);
      }
      if (url.endsWith("/channels/2024")) {
        return params.channelLookup();
      }
      if (url.endsWith("/guilds/111/channels")) {
        return jsonResponse(
          params.guildChannels ?? [
            { guild_id: "111", id: "c1", name: "2024", type: 0 },
            { guild_id: "111", id: "c2", name: "general", type: 0 },
          ],
        );
      }
      return new Response("not found", { status: 404 });
    });

    return resolveDiscordChannelAllowlist({
      entries: ["111/2024"],
      fetcher,
      token: "test",
    });
  }

  function expectUnresolved1112024(
    res: Awaited<ReturnType<typeof resolveDiscordChannelAllowlist>>,
  ) {
    expect(res[0]?.resolved).toBe(false);
    expect(res[0]?.channelId).toBe("2024");
    expect(res[0]?.guildId).toBe("111");
  }

  it("resolves guild/channel by name", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "My Guild" }]);
      }
      if (url.endsWith("/guilds/g1/channels")) {
        return jsonResponse([
          { guild_id: "g1", id: "c1", name: "general", type: 0 },
          { guild_id: "g1", id: "c2", name: "random", type: 0 },
        ]);
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["My Guild/general"],
      fetcher,
      token: "test",
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("c1");
  });

  it("resolves channel id to guild", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "Guild One" }]);
      }
      if (url.endsWith("/channels/123")) {
        return jsonResponse({ guild_id: "g1", id: "123", name: "general", type: 0 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["123"],
      fetcher,
      token: "test",
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("g1");
    expect(res[0]?.channelId).toBe("123");
  });

  it("resolves guildId/channelId entries via channel lookup", async () => {
    const res = await resolveWithChannelLookup({
      channel: { guild_id: "111", id: "222", name: "general", type: 0 },
      entry: "111/222",
      guilds: [{ id: "111", name: "Guild One" }],
    });

    expect(res[0]).toMatchObject({
      channelId: "222",
      channelName: "general",
      guildId: "111",
      guildName: "Guild One",
      input: "111/222",
      resolved: true,
    });
  });

  it("reports unresolved when channel id belongs to a different guild", async () => {
    const res = await resolveWithChannelLookup({
      channel: { guild_id: "333", id: "222", name: "general", type: 0 },
      entry: "111/222",
      guilds: [
        { id: "111", name: "Guild One" },
        { id: "333", name: "Guild Two" },
      ],
    });

    expect(res[0]).toMatchObject({
      channelId: "222",
      channelName: "general",
      guildId: "111",
      guildName: "Guild One",
      input: "111/222",
      note: "channel belongs to guild Guild Two",
      resolved: false,
    });
  });

  it("resolves numeric channel id when guild is specified by name", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111", name: "My Guild" }]);
      }
      if (url.endsWith("/guilds/111/channels")) {
        return jsonResponse([{ guild_id: "111", id: "444555666", name: "general", type: 0 }]);
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["My Guild/444555666"],
      fetcher,
      token: "test",
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.channelId).toBe("444555666");
  });

  it("marks invalid numeric channelId as unresolved without aborting batch", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111", name: "Test Server" }]);
      }
      if (url.endsWith("/guilds/111/channels")) {
        return jsonResponse([{ guild_id: "111", id: "444555666", name: "general", type: 0 }]);
      }
      if (url.endsWith("/channels/999000111")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/channels/444555666")) {
        return jsonResponse({
          guild_id: "111",
          id: "444555666",
          name: "general",
          type: 0,
        });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["111/999000111", "111/444555666"],
      fetcher,
      token: "test",
    });

    expect(res).toHaveLength(2);
    expect(res[0]?.resolved).toBe(false);
    expect(res[0]?.channelId).toBe("999000111");
    expect(res[0]?.guildId).toBe("111");
    expect(res[1]?.resolved).toBe(true);
    expect(res[1]?.channelId).toBe("444555666");
  });

  it("treats 403 channel lookup as unresolved without aborting batch", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111", name: "Test Server" }]);
      }
      if (url.endsWith("/guilds/111/channels")) {
        return jsonResponse([{ guild_id: "111", id: "444555666", name: "general", type: 0 }]);
      }
      if (url.endsWith("/channels/777888999")) {
        return new Response("Missing Access", { status: 403 });
      }
      if (url.endsWith("/channels/444555666")) {
        return jsonResponse({
          guild_id: "111",
          id: "444555666",
          name: "general",
          type: 0,
        });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["111/777888999", "111/444555666"],
      fetcher,
      token: "test",
    });

    expect(res).toHaveLength(2);
    expect(res[0]?.resolved).toBe(false);
    expect(res[0]?.channelId).toBe("777888999");
    expect(res[0]?.guildId).toBe("111");
    expect(res[1]?.resolved).toBe(true);
    expect(res[1]?.channelId).toBe("444555666");
  });

  it("falls back to name matching when numeric channel name is not a valid ID", async () => {
    const res = await resolveGuild111Entry2024({
      channelLookup: () => new Response("not found", { status: 404 }),
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("111");
    expect(res[0]?.channelId).toBe("c1");
    expect(res[0]?.channelName).toBe("2024");
  });

  it("does not fall back to name matching when channel lookup returns 403", async () => {
    const res = await resolveGuild111Entry2024({
      channelLookup: () => new Response("Missing Access", { status: 403 }),
    });

    expectUnresolved1112024(res);
  });

  it("does not fall back to name matching when channel payload is malformed", async () => {
    const res = await resolveGuild111Entry2024({
      channelLookup: () => jsonResponse({ id: "2024", name: "unknown", type: 0 }),
      guildChannels: [{ guild_id: "111", id: "c1", name: "2024", type: 0 }],
    });

    expectUnresolved1112024(res);
  });

  it("resolves guild: prefixed id as guild (not channel)", async () => {
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "111222333444555666", name: "Guild One" }]);
      }
      // Should never be called — if it is, the ID was misrouted as a channel
      if (url.includes("/channels/")) {
        throw new Error("guild id was incorrectly routed to /channels/");
      }
      return new Response("not found", { status: 404 });
    });

    const res = await resolveDiscordChannelAllowlist({
      entries: ["guild:111222333444555666"],
      fetcher,
      token: "test",
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.guildId).toBe("111222333444555666");
    expect(res[0]?.channelId).toBeUndefined();
  });

  it("bare numeric guild id is misrouted as channel id (regression)", async () => {
    // Demonstrates why provider.ts must prefix guild-only entries with "guild:"
    // In reality, Discord returns 404 when a guild ID is sent to /channels/<guildId>,
    // Which causes fetchDiscord to throw and the entire resolver to crash.
    const fetcher = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "999", name: "My Server" }]);
      }
      // Guild ID hitting /channels/ returns 404 — just like real Discord
      if (url.includes("/channels/")) {
        return new Response(JSON.stringify({ message: "Unknown Channel" }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    });

    // Without the guild: prefix, a bare numeric string hits /channels/999 → 404 → unresolved
    const res = await resolveDiscordChannelAllowlist({
      entries: ["999"],
      fetcher,
      token: "test",
    });
    expect(res[0]?.resolved).toBe(false);
    expect(res[0]?.channelId).toBe("999");
    expect(res[0]?.guildId).toBeUndefined();

    // With the guild: prefix, it correctly resolves as a guild (never hits /channels/)
    const res2 = await resolveDiscordChannelAllowlist({
      entries: ["guild:999"],
      fetcher,
      token: "test",
    });
    expect(res2[0]?.resolved).toBe(true);
    expect(res2[0]?.guildId).toBe("999");
    expect(res2[0]?.channelId).toBeUndefined();
  });
});
