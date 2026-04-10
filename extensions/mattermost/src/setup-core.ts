import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
} from "./runtime-api.js";
import {
  type ResolvedMattermostAccount,
  resolveMattermostAccount,
} from "./setup.accounts.runtime.js";
import { normalizeMattermostBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";

const channel = "mattermost" as const;

export function isMattermostConfigured(account: ResolvedMattermostAccount): boolean {
  const tokenConfigured =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  return tokenConfigured && Boolean(account.baseUrl);
}

export function resolveMattermostAccountWithSecrets(cfg: OpenClawConfig, accountId: string) {
  return resolveMattermostAccount({
    accountId,
    allowUnresolvedSecretRef: true,
    cfg,
  });
}

export const mattermostSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const token = input.botToken ?? input.token;
    const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
    const namedConfig = applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
          })
        : namedConfig;
    return applySetupAccountConfigPatch({
      accountId,
      cfg: next,
      channelKey: channel,
      patch: input.useEnv
        ? {}
        : {
            ...(token ? { botToken: token } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          },
    });
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      accountId,
      cfg,
      channelKey: channel,
      name,
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "Mattermost env vars can only be used for the default account.",
    validate: ({ input }) => {
      const token = input.botToken ?? input.token;
      const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
      if (!input.useEnv && (!token || !baseUrl)) {
        return "Mattermost requires --bot-token and --http-url (or --use-env).";
      }
      if (input.httpUrl && !baseUrl) {
        return "Mattermost --http-url must include a valid base URL.";
      }
      return null;
    },
    whenNotUseEnv: [
      {
        someOf: ["botToken", "token"],
        message: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
      {
        someOf: ["httpUrl"],
        message: "Mattermost requires --bot-token and --http-url (or --use-env).",
      },
    ],
  }),
};
