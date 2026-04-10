import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectDiscordSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function stubDiscordPlugin(): ChannelPlugin {
  return {
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
    },
    config: {
      inspectAccount: (cfg, accountId) => {
        const resolvedAccountId =
          typeof accountId === "string" && accountId ? accountId : "default";
        const base = cfg.channels?.discord ?? {};
        const account = cfg.channels?.discord?.accounts?.[resolvedAccountId] ?? {};
        return {
          accountId: resolvedAccountId,
          config: { ...base, ...account },
          configured: true,
          enabled: true,
          token: "t",
          tokenSource: "config",
        };
      },
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: (cfg) => {
        const ids = Object.keys(cfg.channels?.discord?.accounts ?? {});
        return ids.length > 0 ? ids : ["default"];
      },
      resolveAccount: (cfg, accountId) => {
        const resolvedAccountId =
          typeof accountId === "string" && accountId ? accountId : "default";
        const base = cfg.channels?.discord ?? {};
        const account = cfg.channels?.discord?.accounts?.[resolvedAccountId] ?? {};
        return {
          accountId: resolvedAccountId,
          config: { ...base, ...account },
          enabled: true,
          token: "t",
          tokenSource: "config",
        };
      },
    },
    id: "discord",
    meta: {
      blurb: "test stub",
      docsPath: "/docs/testing",
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
    },
    security: {
      collectAuditFindings: collectDiscordSecurityAuditFindings,
    },
  };
}

describe("security audit discord allowlists", () => {
  it.each([
    {
      cfg: {
        channels: {
          discord: {
            allowFrom: ["Alice#1234", "<@123456789012345678>"],
            enabled: true,
            guilds: {
              "123": {
                channels: {
                  general: {
                    users: ["987654321098765432", "security-team"],
                  },
                },
                users: ["trusted.operator"],
              },
            },
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      detailExcludes: ["<@123456789012345678>"],
      detailIncludes: [
        "channels.discord.allowFrom:Alice#1234",
        "channels.discord.guilds.123.users:trusted.operator",
        "channels.discord.guilds.123.channels.general.users:security-team",
        "~/.openclaw/credentials/discord-allowFrom.json:team.owner",
      ],
      expectNameBasedSeverity: "warn",
      name: "warns when Discord allowlists contain name-based entries",
      setup: async (tmp: string) => {
        await fs.writeFile(
          path.join(tmp, "credentials", "discord-allowFrom.json"),
          JSON.stringify({ allowFrom: ["team.owner"], version: 1 }),
        );
      },
    },
    {
      cfg: {
        channels: {
          discord: {
            allowFrom: ["Alice#1234"],
            dangerouslyAllowNameMatching: true,
            enabled: true,
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.discord.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
      },
      expectNameBasedSeverity: "info",
      name: "marks Discord name-based allowlists as break-glass when dangerous matching is enabled",
    },
    {
      cfg: {
        channels: {
          discord: {
            accounts: {
              alpha: { token: "a" },
              beta: {
                dangerouslyAllowNameMatching: true,
                token: "b",
              },
            },
            enabled: true,
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      expectFindingMatch: {
        checkId: "channels.discord.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
        title: expect.stringContaining("(account: beta)"),
      },
      expectNoNameBasedFinding: true,
      name: "audits non-default Discord accounts for dangerous name matching",
    },
    {
      cfg: {
        channels: {
          discord: {
            accounts: {
              alpha: {
                allowFrom: ["123456789012345678"],
                token: "a",
              },
              beta: {
                allowFrom: ["Alice#1234"],
                token: "b",
              },
            },
            enabled: true,
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      detailIncludes: ["channels.discord.accounts.beta.allowFrom:Alice#1234"],
      expectNameBasedSeverity: "warn",
      name: "audits name-based allowlists on non-default Discord accounts",
    },
    {
      cfg: {
        channels: {
          discord: {
            allowFrom: [
              "123456789012345678",
              "<@223456789012345678>",
              "user:323456789012345678",
              "discord:423456789012345678",
              "pk:member-123",
            ],
            enabled: true,
            guilds: {
              "123": {
                channels: {
                  general: {
                    users: ["723456789012345678", "user:823456789012345678"],
                  },
                },
                users: ["523456789012345678", "<@623456789012345678>", "pk:member-456"],
              },
            },
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      expectNoNameBasedFinding: true,
      name: "does not warn when Discord allowlists use ID-style entries only",
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async (tmp) => {
      await testCase.setup?.(tmp);
      readChannelAllowFromStoreMock.mockResolvedValue(
        testCase.detailIncludes?.includes(
          "~/.openclaw/credentials/discord-allowFrom.json:team.owner",
        )
          ? ["team.owner"]
          : [],
      );
      const findings = await collectChannelSecurityFindings({
        cfg: testCase.cfg,
        plugins: [stubDiscordPlugin()],
      });
      const nameBasedFinding = findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
      );

      if (testCase.expectNoNameBasedFinding) {
        expect(nameBasedFinding).toBeUndefined();
      } else if (
        testCase.expectNameBasedSeverity ||
        testCase.detailIncludes?.length ||
        testCase.detailExcludes?.length
      ) {
        expect(nameBasedFinding).toBeDefined();
        if (testCase.expectNameBasedSeverity) {
          expect(nameBasedFinding?.severity).toBe(testCase.expectNameBasedSeverity);
        }
        for (const snippet of testCase.detailIncludes ?? []) {
          expect(nameBasedFinding?.detail).toContain(snippet);
        }
        for (const snippet of testCase.detailExcludes ?? []) {
          expect(nameBasedFinding?.detail).not.toContain(snippet);
        }
      }

      if (testCase.expectFindingMatch) {
        const matchingFinding = findings.find(
          (entry) => entry.checkId === testCase.expectFindingMatch.checkId,
        );
        expect(matchingFinding).toEqual(expect.objectContaining(testCase.expectFindingMatch));
      }
    });
  });

  it("does not treat prototype properties as explicit Discord account config paths", async () => {
    await withChannelSecurityStateDir(async () => {
      const cfg: OpenClawConfig = {
        channels: {
          discord: {
            accounts: {},
            allowFrom: ["Alice#1234"],
            dangerouslyAllowNameMatching: true,
            enabled: true,
            token: "t",
          },
        },
      };

      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const pluginWithProtoDefaultAccount: ChannelPlugin = {
        ...stubDiscordPlugin(),
        config: {
          ...stubDiscordPlugin().config,
          defaultAccountId: () => "toString",
          listAccountIds: () => [],
        },
      };
      const findings = await collectChannelSecurityFindings({
        cfg,
        plugins: [pluginWithProtoDefaultAccount],
      });

      const dangerousMatchingFinding = findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.dangerous_name_matching_enabled",
      );
      expect(dangerousMatchingFinding).toBeDefined();
      expect(dangerousMatchingFinding?.title).not.toContain("(account: toString)");

      const nameBasedFinding = findings.find(
        (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
      );
      expect(nameBasedFinding).toBeDefined();
      expect(nameBasedFinding?.detail).toContain("channels.discord.allowFrom:Alice#1234");
      expect(nameBasedFinding?.detail).not.toContain("channels.discord.accounts.toString");
    });
  });
});
