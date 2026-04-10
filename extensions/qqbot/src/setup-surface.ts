import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createStandardChannelSetupStatus,
  hasConfiguredSecretInput,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  applyQQBotAccountConfig,
  listQQBotAccountIds,
  resolveQQBotAccount,
} from "./config.js";

const channel = "qqbot" as const;

type QQBotEnvCredentialField = "appId" | "clientSecret";

/**
 * Clear only the credential fields owned by the setup prompt that switched to
 * env-backed resolution. This preserves mixed-source setups such as config
 * AppID + env AppSecret.
 */
function clearQQBotCredentialField(
  cfg: OpenClawConfig,
  accountId: string,
  field: QQBotEnvCredentialField,
): OpenClawConfig {
  const next = { ...cfg };
  const qqbot = { ...(next.channels?.qqbot as Record<string, unknown> | undefined) };

  const clearField = (entry: Record<string, unknown>) => {
    if (field === "appId") {
      delete entry.appId;
      return;
    }
    delete entry.clientSecret;
    delete entry.clientSecretFile;
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    clearField(qqbot);
  } else {
    const accounts = { ...(qqbot.accounts as Record<string, Record<string, unknown>> | undefined) };
    if (accounts[accountId]) {
      const entry = { ...accounts[accountId] };
      clearField(entry);
      accounts[accountId] = entry;
      qqbot.accounts = accounts;
    }
  }

  next.channels = { ...next.channels, qqbot };
  return next;
}

const QQBOT_SETUP_HELP_LINES = [
  "To create a QQ Bot, visit the QQ Open Platform:",
  `  ${formatDocsLink("https://q.qq.com", "q.qq.com")}`,
  "",
  "1. Create an application and note the AppID.",
  "2. Go to development settings to find the AppSecret.",
];

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { appId: resolvedValue }),
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(applyQQBotAccountConfig(cfg, accountId, {}), accountId, "appId"),
      credentialLabel: "AppID",
      envPrompt: "QQBOT_APP_ID detected. Use env var?",
      helpLines: QQBOT_SETUP_HELP_LINES,
      helpTitle: "QQ Bot AppID",
      inputKey: "token",
      inputPrompt: "Enter QQ Bot AppID",
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
        const hasConfiguredValue = Boolean(
          hasConfiguredSecretInput(resolved.config.clientSecret) ||
          normalizeOptionalString(resolved.config.clientSecretFile) ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue: Boolean(resolved.appId),
          resolvedValue: resolved.appId || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_APP_ID)
              : undefined,
        };
      },
      keepPrompt: "QQ Bot AppID already configured. Keep it?",
      preferredEnvVar: "QQBOT_APP_ID",
      providerHint: channel,
    },
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: ({ cfg, accountId, resolvedValue }) =>
        applyQQBotAccountConfig(cfg, accountId, { clientSecret: resolvedValue }),
      applyUseEnv: ({ cfg, accountId }) =>
        clearQQBotCredentialField(
          applyQQBotAccountConfig(cfg, accountId, {}),
          accountId,
          "clientSecret",
        ),
      credentialLabel: "AppSecret",
      envPrompt: "QQBOT_CLIENT_SECRET detected. Use env var?",
      helpLines: QQBOT_SETUP_HELP_LINES,
      helpTitle: "QQ Bot AppSecret",
      inputKey: "password",
      inputPrompt: "Enter QQ Bot AppSecret",
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveQQBotAccount(cfg, accountId, { allowUnresolvedSecretRef: true });
        const hasConfiguredValue = Boolean(
          hasConfiguredSecretInput(resolved.config.clientSecret) ||
          normalizeOptionalString(resolved.config.clientSecretFile) ||
          resolved.clientSecret,
        );
        return {
          accountConfigured: Boolean(resolved.appId && hasConfiguredValue),
          hasConfiguredValue,
          resolvedValue: resolved.clientSecret || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.QQBOT_CLIENT_SECRET)
              : undefined,
        };
      },
      keepPrompt: "QQ Bot AppSecret already configured. Keep it?",
      preferredEnvVar: "QQBOT_CLIENT_SECRET",
      providerHint: "qqbot-secret",
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  status: createStandardChannelSetupStatus({
    channelLabel: "QQ Bot",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg)).some((resolvedAccountId) => {
        const account = resolveQQBotAccount(cfg, resolvedAccountId, {
          allowUnresolvedSecretRef: true,
        });
        return Boolean(
          account.appId &&
          (Boolean(account.clientSecret) ||
            hasConfiguredSecretInput(account.config.clientSecret) ||
            Boolean(account.config.clientSecretFile?.trim())),
        );
      }),
    unconfiguredHint: "needs AppID + AppSecret",
    unconfiguredLabel: "needs AppID + AppSecret",
    unconfiguredScore: 6,
  }),
};
