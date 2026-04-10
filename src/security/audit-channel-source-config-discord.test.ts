import { describe, expect, it, vi } from "vitest";
import { collectDiscordSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function stubDiscordPlugin(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
}): ChannelPlugin {
  return {
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
    },
    config: {
      inspectAccount:
        params.inspectAccount ??
        ((cfg, accountId) => {
          const resolvedAccountId =
            typeof accountId === "string" && accountId ? accountId : "default";
          const account = params.resolveAccount(cfg, resolvedAccountId) as
            | { config?: Record<string, unknown> }
            | undefined;
          return {
            accountId: resolvedAccountId,
            config: account?.config ?? {},
            configured: true,
            enabled: true,
          };
        }),
      isConfigured: (account, cfg) => params.isConfigured?.(account, cfg) ?? true,
      isEnabled: () => true,
      listAccountIds: () => ["default"],
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
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

describe("security audit channel source-config fallback discord", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const sourceConfig: OpenClawConfig = {
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
          token: { id: "DISCORD_BOT_TOKEN", provider: "default", source: "env" },
        },
      },
      commands: { native: true },
    };
    const resolvedConfig: OpenClawConfig = {
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
        },
      },
      commands: { native: true },
    };

    readChannelAllowFromStoreMock.mockResolvedValue([]);
    const findings = await collectChannelSecurityFindings({
      cfg: resolvedConfig,
      plugins: [
        stubDiscordPlugin({
          inspectAccount: (cfg) => {
            const channel = cfg.channels?.discord ?? {};
            const token = channel.token;
            return {
              accountId: "default",
              enabled: true,
              configured:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token,
              token: "",
              tokenSource:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token
                  ? "config"
                  : "none",
              tokenStatus:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token
                  ? "configured_unavailable"
                  : "missing",
              config: channel,
            };
          },
          isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          resolveAccount: (cfg) => ({ config: cfg.channels?.discord ?? {} }),
        }),
      ],
      sourceConfig,
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.discord.commands.native.no_allowlists",
          severity: "warn",
        }),
      ]),
    );
  });
});
