import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ChannelSetupDmPolicy, ChannelSetupWizard, DmPolicy } from "openclaw/plugin-sdk/setup";
import {
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelParsedAllowFromPrompt,
  formatDocsLink,
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { getPublicKeyFromPrivate, normalizePubkey } from "./nostr-bus.js";
import { resolveDefaultNostrAccountId, resolveNostrAccount } from "./types.js";

const channel = "nostr" as const;

const NOSTR_SETUP_HELP_LINES = [
  "Use a Nostr private key in nsec or 64-character hex format.",
  "Relay URLs are optional. Leave blank to keep the default relay set.",
  "Env vars supported: NOSTR_PRIVATE_KEY (default account only).",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

const NOSTR_ALLOW_FROM_HELP_LINES = [
  "Allowlist Nostr DMs by npub or hex pubkey.",
  "Examples:",
  "- npub1...",
  "- nostr:npub1...",
  "- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`,
];

function buildNostrSetupPatch(accountId: string, patch: Record<string, unknown>) {
  return {
    ...(accountId !== DEFAULT_ACCOUNT_ID ? { defaultAccount: accountId } : {}),
    ...patch,
  };
}

function parseRelayUrls(raw: string): { relays: string[]; error?: string } {
  const entries = splitSetupEntries(raw);
  const relays: string[] = [];
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        return { error: `Relay must use ws:// or wss:// (${entry})`, relays: [] };
      }
    } catch {
      return { error: `Invalid relay URL: ${entry}`, relays: [] };
    }
    relays.push(entry);
  }
  return { relays: [...new Set(relays)] };
}

function parseNostrAllowFrom(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesWithParser(raw, (entry) => {
    const cleaned = entry.replace(/^nostr:/i, "").trim();
    try {
      return { value: normalizePubkey(cleaned) };
    } catch {
      return { error: `Invalid Nostr pubkey: ${entry}` };
    }
  });
}

const promptNostrAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
  channel,
  defaultAccountId: resolveDefaultNostrAccountId,
  mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing, parsed),
  message: "Nostr allowFrom",
  noteLines: NOSTR_ALLOW_FROM_HELP_LINES,
  noteTitle: "Nostr allowlist",
  parseEntries: parseNostrAllowFrom,
  placeholder: "npub1..., 0123abcd...",
});

const nostrDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  allowFromKey: "channels.nostr.allowFrom",
  channel,
  getCurrent: (cfg) => (cfg.channels?.nostr?.dmPolicy as DmPolicy | undefined) ?? "pairing",
  label: "Nostr",
  policyKey: "channels.nostr.dmPolicy",
  promptAllowFrom: promptNostrAllowFrom,
});

export const nostrSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    const relayResult = typedInput.relayUrls?.trim()
      ? parseRelayUrls(typedInput.relayUrls)
      : { relays: [] };
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      clearFields: typedInput.useEnv ? ["privateKey"] : undefined,
      enabled: true,
      patch: buildNostrSetupPatch(accountId, {
        ...(typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() }),
        ...(relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}),
      }),
    });
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: buildNostrSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
    }),
  resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultNostrAccountId(cfg),
  validateInput: ({ input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      privateKey?: string;
      relayUrls?: string;
    };
    if (!typedInput.useEnv) {
      const privateKey = typedInput.privateKey?.trim();
      if (!privateKey) {
        return "Nostr requires --private-key or --use-env.";
      }
      try {
        getPublicKeyFromPrivate(privateKey);
      } catch {
        return "Nostr private key must be valid nsec or 64-character hex.";
      }
    }
    if (typedInput.relayUrls?.trim()) {
      return parseRelayUrls(typedInput.relayUrls).error ?? null;
    }
    return null;
  },
};

export const nostrSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: buildNostrSetupPatch(accountId, { privateKey: resolvedValue }),
        }),
      applyUseEnv: async ({ cfg, accountId }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["privateKey"],
          patch: buildNostrSetupPatch(accountId, {}),
        }),
      credentialLabel: "private key",
      envPrompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
      helpLines: NOSTR_SETUP_HELP_LINES,
      helpTitle: "Nostr private key",
      inputKey: "privateKey",
      inputPrompt: "Nostr private key (nsec... or hex)",
      inspect: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: hasConfiguredSecretInput(account.config.privateKey),
          resolvedValue: normalizeSecretInputString(account.config.privateKey),
          envValue: process.env.NOSTR_PRIVATE_KEY?.trim(),
        };
      },
      keepPrompt: "Nostr private key already configured. Keep it?",
      preferredEnvVar: "NOSTR_PRIVATE_KEY",
      providerHint: channel,
    },
  ],
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
  dmPolicy: nostrDmPolicy,
  envShortcut: {
    apply: async ({ cfg, accountId }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        clearFields: ["privateKey"],
        enabled: true,
        patch: buildNostrSetupPatch(accountId, {}),
      }),
    isAvailable: ({ cfg, accountId }) =>
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.NOSTR_PRIVATE_KEY?.trim()) &&
      !hasConfiguredSecretInput(resolveNostrAccount({ accountId, cfg }).config.privateKey),
    preferredEnvVar: "NOSTR_PRIVATE_KEY",
    prompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
  },
  introNote: {
    lines: NOSTR_SETUP_HELP_LINES,
    title: "Nostr setup",
  },
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId }) =>
    accountOverride?.trim() || defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: createStandardChannelSetupStatus({
    channelLabel: "Nostr",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 1,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => resolveNostrAccount({ cfg }).configured,
    resolveExtraStatusLines: ({ cfg }) => {
      const account = resolveNostrAccount({ cfg });
      return [`Relays: ${account.relays.length || DEFAULT_RELAYS.length}`];
    },
    unconfiguredHint: "needs private key",
    unconfiguredLabel: "needs private key",
    unconfiguredScore: 0,
  }),
  textInputs: [
    {
      applyEmptyValue: true,
      applySet: async ({ cfg, accountId, value }) => {
        const relayResult = parseRelayUrls(value);
        return patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: relayResult.relays.length > 0 ? undefined : ["relays"],
          patch: buildNostrSetupPatch(
            accountId,
            relayResult.relays.length > 0 ? { relays: relayResult.relays } : {},
          ),
        });
      },
      currentValue: ({ cfg, accountId }) => {
        const account = resolveNostrAccount({ cfg, accountId });
        const configuredRelays = cfg.channels?.nostr?.relays as string[] | undefined;
        const relays = configuredRelays && configuredRelays.length > 0 ? account.relays : [];
        return relays.join(", ");
      },
      helpLines: ["Use ws:// or wss:// relay URLs.", "Leave blank to keep the default relay set."],
      helpTitle: "Nostr relays",
      inputKey: "relayUrls",
      keepPrompt: (value) => `Relay URLs set (${value}). Keep them?`,
      message: "Relay URLs (comma-separated, optional)",
      placeholder: DEFAULT_RELAYS.join(", "),
      required: false,
      validate: ({ value }) => parseRelayUrls(value).error,
    },
  ],
};
