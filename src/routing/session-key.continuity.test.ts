import { describe, expect, it } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";

describe("Discord Session Key Continuity", () => {
  const agentId = "main";
  const channel = "discord";
  const accountId = "default";

  function buildDiscordSessionKey(params: {
    peer: { kind: "direct" | "channel"; id: string };
    dmScope?: "main" | "per-peer";
  }) {
    return buildAgentSessionKey({
      accountId,
      agentId,
      channel,
      dmScope: params.dmScope ?? "main",
      peer: params.peer,
    });
  }

  function expectDistinctDmAndChannelKeys(params: {
    dmScope: "main" | "per-peer";
    expectedDmKey: string;
  }) {
    const dmKey = buildDiscordSessionKey({
      dmScope: params.dmScope,
      peer: { id: "user123", kind: "direct" },
    });

    const groupKey = buildDiscordSessionKey({
      peer: { id: "channel456", kind: "channel" },
    });

    expect(dmKey).toBe(params.expectedDmKey);
    expect(groupKey).toBe("agent:main:discord:channel:channel456");
    expect(dmKey).not.toBe(groupKey);
  }

  function expectUnknownChannelKeyCase(channelId: string) {
    const missingIdKey = buildDiscordSessionKey({
      peer: { id: channelId, kind: "channel" },
    });

    expect(missingIdKey).toContain("unknown");
    expect(missingIdKey).not.toBe("agent:main:main");
  }

  it.each([
    {
      dmScope: "main" as const,
      expectedDmKey: "agent:main:main",
      name: "keeps main-scoped DMs distinct from channel sessions",
    },
    {
      dmScope: "per-peer" as const,
      expectedDmKey: "agent:main:direct:user123",
      name: "keeps per-peer DMs distinct from channel sessions",
    },
  ])("$name", ({ dmScope, expectedDmKey }) => {
    expectDistinctDmAndChannelKeys({ dmScope, expectedDmKey });
  });

  it.each(["", "   "] as const)("handles invalid channel id %j without collision", (channelId) => {
    expectUnknownChannelKeyCase(channelId);
  });
});
