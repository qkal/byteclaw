import {
  type ChannelSetupAdapter,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createAllowFromSection,
  createStandardChannelSetupStatus,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";
import type { SynologyChatAccountRaw, SynologyChatChannelConfig } from "./types.js";

const channel = "synology-chat" as const;
const DEFAULT_WEBHOOK_PATH = "/webhook/synology";

const SYNOLOGY_SETUP_HELP_LINES = [
  "1) Create an incoming webhook in Synology Chat and copy its URL",
  "2) Create an outgoing webhook and copy its secret token",
  `3) Point the outgoing webhook to https://<gateway-host>${DEFAULT_WEBHOOK_PATH}`,
  "4) Keep allowed user IDs handy for DM allowlisting",
  `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
];

const SYNOLOGY_ALLOW_FROM_HELP_LINES = [
  "Allowlist Synology Chat DMs by numeric user id.",
  "Examples:",
  "- 123456",
  "- synology-chat:123456",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
];

function getChannelConfig(cfg: OpenClawConfig): SynologyChatChannelConfig {
  return (cfg.channels?.[channel] as SynologyChatChannelConfig | undefined) ?? {};
}

function getRawAccountConfig(cfg: OpenClawConfig, accountId: string): SynologyChatAccountRaw {
  const channelConfig = getChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return channelConfig;
  }
  return channelConfig.accounts?.[accountId] ?? {};
}

function patchSynologyChatAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const channelConfig = getChannelConfig(params.cfg);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    const nextChannelConfig = { ...channelConfig } as Record<string, unknown>;
    for (const field of params.clearFields ?? []) {
      delete nextChannelConfig[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...nextChannelConfig,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccounts = { ...channelConfig.accounts } as Record<string, Record<string, unknown>>;
  const nextAccountConfig = { ...nextAccounts[params.accountId] };
  for (const field of params.clearFields ?? []) {
    delete nextAccountConfig[field];
  }
  nextAccounts[params.accountId] = {
    ...nextAccountConfig,
    ...(params.enabled ? { enabled: true } : {}),
    ...params.patch,
  };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: nextAccounts,
      },
    },
  };
}

function isSynologyChatConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveAccount(cfg, accountId);
  return Boolean(account.token.trim() && account.incomingUrl.trim());
}

function validateWebhookUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Incoming webhook must use http:// or https://.";
    }
  } catch {
    return "Incoming webhook must be a valid URL.";
  }
  return undefined;
}

function validateWebhookPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("/") ? undefined : "Webhook path must start with /.";
}

function parseSynologyUserId(value: string): string | null {
  const cleaned = value.replace(/^synology-chat:/i, "").trim();
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function resolveExistingAllowedUserIds(cfg: OpenClawConfig, accountId: string): string[] {
  const raw = getRawAccountConfig(cfg, accountId).allowedUserIds;
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value).trim()).filter(Boolean);
  }
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const synologyChatSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) =>
    patchSynologyChatAccountConfig({
      accountId,
      cfg,
      clearFields: input.useEnv ? ["token"] : undefined,
      enabled: true,
      patch: {
        ...(input.useEnv ? {} : { token: input.token?.trim() }),
        incomingUrl: input.url?.trim(),
        ...(input.webhookPath?.trim() ? { webhookPath: input.webhookPath.trim() } : {}),
      },
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "Synology Chat env credentials only support the default account.";
    }
    if (!input.useEnv && !input.token?.trim()) {
      return "Synology Chat requires --token or --use-env.";
    }
    if (!input.url?.trim()) {
      return "Synology Chat requires --url for the incoming webhook.";
    }
    const urlError = validateWebhookUrl(input.url.trim());
    if (urlError) {
      return urlError;
    }
    if (input.webhookPath?.trim()) {
      return validateWebhookPath(input.webhookPath.trim()) ?? null;
    }
    return null;
  },
};

export const synologyChatSetupWizard: ChannelSetupWizard = {
  allowFrom: createAllowFromSection({
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchSynologyChatAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: {
          dmPolicy: "allowlist",
          allowedUserIds: mergeAllowFromEntries(
            resolveExistingAllowedUserIds(cfg, accountId),
            allowFrom,
          ),
        },
      }),
    helpLines: SYNOLOGY_ALLOW_FROM_HELP_LINES,
    helpTitle: "Synology Chat allowlist",
    invalidWithoutCredentialNote: "Synology Chat user ids must be numeric.",
    message: "Allowed Synology Chat user ids",
    parseId: parseSynologyUserId,
    parseInputs: splitSetupEntries,
    placeholder: "123456, 987654",
  }),
  channel,
  completionNote: {
    lines: [
      `Default outgoing webhook path: ${DEFAULT_WEBHOOK_PATH}`,
      'Set allowed user IDs, or manually switch `channels.synology-chat.dmPolicy` to `"open"` for public DMs.',
      'With `dmPolicy="allowlist"`, an empty allowedUserIds list blocks the route from starting.',
      `Docs: ${formatDocsLink("/channels/synology-chat", "channels/synology-chat")}`,
    ],
    title: "Synology Chat access control",
  },
  credentials: [
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          patch: { token: resolvedValue },
        }),
      applyUseEnv: async ({ cfg, accountId }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["token"],
          patch: {},
        }),
      credentialLabel: "outgoing webhook token",
      envPrompt: "SYNOLOGY_CHAT_TOKEN detected. Use env var?",
      helpLines: SYNOLOGY_SETUP_HELP_LINES,
      helpTitle: "Synology Chat webhook token",
      inputKey: "token",
      inputPrompt: "Enter Synology Chat outgoing webhook token",
      inspect: ({ cfg, accountId }) => {
        const account = resolveAccount(cfg, accountId);
        const raw = getRawAccountConfig(cfg, accountId);
        return {
          accountConfigured: isSynologyChatConfigured(cfg, accountId),
          hasConfiguredValue: Boolean(normalizeOptionalString(raw.token)),
          resolvedValue: normalizeOptionalString(account.token),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.SYNOLOGY_CHAT_TOKEN)
              : undefined,
        };
      },
      keepPrompt: "Synology Chat webhook token already configured. Keep it?",
      preferredEnvVar: "SYNOLOGY_CHAT_TOKEN",
      providerHint: channel,
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  introNote: {
    lines: SYNOLOGY_SETUP_HELP_LINES,
    title: "Synology Chat webhook setup",
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "Synology Chat",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 1,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      accountId
        ? isSynologyChatConfigured(cfg, accountId)
        : listAccountIds(cfg).some((candidateAccountId) =>
            isSynologyChatConfigured(cfg, candidateAccountId),
          ),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listAccountIds(cfg).length || 0}`],
    unconfiguredHint: "needs token + incoming webhook",
    unconfiguredLabel: "needs token + incoming webhook",
    unconfiguredScore: 0,
  }),
  textInputs: [
    {
      applySet: async ({ cfg, accountId, value }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          patch: { incomingUrl: value.trim() },
        }),
      currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).incomingUrl?.trim(),
      helpLines: [
        "Use the incoming webhook URL from Synology Chat integrations.",
        "This is the URL OpenClaw uses to send replies back to Chat.",
      ],
      helpTitle: "Synology Chat incoming webhook",
      inputKey: "url",
      keepPrompt: (value) => `Incoming webhook URL set (${value}). Keep it?`,
      message: "Incoming webhook URL",
      placeholder:
        "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming...",
      validate: ({ value }) => validateWebhookUrl(value),
    },
    {
      applyEmptyValue: true,
      applySet: async ({ cfg, accountId, value }) =>
        patchSynologyChatAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: value.trim() ? undefined : ["webhookPath"],
          patch: value.trim() ? { webhookPath: value.trim() } : {},
        }),
      currentValue: ({ cfg, accountId }) => getRawAccountConfig(cfg, accountId).webhookPath?.trim(),
      helpLines: [
        `Default path: ${DEFAULT_WEBHOOK_PATH}`,
        "Change this only if you need multiple Synology Chat webhook routes.",
      ],
      helpTitle: "Synology Chat outgoing webhook path",
      inputKey: "webhookPath",
      keepPrompt: (value) => `Outgoing webhook path set (${value}). Keep it?`,
      message: "Outgoing webhook path (optional)",
      placeholder: DEFAULT_WEBHOOK_PATH,
      required: false,
      validate: ({ value }) => validateWebhookPath(value),
    },
  ],
};
