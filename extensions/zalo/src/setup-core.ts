import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  DEFAULT_ACCOUNT_ID,
  addWildcardAllowFrom,
  createDelegatedSetupWizardProxy,
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  normalizeAccountId,
} from "openclaw/plugin-sdk/setup";
import { resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { promptZaloAllowFrom } from "./setup-allow-from.js";

const channel = "zalo" as const;

interface ZaloAccountSetupConfig {
  enabled?: boolean;
  dmPolicy?: string;
  allowFrom?: (string | number)[] | readonly (string | number)[];
}

export const zaloSetupAdapter = createPatchedAccountSetupAdapter({
  buildPatch: (input) =>
    input.useEnv
      ? {}
      : input.tokenFile
        ? { tokenFile: input.tokenFile }
        : input.token
          ? { botToken: input.token }
          : {},
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError: "ZALO_BOT_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      {
        message: "Zalo requires token or --token-file (or --use-env).",
        someOf: ["token", "tokenFile"],
      },
    ],
  }),
});

export const zaloDmPolicy: ChannelSetupDmPolicy = {
  allowFromKey: "channels.zalo.allowFrom",
  channel,
  getCurrent: (cfg, accountId) =>
    resolveZaloAccount({
      cfg,
      accountId: accountId ?? resolveDefaultZaloAccountId(cfg),
    }).config.dmPolicy ?? "pairing",
  label: "Zalo",
  policyKey: "channels.zalo.dmPolicy",
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    promptZaloAllowFrom({
      accountId: accountId ?? resolveDefaultZaloAccountId(cfg),
      cfg,
      prompter,
    }),
  resolveConfigKeys: (cfg, accountId) =>
    (accountId ?? resolveDefaultZaloAccountId(cfg)) !== DEFAULT_ACCOUNT_ID
      ? {
          allowFromKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.allowFrom`,
          policyKey: `channels.zalo.accounts.${accountId ?? resolveDefaultZaloAccountId(cfg)}.dmPolicy`,
        }
      : {
          allowFromKey: "channels.zalo.allowFrom",
          policyKey: "channels.zalo.dmPolicy",
        },
  setPolicy: (cfg, policy, accountId) => {
    const resolvedAccountId =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultZaloAccountId(cfg);
    const resolved = resolveZaloAccount({
      cfg,
      accountId: resolvedAccountId,
    });
    if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: {
            ...cfg.channels?.zalo,
            dmPolicy: policy,
            enabled: true,
            ...(policy === "open"
              ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) }
              : {}),
          },
        },
      };
    }
    const currentAccount = cfg.channels?.zalo?.accounts?.[resolvedAccountId] as
      | ZaloAccountSetupConfig
      | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          accounts: {
            ...cfg.channels?.zalo?.accounts,
            [resolvedAccountId]: {
              ...currentAccount,
              enabled: currentAccount?.enabled ?? true,
              dmPolicy: policy,
              ...(policy === "open"
                ? { allowFrom: addWildcardAllowFrom(resolved.config.allowFrom) }
                : {}),
            },
          },
          enabled: true,
        },
      },
    };
  },
};

export function createZaloSetupWizardProxy(
  loadWizard: () => Promise<ChannelSetupWizard>,
): ChannelSetupWizard {
  return createDelegatedSetupWizardProxy({
    channel,
    credentials: [],
    delegateFinalize: true,
    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: false,
        },
      },
    }),
    dmPolicy: zaloDmPolicy,
    loadWizard,
    status: {
      configuredHint: "recommended · configured",
      configuredLabel: "configured",
      configuredScore: 1,
      unconfiguredHint: "recommended · newcomer-friendly",
      unconfiguredLabel: "needs token",
      unconfiguredScore: 10,
    },
  });
}
