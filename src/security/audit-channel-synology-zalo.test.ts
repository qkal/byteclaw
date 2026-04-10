import { describe, expect, it } from "vitest";
import {
  collectSynologyChatSecurityAuditFindings,
  collectZalouserSecurityAuditFindings,
} from "../../test/helpers/channels/security-audit-contract.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

type SynologyAuditParams = Parameters<typeof collectSynologyChatSecurityAuditFindings>[0];
type ResolvedSynologyChatAccount = SynologyAuditParams["account"];
type ZalouserAuditParams = Parameters<typeof collectZalouserSecurityAuditFindings>[0];
type ResolvedZalouserAccount = ZalouserAuditParams["account"];

function stubZalouserPlugin(): ChannelPlugin {
  return {
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      inspectAccount: (cfg) => ({
        accountId: "default",
        config: cfg.channels?.zalouser ?? {},
        configured: true,
        enabled: true,
      }),
      isConfigured: () => true,
      isEnabled: () => true,
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) =>
        ({
          accountId: "default",
          config: cfg.channels?.zalouser ?? {},
          enabled: true,
        }) as ResolvedZalouserAccount,
    },
    id: "zalouser",
    meta: {
      blurb: "test stub",
      docsPath: "/docs/testing",
      id: "zalouser",
      label: "Zalo Personal",
      selectionLabel: "Zalo Personal",
    },
    security: {
      collectAuditFindings: collectZalouserSecurityAuditFindings,
    },
  };
}

function createSynologyChatAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): ResolvedSynologyChatAccount {
  const channel = params.cfg.channels?.["synology-chat"] ?? {};
  const accountConfig =
    params.accountId === "default" ? channel : (channel.accounts?.[params.accountId] ?? {});
  return {
    accountId: params.accountId,
    dangerouslyAllowNameMatching:
      Boolean(
        (accountConfig as { dangerouslyAllowNameMatching?: boolean }).dangerouslyAllowNameMatching,
      ) ||
      Boolean(
        params.accountId === "default" &&
        (channel as { dangerouslyAllowNameMatching?: boolean }).dangerouslyAllowNameMatching,
      ),
  } as ResolvedSynologyChatAccount;
}

describe("security audit synology and zalo channel routing", () => {
  it.each([
    {
      cfg: {
        channels: {
          "synology-chat": {
            dangerouslyAllowNameMatching: true,
            incomingUrl: "https://nas.example.com/incoming",
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: "Synology Chat dangerous name matching is enabled",
      },
      name: "audits Synology Chat base dangerous name matching",
    },
    {
      cfg: {
        channels: {
          "synology-chat": {
            accounts: {
              alpha: {
                incomingUrl: "https://nas.example.com/incoming-alpha",
                token: "a",
              },
              beta: {
                dangerouslyAllowNameMatching: true,
                incomingUrl: "https://nas.example.com/incoming-beta",
                token: "b",
              },
            },
            incomingUrl: "https://nas.example.com/incoming",
            token: "t",
          },
        },
      } satisfies OpenClawConfig,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: expect.stringContaining("(account: beta)"),
      },
      name: "audits non-default Synology Chat accounts for dangerous name matching",
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const synologyChat = testCase.cfg.channels?.["synology-chat"];
      if (!synologyChat) {
        throw new Error("synology-chat config required");
      }
      const accountId = Object.keys(synologyChat.accounts ?? {}).includes("beta")
        ? "beta"
        : "default";
      const findings = collectSynologyChatSecurityAuditFindings({
        account: createSynologyChatAccount({ accountId, cfg: testCase.cfg }),
        accountId,
        hasExplicitAccountPath: accountId !== "default",
        orderedAccountIds: Object.keys(synologyChat.accounts ?? {}),
      });
      expect(findings).toEqual(
        expect.arrayContaining([expect.objectContaining(testCase.expectedMatch)]),
      );
    });
  });

  it.each([
    {
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            groups: {
              "Ops Room": { allow: true },
              "group:g-123": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      detailExcludes: ["group:g-123"],
      detailIncludes: ["channels.zalouser.groups:Ops Room"],
      expectedSeverity: "warn",
      name: "warns when Zalouser group routing contains mutable group entries",
    },
    {
      cfg: {
        channels: {
          zalouser: {
            dangerouslyAllowNameMatching: true,
            enabled: true,
            groups: {
              "Ops Room": { allow: true },
            },
          },
        },
      } satisfies OpenClawConfig,
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.zalouser.allowFrom.dangerous_name_matching_enabled",
        severity: "info",
      },
      expectedSeverity: "info",
      name: "marks Zalouser mutable group routing as break-glass when dangerous matching is enabled",
    },
  ])("$name", async (testCase) => {
    await withChannelSecurityStateDir(async () => {
      const findings = await collectChannelSecurityFindings({
        cfg: testCase.cfg,
        plugins: [stubZalouserPlugin()],
      });
      const finding = findings.find(
        (entry) => entry.checkId === "channels.zalouser.groups.mutable_entries",
      );

      expect(finding).toBeDefined();
      expect(finding?.severity).toBe(testCase.expectedSeverity);
      for (const snippet of testCase.detailIncludes) {
        expect(finding?.detail).toContain(snippet);
      }
      for (const snippet of testCase.detailExcludes ?? []) {
        expect(finding?.detail).not.toContain(snippet);
      }
      if (testCase.expectFindingMatch) {
        expect(findings).toEqual(
          expect.arrayContaining([expect.objectContaining(testCase.expectFindingMatch)]),
        );
      }
    });
  });
});
