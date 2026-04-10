import type {
  ChannelSetupWizard,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDiscordChannelAllowlist } from "./resolve-channels.js";
import { resolveDiscordUserAllowlist } from "./resolve-users.js";
import {
  resolveDefaultDiscordSetupAccountId,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import { createDiscordSetupWizardBase, parseDiscordAllowFromId } from "./setup-core.js";
import {
  promptLegacyChannelAllowFromForAccount,
  resolveEntriesWithOptionalToken,
} from "./setup-runtime-helpers.js";
import { resolveDiscordToken } from "./token.js";

const channel = "discord" as const;

async function resolveDiscordAllowFromEntries(params: { token?: string; entries: string[] }) {
  return await resolveEntriesWithOptionalToken({
    buildWithoutToken: (input) => ({
      id: null,
      input,
      resolved: false,
    }),
    entries: params.entries,
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveDiscordUserAllowlist({
          entries,
          token,
        })
      ).map((entry) => ({
        id: entry.id ?? null,
        input: entry.input,
        resolved: entry.resolved,
      })),
    token: params.token,
  });
}

async function promptDiscordAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return await promptLegacyChannelAllowFromForAccount({
    accountId: params.accountId,
    cfg: params.cfg,
    channel,
    defaultAccountId: resolveDefaultDiscordSetupAccountId(params.cfg),
    invalidWithoutTokenNote: "Bot token missing; use numeric user ids (or mention form) only.",
    message: "Discord allowFrom (usernames or ids)",
    noteLines: [
      "Allowlist Discord DMs by username (we resolve to user ids).",
      "Examples:",
      "- 123456789012345678",
      "- @alice",
      "- alice#1234",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ],
    noteTitle: "Discord allowlist",
    parseId: parseDiscordAllowFromId,
    placeholder: "@alice, 123456789012345678",
    prompter: params.prompter,
    resolveAccount: (cfg, accountId) => resolveDiscordSetupAccountConfig({ accountId, cfg }),
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveDiscordUserAllowlist({
          entries,
          token,
        })
      ).map((entry) => ({
        id: entry.id ?? null,
        input: entry.input,
        resolved: entry.resolved,
      })),
    resolveExisting: (account) => {
      const { config } = account;
      return config.allowFrom ?? config.dm?.allowFrom ?? [];
    },
    resolveToken: (account) =>
      resolveDiscordToken(params.cfg, { accountId: account.accountId }).token,
  });
}

async function resolveDiscordGroupAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: { token?: string };
  entries: string[];
}) {
  return await resolveEntriesWithOptionalToken({
    buildWithoutToken: (input) => ({
      input,
      resolved: false,
    }),
    entries: params.entries,
    resolveEntries: async ({ token, entries }) =>
      await resolveDiscordChannelAllowlist({
        entries,
        token,
      }),
    token:
      resolveDiscordToken(params.cfg, { accountId: params.accountId }).token ||
      (typeof params.credentialValues.token === "string" ? params.credentialValues.token : ""),
  });
}

export const discordSetupWizard: ChannelSetupWizard = createDiscordSetupWizardBase({
  promptAllowFrom: promptDiscordAllowFrom,
  resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveDiscordAllowFromEntries({
      entries,
      token:
        resolveDiscordToken(cfg, { accountId }).token ||
        (typeof credentialValues.token === "string" ? credentialValues.token : ""),
    }),
  resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries }) =>
    await resolveDiscordGroupAllowlist({
      accountId,
      cfg,
      credentialValues,
      entries,
    }),
});
