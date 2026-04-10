import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingTypedRuntimeEnv } from "../../../../test/helpers/plugins/runtime-env.js";
import * as resolveChannelsModule from "../resolve-channels.js";
import * as resolveUsersModule from "../resolve-users.js";
import { resolveDiscordAllowlistConfig } from "./provider.allowlist.js";

describe("resolveDiscordAllowlistConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValue([]);
    vi.spyOn(resolveUsersModule, "resolveDiscordUserAllowlist").mockImplementation(
      async (params: { entries: string[] }) =>
        params.entries.map((entry) => {
          switch (entry) {
            case "Alice": {
              return { id: "111", input: entry, resolved: true };
            }
            case "Bob": {
              return { id: "222", input: entry, resolved: true };
            }
            case "Carol": {
              return { input: entry, resolved: false };
            }
            case "387": {
              return { id: "387", input: entry, name: "Peter", resolved: true };
            }
            default: {
              return { id: entry, input: entry, resolved: true };
            }
          }
        }),
    );
  });

  it("canonicalizes resolved user names to ids in runtime config", async () => {
    const runtime = createNonExitingTypedRuntimeEnv<RuntimeEnv>();
    const result = await resolveDiscordAllowlistConfig({
      allowFrom: ["Alice", "111", "*"],
      fetcher: vi.fn() as unknown as typeof fetch,
      guildEntries: {
        "*": {
          channels: {
            "*": {
              users: ["Carol", "888"],
            },
          },
          users: ["Bob", "999"],
        },
      },
      runtime,
      token: "token",
    });

    expect(result.allowFrom).toEqual(["111", "*"]);
    expect(result.guildEntries?.["*"]?.users).toEqual(["222", "999"]);
    expect(result.guildEntries?.["*"]?.channels?.["*"]?.users).toEqual(["Carol", "888"]);
    expect(resolveUsersModule.resolveDiscordUserAllowlist).toHaveBeenCalledTimes(2);
  });

  it("logs discord name metadata for resolved and unresolved allowlist entries", async () => {
    vi.spyOn(resolveChannelsModule, "resolveDiscordChannelAllowlist").mockResolvedValueOnce([
      {
        channelName: "missing-room",
        guildId: "145",
        guildName: "Ops",
        input: "145/c404",
        resolved: false,
      },
    ]);
    const runtime = createNonExitingTypedRuntimeEnv<RuntimeEnv>();

    await resolveDiscordAllowlistConfig({
      allowFrom: ["387"],
      fetcher: vi.fn() as unknown as typeof fetch,
      guildEntries: {
        "145": {
          channels: {
            c404: {},
          },
        },
      },
      runtime,
      token: "token",
    });

    const logs = (runtime.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([line]) => String(line))
      .join("\n");
    expect(logs).toContain(
      "discord channels unresolved: 145/c404 (guild:Ops; channel:missing-room)",
    );
    expect(logs).toContain("discord users resolved: 387→Peter (id:387)");
  });
});
