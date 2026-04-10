import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  type OpenClawConfig,
  type WizardPrompter,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  promptLegacyChannelAllowFromForAccount,
  resolveEntriesWithOptionalToken,
} from "openclaw/plugin-sdk/setup-runtime";
import type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  type ResolvedSlackAccount,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "./accounts.js";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";
import { resolveSlackUserAllowlist } from "./resolve-users.js";
import { createSlackSetupWizardBase } from "./setup-core.js";
import { SLACK_CHANNEL as channel } from "./shared.js";

async function resolveSlackAllowFromEntries(params: {
  token?: string;
  entries: string[];
}): Promise<ChannelSetupWizardAllowFromEntry[]> {
  return await resolveEntriesWithOptionalToken({
    buildWithoutToken: (input) => ({
      id: null,
      input,
      resolved: false,
    }),
    entries: params.entries,
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveSlackUserAllowlist({
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

async function promptSlackAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const parseId = (value: string) =>
    parseMentionOrPrefixedId({
      idPattern: /^[A-Z][A-Z0-9]+$/i,
      mentionPattern: /^<@([A-Z0-9]+)>$/i,
      normalizeId: (id) => id.toUpperCase(),
      prefixPattern: /^(slack:|user:)/i,
      value,
    });

  return await promptLegacyChannelAllowFromForAccount<ResolvedSlackAccount>({
    accountId: params.accountId,
    cfg: params.cfg,
    channel,
    defaultAccountId: resolveDefaultSlackAccountId(params.cfg),
    invalidWithoutTokenNote: "Slack token missing; use user ids (or mention form) only.",
    message: "Slack allowFrom (usernames or ids)",
    noteLines: [
      "Allowlist Slack DMs by username (we resolve to user ids).",
      "Examples:",
      "- U12345678",
      "- @alice",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/slack", "slack")}`,
    ],
    noteTitle: "Slack allowlist",
    parseId,
    placeholder: "@alice, U12345678",
    prompter: params.prompter,
    resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveSlackUserAllowlist({
          entries,
          token,
        })
      ).map((entry) => ({
        id: entry.id ?? null,
        input: entry.input,
        resolved: entry.resolved,
      })),
    resolveExisting: (_account, cfg) =>
      cfg.channels?.slack?.allowFrom ?? cfg.channels?.slack?.dm?.allowFrom ?? [],
    resolveToken: (account) => account.userToken ?? account.botToken ?? "",
  });
}

async function resolveSlackGroupAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: { botToken?: string };
  entries: string[];
  prompter: { note: (message: string, title?: string) => Promise<void> };
}) {
  let keys = params.entries;
  const accountWithTokens = resolveSlackAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  const activeBotToken = accountWithTokens.botToken || params.credentialValues.botToken || "";
  if (params.entries.length > 0) {
    try {
      const resolved = await resolveEntriesWithOptionalToken<{
        input: string;
        resolved: boolean;
        id?: string;
      }>({
        buildWithoutToken: (input) => ({ id: undefined, input, resolved: false }),
        entries: params.entries,
        resolveEntries: async ({ token, entries }) =>
          await resolveSlackChannelAllowlist({
            entries,
            token,
          }),
        token: activeBotToken,
      });
      const resolvedKeys = resolved
        .filter((entry) => entry.resolved && entry.id)
        .map((entry) => entry.id as string);
      const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
      keys = [...resolvedKeys, ...unresolved.map((entry) => entry.trim()).filter(Boolean)];
      await noteChannelLookupSummary({
        label: "Slack channels",
        prompter: params.prompter,
        resolvedSections: [{ title: "Resolved", values: resolvedKeys }],
        unresolved,
      });
    } catch (error) {
      await noteChannelLookupFailure({
        error,
        label: "Slack channels",
        prompter: params.prompter,
      });
    }
  }
  return keys;
}

export const slackSetupWizard: ChannelSetupWizard = createSlackSetupWizardBase({
  promptAllowFrom: promptSlackAllowFrom,
  resolveAllowFromEntries: async ({ credentialValues, entries }) =>
    await resolveSlackAllowFromEntries({
      entries,
      token: credentialValues.botToken,
    }),
  resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) =>
    await resolveSlackGroupAllowlist({
      accountId,
      cfg,
      credentialValues,
      entries,
      prompter,
    }),
});
