import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectDiscordStatusIssues } from "./status-issues.js";

describe("collectDiscordStatusIssues", () => {
  it("reports disabled message content intent and unresolved channel ids", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "ops",
        application: {
          intents: {
            messageContent: "disabled",
          },
        },
        audit: {
          unresolvedChannels: 2,
        },
        configured: true,
        enabled: true,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "ops",
          channel: "discord",
          kind: "intent",
        }),
        expect.objectContaining({
          accountId: "ops",
          channel: "discord",
          kind: "config",
        }),
      ]),
    );
  });

  it("reports channel permission failures with match metadata", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "ops",
        audit: {
          channels: [
            {
              channelId: "123",
              error: "403",
              matchKey: "alerts",
              matchSource: "guilds.ops.channels",
              missing: ["ViewChannel", "SendMessages"],
              ok: false,
            },
          ],
        },
        configured: true,
        enabled: true,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      accountId: "ops",
      channel: "discord",
      kind: "permissions",
    });
    expect(issues[0]?.message).toContain("Channel 123 permission check failed");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("guilds.ops.channels");
  });
});
