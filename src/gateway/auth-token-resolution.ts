import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { trimToUndefined } from "./credentials.js";
import {
  type SecretInputUnresolvedReasonStyle,
  resolveConfiguredSecretInputString,
} from "./resolve-configured-secret-input-string.js";

export type GatewayAuthTokenResolutionSource = "explicit" | "config" | "secretRef" | "env";
export type GatewayAuthTokenEnvFallback = "never" | "no-secret-ref" | "always";

export async function resolveGatewayAuthToken(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitToken?: string;
  envFallback?: GatewayAuthTokenEnvFallback;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
  token?: string;
  source?: GatewayAuthTokenResolutionSource;
  secretRefConfigured: boolean;
  unresolvedRefReason?: string;
}> {
  const explicitToken = trimToUndefined(params.explicitToken);
  if (explicitToken) {
    return {
      secretRefConfigured: false,
      source: "explicit",
      token: explicitToken,
    };
  }

  const tokenInput = params.cfg.gateway?.auth?.token;
  const tokenRef = resolveSecretInputRef({
    defaults: params.cfg.secrets?.defaults,
    value: tokenInput,
  }).ref;
  const envFallback = params.envFallback ?? "always";
  const envToken = trimToUndefined(params.env.OPENCLAW_GATEWAY_TOKEN);

  if (!tokenRef) {
    const configToken = trimToUndefined(tokenInput);
    if (configToken) {
      return {
        secretRefConfigured: false,
        source: "config",
        token: configToken,
      };
    }
    if (envFallback !== "never" && envToken) {
      return {
        secretRefConfigured: false,
        source: "env",
        token: envToken,
      };
    }
    return { secretRefConfigured: false };
  }

  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env,
    path: "gateway.auth.token",
    unresolvedReasonStyle: params.unresolvedReasonStyle,
    value: tokenInput,
  });
  if (resolved.value) {
    return {
      secretRefConfigured: true,
      source: "secretRef",
      token: resolved.value,
    };
  }
  if (envFallback === "always" && envToken) {
    return {
      secretRefConfigured: true,
      source: "env",
      token: envToken,
    };
  }
  return {
    secretRefConfigured: true,
    unresolvedRefReason: resolved.unresolvedRefReason,
  };
}
