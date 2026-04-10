import { describe, expect, it, vi } from "vitest";
import { collectDiscordSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { OpenClawConfig } from "../config/config.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";

type DiscordAuditParams = Parameters<typeof collectDiscordSecurityAuditFindings>[0];
type ResolvedDiscordAccount = DiscordAuditParams["account"];
type DiscordAccountConfig = ResolvedDiscordAccount["config"];

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createDiscordAccount(config: DiscordAccountConfig): ResolvedDiscordAccount {
  return {
    accountId: "default",
    config,
    enabled: true,
    token: "t",
    tokenSource: "config",
  };
}

describe("security audit discord command findings", () => {
  it("flags Discord slash commands when access-group enforcement is disabled and no users allowlist exists", async () => {
    const cfg: OpenClawConfig = {
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
      commands: { native: true, useAccessGroups: false },
    };

    await withChannelSecurityStateDir(async () => {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const findings = await collectDiscordSecurityAuditFindings({
        account: createDiscordAccount(cfg.channels!.discord!),
        accountId: "default",
        cfg: cfg as OpenClawConfig & {
          channels: {
            discord: DiscordAccountConfig;
          };
        },
        hasExplicitAccountPath: false,
        orderedAccountIds: ["default"],
      });

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "channels.discord.commands.native.unrestricted",
            severity: "critical",
          }),
        ]),
      );
    });
  });
});
