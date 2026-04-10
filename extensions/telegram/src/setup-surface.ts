import {
  DEFAULT_ACCOUNT_ID,
  createAllowFromSection,
  createStandardChannelSetupStatus,
  hasConfiguredSecretInput,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import {
  TELEGRAM_TOKEN_HELP_LINES,
  TELEGRAM_USER_ID_HELP_LINES,
  parseTelegramAllowFromId,
  resolveTelegramAllowFromEntries,
  telegramSetupAdapter,
} from "./setup-core.js";
import {
  buildTelegramDmAccessWarningLines,
  ensureTelegramDefaultGroupMentionGate,
  shouldShowTelegramDmAccessWarning,
  telegramSetupDmPolicy,
} from "./setup-surface.helpers.js";

const channel = "telegram" as const;

export const telegramSetupWizard: ChannelSetupWizard = {
  allowFrom: createAllowFromSection({
    apply: async ({ cfg, accountId, allowFrom }) =>
      patchChannelConfigForAccount({
        cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
    credentialInputKey: "token",
    helpLines: TELEGRAM_USER_ID_HELP_LINES,
    helpTitle: "Telegram user id",
    invalidWithoutCredentialNote:
      "Telegram token missing; use numeric sender ids (usernames require a bot token).",
    message: "Telegram allowFrom (numeric sender id; @username resolves to id)",
    parseId: parseTelegramAllowFromId,
    parseInputs: splitSetupEntries,
    placeholder: "@username",
    resolveEntries: async ({ cfg, accountId, credentialValues, entries }) =>
      resolveTelegramAllowFromEntries({
        credentialValue: credentialValues.token,
        entries,
        apiRoot: resolveTelegramAccount({ cfg, accountId }).config.apiRoot,
      }),
  }),
  channel,
  credentials: [
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      credentialLabel: "Telegram bot token",
      envPrompt: "TELEGRAM_BOT_TOKEN detected. Use env var?",
      helpLines: TELEGRAM_TOKEN_HELP_LINES,
      helpTitle: "Telegram bot token",
      inputKey: "token",
      inputPrompt: "Enter Telegram bot token",
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveTelegramAccount({ cfg, accountId });
        const hasConfiguredBotToken = hasConfiguredSecretInput(resolved.config.botToken);
        const hasConfiguredValue =
          hasConfiguredBotToken || Boolean(resolved.config.tokenFile?.trim());
        return {
          accountConfigured: Boolean(resolved.token) || hasConfiguredValue,
          hasConfiguredValue,
          resolvedValue: normalizeOptionalString(resolved.token),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.TELEGRAM_BOT_TOKEN)
              : undefined,
        };
      },
      keepPrompt: "Telegram token already configured. Keep it?",
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      providerHint: channel,
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  dmPolicy: telegramSetupDmPolicy,
  finalize: async ({ cfg, accountId, prompter }) => {
    if (!shouldShowTelegramDmAccessWarning(cfg, accountId)) {
      return;
    }
    await prompter.note(
      buildTelegramDmAccessWarningLines(accountId).join("\n"),
      "Telegram DM access warning",
    );
  },
  prepare: async ({ cfg, accountId, credentialValues }) => ({
    cfg: ensureTelegramDefaultGroupMentionGate(cfg, accountId),
    credentialValues,
  }),
  status: createStandardChannelSetupStatus({
    channelLabel: "Telegram",
    configuredHint: "recommended · configured",
    configuredLabel: "configured",
    configuredScore: 1,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listTelegramAccountIds(cfg)).some((resolvedAccountId) => {
        const account = inspectTelegramAccount({ cfg, accountId: resolvedAccountId });
        return account.configured;
      }),
    unconfiguredHint: "recommended · newcomer-friendly",
    unconfiguredLabel: "needs token",
    unconfiguredScore: 10,
  }),
};

export { parseTelegramAllowFromId, telegramSetupAdapter };
