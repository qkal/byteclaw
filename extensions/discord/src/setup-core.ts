import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { createStandardChannelSetupStatus } from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import {
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowlistSetupWizardProxy,
  createLegacyCompatChannelDmPolicy,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
} from "./setup-runtime-helpers.js";

const channel = "discord" as const;

export const DISCORD_TOKEN_HELP_LINES = [
  "1) Discord Developer Portal -> Applications -> New Application",
  "2) Bot -> Add Bot -> Reset Token -> copy token",
  "3) OAuth2 -> URL Generator -> scope 'bot' -> invite to your server",
  "Tip: enable Message Content Intent if you need message text. (Bot -> Privileged Gateway Intents -> Message Content Intent)",
  `Docs: ${formatDocsLink("/discord", "discord")}`,
];

export function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: {
    guildKey: string;
    channelKey?: string;
  }[],
): OpenClawConfig {
  const baseGuilds =
    accountId === DEFAULT_ACCOUNT_ID
      ? (cfg.channels?.discord?.guilds ?? {})
      : (cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {});
  const guilds: Record<string, DiscordGuildEntry> = { ...baseGuilds };
  for (const entry of entries) {
    const guildKey = entry.guildKey || "*";
    const existing = guilds[guildKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = { enabled: true };
      guilds[guildKey] = { ...existing, channels };
    } else {
      guilds[guildKey] = existing;
    }
  }
  return patchChannelConfigForAccount({
    accountId,
    cfg,
    channel,
    patch: { guilds },
  });
}

export function parseDiscordAllowFromId(value: string): string | null {
  return parseMentionOrPrefixedId({
    idPattern: /^\d+$/,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixPattern: /^(user:|discord:)/i,
    value,
  });
}

export function createDiscordSetupWizardBase(handlers: {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
  resolveAllowFromEntries: NonNullable<
    NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
  >;
  resolveGroupAllowlist: NonNullable<
    NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
  >;
}) {
  const discordDmPolicy: ChannelSetupDmPolicy = createLegacyCompatChannelDmPolicy({
    channel,
    label: "Discord",
    promptAllowFrom: handlers.promptAllowFrom,
  });

  return {
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "token",
      helpLines: [
        "Allowlist Discord DMs by username (we resolve to user ids).",
        "Examples:",
        "- 123456789012345678",
        "- @alice",
        "- alice#1234",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/discord", "discord")}`,
      ],
      helpTitle: "Discord allowlist",
      invalidWithoutCredentialNote:
        "Bot token missing; use numeric user ids (or mention form) only.",
      message: "Discord allowFrom (usernames or ids)",
      parseId: parseDiscordAllowFromId,
      placeholder: "@alice, 123456789012345678",
      resolveEntries: handlers.resolveAllowFromEntries,
    }),
    channel,
    credentials: [
      {
        allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
        credentialLabel: "Discord bot token",
        envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
        helpLines: DISCORD_TOKEN_HELP_LINES,
        helpTitle: "Discord bot token",
        inputKey: "token",
        inputPrompt: "Enter Discord bot token",
        inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
          const account = inspectDiscordSetupAccount({ cfg, accountId });
          return {
            accountConfigured: account.configured,
            hasConfiguredValue: account.tokenStatus !== "missing",
            resolvedValue: normalizeOptionalString(account.token),
            envValue:
              accountId === DEFAULT_ACCOUNT_ID
                ? normalizeOptionalString(process.env.DISCORD_BOT_TOKEN)
                : undefined,
          };
        },
        keepPrompt: "Discord token already configured. Keep it?",
        preferredEnvVar: "DISCORD_BOT_TOKEN",
        providerHint: channel,
      },
    ],
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
    dmPolicy: discordDmPolicy,
    groupAccess: createAccountScopedGroupAccessSection({
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setDiscordGuildChannelAllowlist(cfg, accountId, resolved as never),
      channel,
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(
          resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds ?? {},
        ).flatMap(([guildKey, value]) => {
          const channels = value?.channels ?? {};
          const channelKeys = Object.keys(channels);
          if (channelKeys.length === 0) {
            const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
            return [input];
          }
          return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
        }),
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveDiscordSetupAccountConfig({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      fallbackResolved: (entries) => entries.map((input) => ({ input, resolved: false })),
      label: "Discord channels",
      placeholder: "My Server/#general, guildId/channelId, #support",
      resolveAllowlist: handlers.resolveGroupAllowlist,
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds),
    }),
    status: createStandardChannelSetupStatus({
      channelLabel: "Discord",
      configuredHint: "configured",
      configuredLabel: "configured",
      configuredScore: 2,
      resolveConfigured: ({ cfg, accountId }) =>
        inspectDiscordSetupAccount({ cfg, accountId }).configured,
      unconfiguredHint: "needs token",
      unconfiguredLabel: "needs token",
      unconfiguredScore: 1,
    }),
  } satisfies ChannelSetupWizard;
}
export function createDiscordSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createAllowlistSetupWizardProxy({
    createBase: createDiscordSetupWizardBase,
    fallbackResolvedGroupAllowlist: (entries) =>
      entries.map((input) => ({ input, resolved: false })),
    loadWizard,
  });
}
