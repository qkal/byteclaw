import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup";
import { hasLineCredentials, parseLineAllowFromId } from "./account-helpers.js";
import {
  DEFAULT_ACCOUNT_ID,
  type LineConfig,
  listLineAccountIds,
  normalizeAccountId,
  resolveLineAccount,
} from "./setup-runtime-api.js";

export function patchLineAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const lineConfig = (params.cfg.channels?.line ?? {}) as LineConfig;
  const clearFields = params.clearFields ?? [];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextLine = { ...lineConfig } as Record<string, unknown>;
    for (const field of clearFields) {
      delete nextLine[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        line: {
          ...nextLine,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccount = {
    ...lineConfig.accounts?.[accountId],
  } as Record<string, unknown>;
  for (const field of clearFields) {
    delete nextAccount[field];
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      line: {
        ...lineConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...lineConfig.accounts,
          [accountId]: {
            ...nextAccount,
            ...(params.enabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineCredentials(resolveLineAccount({ accountId, cfg }));
}

export { parseLineAllowFromId };

export const lineSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      channelAccessToken?: string;
      channelSecret?: string;
      tokenFile?: string;
      secretFile?: string;
    };
    const normalizedAccountId = normalizeAccountId(accountId);
    if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
      return patchLineAccountConfig({
        accountId: normalizedAccountId,
        cfg,
        clearFields: typedInput.useEnv
          ? ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"]
          : undefined,
        enabled: true,
        patch: typedInput.useEnv
          ? {}
          : {
              ...(typedInput.tokenFile
                ? { tokenFile: typedInput.tokenFile }
                : typedInput.channelAccessToken
                  ? { channelAccessToken: typedInput.channelAccessToken }
                  : {}),
              ...(typedInput.secretFile
                ? { secretFile: typedInput.secretFile }
                : typedInput.channelSecret
                  ? { channelSecret: typedInput.channelSecret }
                  : {}),
            },
      });
    }
    return patchLineAccountConfig({
      accountId: normalizedAccountId,
      cfg,
      enabled: true,
      patch: {
        ...(typedInput.tokenFile
          ? { tokenFile: typedInput.tokenFile }
          : typedInput.channelAccessToken
            ? { channelAccessToken: typedInput.channelAccessToken }
            : {}),
        ...(typedInput.secretFile
          ? { secretFile: typedInput.secretFile }
          : typedInput.channelSecret
            ? { channelSecret: typedInput.channelSecret }
            : {}),
      },
    });
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    patchLineAccountConfig({
      accountId,
      cfg,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.",
    whenNotUseEnv: [
      {
        message: "LINE requires channelAccessToken or --token-file (or --use-env).",
        someOf: ["channelAccessToken", "tokenFile"],
      },
      {
        message: "LINE requires channelSecret or --secret-file (or --use-env).",
        someOf: ["channelSecret", "secretFile"],
      },
    ],
  }),
};

export { listLineAccountIds };
