import {
  type ChannelSetupWizard,
  createStandardChannelSetupStatus,
  formatDocsLink,
} from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  applySetupAccountConfigPatch,
} from "./runtime-api.js";
import { isMattermostConfigured, resolveMattermostAccountWithSecrets } from "./setup-core.js";
import { normalizeMattermostBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";

const channel = "mattermost" as const;
export { mattermostSetupAdapter } from "./setup-core.js";

export const mattermostSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [
    {
      credentialLabel: "bot token",
      envPrompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
      inputKey: "botToken",
      inputPrompt: "Enter Mattermost bot token",
      inspect: ({ cfg, accountId }) => {
        const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
        return {
          accountConfigured: isMattermostConfigured(resolvedAccount),
          hasConfiguredValue: hasConfiguredSecretInput(resolvedAccount.config.botToken),
        };
      },
      keepPrompt: "Mattermost bot token already configured. Keep it?",
      preferredEnvVar: "MATTERMOST_BOT_TOKEN",
      providerHint: channel,
    },
  ],
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      mattermost: {
        ...cfg.channels?.mattermost,
        enabled: false,
      },
    },
  }),
  envShortcut: {
    apply: ({ cfg, accountId }) =>
      applySetupAccountConfigPatch({
        accountId,
        cfg,
        channelKey: channel,
        patch: {},
      }),
    isAvailable: ({ cfg, accountId }) => {
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        return false;
      }
      const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
      const hasConfigValues =
        hasConfiguredSecretInput(resolvedAccount.config.botToken) ||
        Boolean(resolvedAccount.config.baseUrl?.trim());
      return Boolean(
        process.env.MATTERMOST_BOT_TOKEN?.trim() &&
        process.env.MATTERMOST_URL?.trim() &&
        !hasConfigValues,
      );
    },
    preferredEnvVar: "MATTERMOST_BOT_TOKEN",
    prompt: "MATTERMOST_BOT_TOKEN + MATTERMOST_URL detected. Use env vars?",
  },
  introNote: {
    lines: [
      "1) Mattermost System Console -> Integrations -> Bot Accounts",
      "2) Create a bot + copy its token",
      "3) Use your server base URL (e.g., https://chat.example.com)",
      "Tip: the bot must be a member of any channel you want it to monitor.",
      `Docs: ${formatDocsLink("/mattermost", "mattermost")}`,
    ],
    shouldShow: ({ cfg, accountId }) =>
      !isMattermostConfigured(resolveMattermostAccountWithSecrets(cfg, accountId)),
    title: "Mattermost bot token",
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "Mattermost",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 2,
    resolveConfigured: ({ cfg, accountId }) =>
      isMattermostConfigured(
        resolveMattermostAccountWithSecrets(cfg, accountId ?? DEFAULT_ACCOUNT_ID),
      ),
    unconfiguredHint: "needs setup",
    unconfiguredLabel: "needs token + url",
    unconfiguredScore: 1,
  }),
  textInputs: [
    {
      confirmCurrentValue: false,
      currentValue: ({ cfg, accountId }) =>
        resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ??
        process.env.MATTERMOST_URL?.trim(),
      initialValue: ({ cfg, accountId }) =>
        resolveMattermostAccountWithSecrets(cfg, accountId).baseUrl ??
        process.env.MATTERMOST_URL?.trim(),
      inputKey: "httpUrl",
      message: "Enter Mattermost base URL",
      normalizeValue: ({ value }) => normalizeMattermostBaseUrl(value) ?? value.trim(),
      shouldPrompt: ({ cfg, accountId, credentialValues, currentValue }) => {
        const resolvedAccount = resolveMattermostAccountWithSecrets(cfg, accountId);
        const tokenConfigured =
          Boolean(resolvedAccount.botToken?.trim()) ||
          hasConfiguredSecretInput(resolvedAccount.config.botToken);
        return Boolean(credentialValues.botToken) || !tokenConfigured || !currentValue;
      },
      validate: ({ value }) =>
        normalizeMattermostBaseUrl(value)
          ? undefined
          : "Mattermost base URL must include a valid base URL.",
    },
  ],
};
