import { describe, expect, it, vi } from "vitest";
import { collectDiscordSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { OpenClawConfig } from "../config/config.js";

type DiscordAuditParams = Parameters<typeof collectDiscordSecurityAuditFindings>[0];
type ResolvedDiscordAccount = DiscordAuditParams["account"];
type DiscordAccountConfig = ResolvedDiscordAccount["config"];

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createAccount(config: DiscordAccountConfig): ResolvedDiscordAccount {
  return {
    accountId: "default",
    config,
    enabled: true,
    token: "t",
    tokenSource: "config",
  };
}

describe("security audit discord native command findings", () => {
  it("evaluates Discord native command allowlist findings", async () => {
    const cases = [
      {
        cfg: {
          channels: {
            discord: {
              enabled: true,
              groupPolicy: "allowlist",
              guilds: {
                "123": {
                  channels: {
                    general: { enabled: true },
                  },
                },
              },
              token: "t",
            },
          },
          commands: { native: true },
        } as OpenClawConfig,
        expectFinding: true,
        name: "flags missing guild user allowlists",
      },
      {
        cfg: {
          channels: {
            discord: {
              dm: { allowFrom: ["387380367612706819"] },
              enabled: true,
              groupPolicy: "allowlist",
              guilds: {
                "123": {
                  channels: {
                    general: { enabled: true },
                  },
                },
              },
              token: "t",
            },
          },
          commands: { native: true },
        } as OpenClawConfig,
        expectFinding: false,
        name: "does not flag when dm.allowFrom includes a Discord snowflake id",
      },
    ] as const;

    for (const testCase of cases) {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const discord = testCase.cfg.channels?.discord;
      if (!discord) {
        throw new Error("discord config required");
      }
      const findings = await collectDiscordSecurityAuditFindings({
        account: createAccount(discord),
        accountId: "default",
        cfg: testCase.cfg as OpenClawConfig & { channels: { discord: DiscordAccountConfig } },
        hasExplicitAccountPath: false,
        orderedAccountIds: ["default"],
      });

      expect(
        findings.some(
          (finding) => finding.checkId === "channels.discord.commands.native.no_allowlists",
        ),
        testCase.name,
      ).toBe(testCase.expectFinding);
    }
  });
});
