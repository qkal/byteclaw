import {
  createAllowFromSection,
  createStandardChannelSetupStatus,
  mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultLineAccountId } from "./accounts.js";
import {
  isLineConfigured,
  listLineAccountIds,
  parseLineAllowFromId,
  patchLineAccountConfig,
} from "./setup-core.js";
import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  resolveLineAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "./setup-runtime-api.js";

const channel = "line" as const;

const LINE_SETUP_HELP_LINES = [
  "1) Open the LINE Developers Console and create or pick a Messaging API channel",
  "2) Copy the channel access token and channel secret",
  "3) Enable Use webhook in the Messaging API settings",
  "4) Point the webhook at https://<gateway-host>/line/webhook",
  `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
];

const LINE_ALLOW_FROM_HELP_LINES = [
  "Allowlist LINE DMs by user id.",
  "LINE ids are case-sensitive.",
  "Examples:",
  "- U1234567890abcdef1234567890abcdef",
  "- line:user:U1234567890abcdef1234567890abcdef",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
];

const lineDmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.line.allowFrom",
  channel,
  getCurrent: (cfg, accountId) =>
    resolveLineAccount({ accountId: accountId ?? resolveDefaultLineAccountId(cfg), cfg }).config
      .dmPolicy ?? "pairing",
  label: "LINE",
  policyKey: "channels.line.dmPolicy",
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultLineAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.allowFrom`,
          policyKey: `channels.line.accounts.${accountId ?? resolveDefaultLineAccountId(cfg)}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.line.allowFrom",
          policyKey: "channels.line.dmPolicy",
        },
  setPolicy: (cfg, policy, accountId) =>
    patchLineAccountConfig({
      accountId: accountId ?? resolveDefaultLineAccountId(cfg),
      cfg,
      clearFields: policy === "pairing" || policy === "disabled" ? ["allowFrom"] : undefined,
      enabled: true,
      patch:
        policy === "open"
          ? {
              dmPolicy: "open",
              allowFrom: mergeAllowFromEntries(
                resolveLineAccount({
                  cfg,
                  accountId: accountId ?? resolveDefaultLineAccountId(cfg),
                }).config.allowFrom,
                ["*"],
              ),
            }
          : { dmPolicy: policy },
    }),
};

export { lineSetupAdapter } from "./setup-core.js";

export const lineSetupWizard: ChannelSetupWizard = {
  allowFrom: createAllowFromSection({
    apply: ({ cfg, accountId, allowFrom }) =>
      patchLineAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
    helpLines: LINE_ALLOW_FROM_HELP_LINES,
    helpTitle: "LINE allowlist",
    invalidWithoutCredentialNote:
      "LINE allowFrom requires raw user ids like U1234567890abcdef1234567890abcdef.",
    message: "LINE allowFrom (user id)",
    parseId: parseLineAllowFromId,
    parseInputs: splitSetupEntries,
    placeholder: "U1234567890abcdef1234567890abcdef",
  }),
  channel,
  completionNote: {
    lines: [
      "Enable Use webhook in the LINE console after saving credentials.",
      "Default webhook URL: https://<gateway-host>/line/webhook",
      "If you set channels.line.webhookPath, update the URL to match.",
      `Docs: ${formatDocsLink("/channels/line", "channels/line")}`,
    ],
    title: "LINE webhook",
  },
  credentials: [
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["tokenFile"],
          patch: { channelAccessToken: resolvedValue },
        }),
      applyUseEnv: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["channelAccessToken", "tokenFile"],
          patch: {},
        }),
      credentialLabel: "channel access token",
      envPrompt: "LINE_CHANNEL_ACCESS_TOKEN detected. Use env var?",
      helpLines: LINE_SETUP_HELP_LINES,
      helpTitle: "LINE Messaging API",
      inputKey: "token",
      inputPrompt: "Enter LINE channel access token",
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return {
          accountConfigured: Boolean(
            normalizeOptionalString(resolved.channelAccessToken) &&
            normalizeOptionalString(resolved.channelSecret),
          ),
          hasConfiguredValue: Boolean(
            normalizeOptionalString(resolved.config.channelAccessToken) ??
            normalizeOptionalString(resolved.config.tokenFile),
          ),
          resolvedValue: normalizeOptionalString(resolved.channelAccessToken),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.LINE_CHANNEL_ACCESS_TOKEN)
              : undefined,
        };
      },
      keepPrompt: "LINE channel access token already configured. Keep it?",
      preferredEnvVar: "LINE_CHANNEL_ACCESS_TOKEN",
      providerHint: channel,
    },
    {
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["secretFile"],
          patch: { channelSecret: resolvedValue },
        }),
      applyUseEnv: ({ cfg, accountId }) =>
        patchLineAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["channelSecret", "secretFile"],
          patch: {},
        }),
      credentialLabel: "channel secret",
      envPrompt: "LINE_CHANNEL_SECRET detected. Use env var?",
      helpLines: LINE_SETUP_HELP_LINES,
      helpTitle: "LINE Messaging API",
      inputKey: "password",
      inputPrompt: "Enter LINE channel secret",
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveLineAccount({ cfg, accountId });
        return {
          accountConfigured: Boolean(
            normalizeOptionalString(resolved.channelAccessToken) &&
            normalizeOptionalString(resolved.channelSecret),
          ),
          hasConfiguredValue: Boolean(
            normalizeOptionalString(resolved.config.channelSecret) ??
            normalizeOptionalString(resolved.config.secretFile),
          ),
          resolvedValue: normalizeOptionalString(resolved.channelSecret),
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? normalizeOptionalString(process.env.LINE_CHANNEL_SECRET)
              : undefined,
        };
      },
      keepPrompt: "LINE channel secret already configured. Keep it?",
      preferredEnvVar: "LINE_CHANNEL_SECRET",
      providerHint: "line-secret",
    },
  ],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  dmPolicy: lineDmPolicy,
  introNote: {
    lines: LINE_SETUP_HELP_LINES,
    shouldShow: ({ cfg, accountId }) =>
      !isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
    title: "LINE Messaging API",
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "LINE",
    configuredHint: "configured",
    configuredLabel: "configured",
    configuredScore: 1,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      isLineConfigured(cfg, accountId ?? resolveDefaultLineAccountId(cfg)),
    resolveExtraStatusLines: ({ cfg }) => [`Accounts: ${listLineAccountIds(cfg).length || 0}`],
    unconfiguredHint: "needs token + secret",
    unconfiguredLabel: "needs token + secret",
    unconfiguredScore: 0,
  }),
};
