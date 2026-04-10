import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  addWildcardAllowFrom,
  applySetupAccountConfigPatch,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  formatDocsLink,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDefaultGoogleChatAccountId, resolveGoogleChatAccount } from "./accounts.js";

const channel = "googlechat" as const;
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";

const promptAllowFrom = createPromptParsedAllowFromForAccount({
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    applySetupAccountConfigPatch({
      accountId,
      cfg,
      channelKey: channel,
      patch: {
        dm: {
          ...resolveGoogleChatAccount({ cfg, accountId }).config.dm,
          allowFrom,
        },
      },
    }),
  defaultAccountId: resolveDefaultGoogleChatAccountId,
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveGoogleChatAccount({ accountId, cfg }).config.dm?.allowFrom ?? [],
  message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
  parseEntries: (raw) => ({
    entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
  }),
  placeholder: "users/123456789, name@example.com",
});

const googlechatDmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.googlechat.dm.allowFrom",
  channel,
  getCurrent: (cfg, accountId) =>
    resolveGoogleChatAccount({
      accountId: accountId ?? resolveDefaultGoogleChatAccountId(cfg),
      cfg,
    }).config.dm?.policy ?? "pairing",
  label: "Google Chat",
  policyKey: "channels.googlechat.dm.policy",
  promptAllowFrom,
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultGoogleChatAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.allowFrom`,
          policyKey: `channels.googlechat.accounts.${accountId ?? resolveDefaultGoogleChatAccountId(cfg)}.dm.policy`,
        }
      : {
          allowFromKey: "channels.googlechat.dm.allowFrom",
          policyKey: "channels.googlechat.dm.policy",
        },
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId = accountId ?? resolveDefaultGoogleChatAccountId(cfg);
    const currentDm = resolveGoogleChatAccount({
      accountId: resolvedAccountId,
      cfg,
    }).config.dm;
    return applySetupAccountConfigPatch({
      accountId: resolvedAccountId,
      cfg,
      channelKey: channel,
      patch: {
        dm: {
          ...currentDm,
          policy,
          ...(policy === "open" ? { allowFrom: addWildcardAllowFrom(currentDm?.allowFrom) } : {}),
        },
      },
    });
  },
};

export { googlechatSetupAdapter } from "./setup-core.js";

export const googlechatSetupWizard: ChannelSetupWizard = {
  channel,
  credentials: [],
  dmPolicy: googlechatDmPolicy,
  finalize: async ({ cfg, accountId, prompter }) => {
    const account = resolveGoogleChatAccount({
      accountId,
      cfg,
    });
    const audienceType = await prompter.select({
      initialValue: account.config.audienceType === "project-number" ? "project-number" : "app-url",
      message: "Webhook audience type",
      options: [
        { value: "app-url", label: "App URL (recommended)" },
        { value: "project-number", label: "Project number" },
      ],
    });
    const audience = await prompter.text({
      initialValue: account.config.audience || undefined,
      message: audienceType === "project-number" ? "Project number" : "App URL",
      placeholder:
        audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
      validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    });
    return {
      cfg: migrateBaseNameToDefaultAccount({
        cfg: applySetupAccountConfigPatch({
          accountId,
          cfg,
          channelKey: channel,
          patch: {
            audience: normalizeOptionalString(audience) ?? "",
            audienceType,
          },
        }),
        channelKey: channel,
      }),
    };
  },
  introNote: {
    lines: [
      "Google Chat apps use service-account auth and an HTTPS webhook.",
      "Set the Chat API scopes in your service account and configure the Chat app URL.",
      "Webhook verification requires audience type + audience value.",
      `Docs: ${formatDocsLink("/channels/googlechat", "googlechat")}`,
    ],
    title: "Google Chat setup",
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const envReady =
      accountId === DEFAULT_ACCOUNT_ID &&
      (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]));
    if (envReady) {
      const useEnv = await prompter.confirm({
        initialValue: true,
        message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
      });
      if (useEnv) {
        return {
          cfg: applySetupAccountConfigPatch({
            accountId,
            cfg,
            channelKey: channel,
            patch: {},
          }),
          credentialValues: {
            ...credentialValues,
            [USE_ENV_FLAG]: "1",
          },
        };
      }
    }

    const method = await prompter.select({
      initialValue: "file",
      message: "Google Chat auth method",
      options: [
        { value: "file", label: "Service account JSON file" },
        { value: "inline", label: "Paste service account JSON" },
      ],
    });

    return {
      credentialValues: {
        ...credentialValues,
        [USE_ENV_FLAG]: "0",
        [AUTH_METHOD_FLAG]: String(method),
      },
    };
  },
  status: createStandardChannelSetupStatus({
    channelLabel: "Google Chat",
    configuredHint: "configured",
    configuredLabel: "configured",
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).credentialSource !== "none",
    unconfiguredHint: "needs auth",
    unconfiguredLabel: "needs service account",
  }),
  textInputs: [
    {
      applySet: async ({ cfg, accountId, value }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { serviceAccountFile: value },
        }),
      inputKey: "tokenFile",
      message: "Service account JSON path",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      placeholder: "/path/to/service-account.json",
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "file",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
    {
      applySet: async ({ cfg, accountId, value }) =>
        applySetupAccountConfigPatch({
          cfg,
          channelKey: channel,
          accountId,
          patch: { serviceAccount: value },
        }),
      inputKey: "token",
      message: "Service account JSON (single line)",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      placeholder: '{"type":"service_account", ... }',
      shouldPrompt: ({ credentialValues }) =>
        credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "inline",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    },
  ],
};
