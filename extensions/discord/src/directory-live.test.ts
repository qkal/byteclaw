import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDiscordDirectoryGroupsLive, listDiscordDirectoryPeersLive } from "./directory-live.js";

function makeParams(overrides: Partial<DirectoryConfigParams> = {}): DirectoryConfigParams {
  return {
    accountId: "default",
    cfg: {
      channels: {
        discord: {
          token: "test-token",
        },
      },
    } as OpenClawConfig,
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function resolveFetchUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
}

describe("discord directory live lookups", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty group directory when token is missing", async () => {
    const rows = await listDiscordDirectoryGroupsLive({
      ...makeParams(),
      cfg: { channels: { discord: { token: "" } } } as OpenClawConfig,
      query: "general",
    });

    expect(rows).toEqual([]);
  });

  it("returns empty peer directory without query and skips guild listing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const rows = await listDiscordDirectoryPeersLive(makeParams({ query: "  " }));

    expect(rows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters group channels by query and respects limit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = resolveFetchUrl(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([
          { id: "g1", name: "Guild 1" },
          { id: "g2", name: "Guild 2" },
        ]);
      }
      if (url.endsWith("/guilds/g1/channels")) {
        return jsonResponse([
          { id: "c1", name: "general" },
          { id: "c2", name: "random" },
        ]);
      }
      if (url.endsWith("/guilds/g2/channels")) {
        return jsonResponse([{ id: "c3", name: "announcements" }]);
      }
      return jsonResponse([]);
    });

    const rows = await listDiscordDirectoryGroupsLive(makeParams({ limit: 2, query: "an" }));

    expect(rows).toEqual([
      expect.objectContaining({ id: "channel:c2", kind: "group", name: "random" }),
      expect.objectContaining({ id: "channel:c3", kind: "group", name: "announcements" }),
    ]);
  });

  it("returns ranked peer results and caps member search by limit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = resolveFetchUrl(input);
      if (url.endsWith("/users/@me/guilds")) {
        return jsonResponse([{ id: "g1", name: "Guild 1" }]);
      }
      if (url.includes("/guilds/g1/members/search?")) {
        const params = new URL(url).searchParams;
        expect(params.get("query")).toBe("alice");
        expect(params.get("limit")).toBe("2");
        return jsonResponse([
          { nick: "Ali", user: { bot: false, id: "u1", username: "alice" } },
          { nick: null, user: { bot: true, id: "u2", username: "alice-bot" } },
          { nick: null, user: { bot: false, id: "u3", username: "ignored" } },
        ]);
      }
      return jsonResponse([]);
    });

    const rows = await listDiscordDirectoryPeersLive(makeParams({ limit: 2, query: "alice" }));

    expect(rows).toEqual([
      expect.objectContaining({
        handle: "@alice",
        id: "user:u1",
        kind: "user",
        name: "Ali",
        rank: 1,
      }),
      expect.objectContaining({
        handle: "@alice-bot",
        id: "user:u2",
        kind: "user",
        rank: 0,
      }),
    ]);
  });
});
