import type { OpenClawConfig } from "../config/config.js";
import { containsEnvVarReference } from "../config/env-substitution.js";
import { hasConfiguredSecretInput, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type GatewayCredentialInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

export interface GatewayConfiguredCredentialInput {
  path: GatewayCredentialInputPath;
  configured: boolean;
  value?: string;
  refPath?: GatewayCredentialInputPath;
  hasSecretRef: boolean;
}

export interface GatewayCredentialPlan {
  configuredMode: "local" | "remote";
  authMode?: string;
  envToken?: string;
  envPassword?: string;
  localToken: GatewayConfiguredCredentialInput;
  localPassword: GatewayConfiguredCredentialInput;
  remoteToken: GatewayConfiguredCredentialInput;
  remotePassword: GatewayConfiguredCredentialInput;
  localTokenCanWin: boolean;
  localPasswordCanWin: boolean;
  localTokenSurfaceActive: boolean;
  tokenCanWin: boolean;
  passwordCanWin: boolean;
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
  remoteConfiguredSurface: boolean;
  remoteTokenFallbackActive: boolean;
  remoteTokenActive: boolean;
  remotePasswordFallbackActive: boolean;
  remotePasswordActive: boolean;
}

type GatewaySecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

export const trimToUndefined = normalizeOptionalString;

/**
 * Like trimToUndefined but also rejects unresolved env var placeholders (e.g. `${VAR}`).
 * This prevents literal placeholder strings like `${OPENCLAW_GATEWAY_TOKEN}` from being
 * accepted as valid credentials when the referenced env var is missing.
 * Note: legitimate credential values containing literal `${UPPER_CASE}` patterns will
 * also be rejected, but this is an extremely unlikely edge case.
 */
export function trimCredentialToUndefined(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (trimmed && containsEnvVarReference(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function hasGatewayTokenEnvCandidate(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN));
}

export function hasGatewayPasswordEnvCandidate(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD));
}

function resolveConfiguredGatewayCredentialInput(params: {
  value: unknown;
  defaults?: GatewaySecretDefaults;
  path: GatewayCredentialInputPath;
}): GatewayConfiguredCredentialInput {
  const { ref } = resolveSecretInputRef({
    defaults: params.defaults,
    value: params.value,
  });
  return {
    configured: hasConfiguredSecretInput(params.value, params.defaults),
    hasSecretRef: ref !== null,
    path: params.path,
    refPath: ref ? params.path : undefined,
    value: ref ? undefined : trimToUndefined(params.value),
  };
}

export function createGatewayCredentialPlan(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  defaults?: GatewaySecretDefaults;
}): GatewayCredentialPlan {
  const env = params.env ?? process.env;
  const { gateway } = params.config;
  const remote = gateway?.remote;
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const authMode = gateway?.auth?.mode;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  const localToken = resolveConfiguredGatewayCredentialInput({
    defaults,
    path: "gateway.auth.token",
    value: gateway?.auth?.token,
  });
  const localPassword = resolveConfiguredGatewayCredentialInput({
    defaults,
    path: "gateway.auth.password",
    value: gateway?.auth?.password,
  });
  const remoteToken = resolveConfiguredGatewayCredentialInput({
    defaults,
    path: "gateway.remote.token",
    value: remote?.token,
  });
  const remotePassword = resolveConfiguredGatewayCredentialInput({
    defaults,
    path: "gateway.remote.password",
    value: remote?.password,
  });

  const localTokenCanWin =
    authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy";
  const tokenCanWin = Boolean(envToken || localToken.configured || remoteToken.configured);
  const passwordCanWin =
    authMode === "password" ||
    (authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin);
  const localTokenSurfaceActive =
    localTokenCanWin &&
    !envToken &&
    (authMode === "token" ||
      (authMode === undefined && !(envPassword || localPassword.configured)));

  const remoteMode = gateway?.mode === "remote";
  const remoteUrlConfigured = Boolean(trimToUndefined(remote?.url));
  const tailscaleRemoteExposure =
    gateway?.tailscale?.mode === "serve" || gateway?.tailscale?.mode === "funnel";
  const remoteConfiguredSurface = remoteMode || remoteUrlConfigured || tailscaleRemoteExposure;
  const remoteTokenFallbackActive = localTokenCanWin && !envToken && !localToken.configured;
  const remotePasswordFallbackActive = !envPassword && !localPassword.configured && passwordCanWin;

  return {
    authMode,
    configuredMode: gateway?.mode === "remote" ? "remote" : "local",
    envPassword,
    envToken,
    localPassword,
    localPasswordCanWin: passwordCanWin,
    localToken,
    localTokenCanWin,
    localTokenSurfaceActive,
    passwordCanWin,
    remoteConfiguredSurface,
    remoteMode,
    remotePassword,
    remotePasswordActive: remoteConfiguredSurface || remotePasswordFallbackActive,
    remotePasswordFallbackActive,
    remoteToken,
    remoteTokenActive: remoteConfiguredSurface || remoteTokenFallbackActive,
    remoteTokenFallbackActive,
    remoteUrlConfigured,
    tailscaleRemoteExposure,
    tokenCanWin,
  };
}
