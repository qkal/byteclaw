import {
  resolveBlueBubblesAccount,
  resolveBlueBubblesEffectiveAllowPrivateNetwork,
  resolveBlueBubblesPrivateNetworkConfigValue,
} from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";

export interface BlueBubblesAccountResolveOpts {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
}

export function resolveBlueBubblesServerAccount(params: BlueBubblesAccountResolveOpts): {
  baseUrl: string;
  password: string;
  accountId: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
} {
  const account = resolveBlueBubblesAccount({
    accountId: params.accountId,
    cfg: params.cfg ?? {},
  });
  const baseUrl =
    normalizeResolvedSecretInputString({
      path: "channels.bluebubbles.serverUrl",
      value: params.serverUrl,
    }) ||
    normalizeResolvedSecretInputString({
      path: `channels.bluebubbles.accounts.${account.accountId}.serverUrl`,
      value: account.config.serverUrl,
    });
  const password =
    normalizeResolvedSecretInputString({
      path: "channels.bluebubbles.password",
      value: params.password,
    }) ||
    normalizeResolvedSecretInputString({
      path: `channels.bluebubbles.accounts.${account.accountId}.password`,
      value: account.config.password,
    });
  if (!baseUrl) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  if (!password) {
    throw new Error("BlueBubbles password is required");
  }

  return {
    accountId: account.accountId,
    allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetwork({
      baseUrl,
      config: account.config,
    }),
    allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(account.config),
    baseUrl,
    password,
  };
}
