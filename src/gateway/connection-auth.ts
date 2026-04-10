import type { OpenClawConfig } from "../config/config.js";
import type { ExplicitGatewayAuth } from "./call.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./call.js";
import type {
  GatewayCredentialMode,
  GatewayCredentialPrecedence,
  GatewayRemoteCredentialFallback,
  GatewayRemoteCredentialPrecedence,
} from "./credentials.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";

export interface GatewayConnectionAuthOptions {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}

function toGatewayCredentialOptions(
  params: Omit<GatewayConnectionAuthOptions, "config"> & { cfg: OpenClawConfig },
) {
  return {
    cfg: params.cfg,
    env: params.env,
    explicitAuth: params.explicitAuth,
    localPasswordPrecedence: params.localPasswordPrecedence,
    localTokenPrecedence: params.localTokenPrecedence,
    modeOverride: params.modeOverride,
    remotePasswordFallback: params.remotePasswordFallback,
    remotePasswordPrecedence: params.remotePasswordPrecedence,
    remoteTokenFallback: params.remoteTokenFallback,
    remoteTokenPrecedence: params.remoteTokenPrecedence,
    urlOverride: params.urlOverride,
    urlOverrideSource: params.urlOverrideSource,
  };
}

export async function resolveGatewayConnectionAuth(
  params: GatewayConnectionAuthOptions,
): Promise<{ token?: string; password?: string }> {
  return await resolveGatewayCredentialsWithSecretInputs({
    config: params.config,
    ...toGatewayCredentialOptions({ ...params, cfg: params.config }),
  });
}

export function resolveGatewayConnectionAuthFromConfig(
  params: Omit<GatewayConnectionAuthOptions, "config"> & { cfg: OpenClawConfig },
): { token?: string; password?: string } {
  return resolveGatewayCredentialsFromConfig(toGatewayCredentialOptions(params));
}
