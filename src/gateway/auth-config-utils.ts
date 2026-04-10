import type { GatewayAuthConfig, OpenClawConfig } from "../config/config.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";
import {
  type SupportedGatewaySecretInputPath,
  assignResolvedGatewaySecretInput,
  readGatewaySecretInputValue,
} from "./secret-input-paths.js";

export type GatewayAuthSecretInputPath = Extract<
  SupportedGatewaySecretInputPath,
  "gateway.auth.token" | "gateway.auth.password"
>;

export interface GatewayAuthSecretRefResolutionParams {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}

export function hasConfiguredGatewayAuthSecretInput(
  cfg: OpenClawConfig,
  path: GatewayAuthSecretInputPath,
): boolean {
  return hasConfiguredSecretInput(readGatewaySecretInputValue(cfg, path), cfg.secrets?.defaults);
}

export function shouldResolveGatewayAuthSecretRef(params: {
  mode?: GatewayAuthConfig["mode"];
  path: GatewayAuthSecretInputPath;
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): boolean {
  const isTokenPath = params.path === "gateway.auth.token";
  const hasPathCandidate = isTokenPath ? params.hasTokenCandidate : params.hasPasswordCandidate;
  if (hasPathCandidate) {
    return false;
  }
  if (params.mode === (isTokenPath ? "token" : "password")) {
    return true;
  }
  if (params.mode === "token" || params.mode === "none" || params.mode === "trusted-proxy") {
    return false;
  }
  if (params.mode === "password") {
    return !isTokenPath;
  }
  return isTokenPath ? !params.hasPasswordCandidate : !params.hasTokenCandidate;
}

export function shouldResolveGatewayTokenSecretRef(
  params: Omit<GatewayAuthSecretRefResolutionParams, "cfg" | "env">,
): boolean {
  return shouldResolveGatewayAuthSecretRef({
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate: params.hasTokenCandidate,
    mode: params.mode,
    path: "gateway.auth.token",
  });
}

export function shouldResolveGatewayPasswordSecretRef(
  params: Omit<GatewayAuthSecretRefResolutionParams, "cfg" | "env">,
): boolean {
  return shouldResolveGatewayAuthSecretRef({
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate: params.hasTokenCandidate,
    mode: params.mode,
    path: "gateway.auth.password",
  });
}

export async function resolveGatewayAuthSecretRefValue(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  path: GatewayAuthSecretInputPath;
  shouldResolve: boolean;
}): Promise<string | undefined> {
  if (!params.shouldResolve) {
    return undefined;
  }
  const value = await resolveRequiredConfiguredSecretRefInputString({
    config: params.cfg,
    env: params.env,
    path: params.path,
    value: readGatewaySecretInputValue(params.cfg, params.path),
  });
  if (!value) {
    return undefined;
  }
  return value;
}

export async function resolveGatewayTokenSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.token",
    shouldResolve: shouldResolveGatewayTokenSecretRef(params),
  });
}

export async function resolveGatewayPasswordSecretRefValue(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<string | undefined> {
  return resolveGatewayAuthSecretRefValue({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.password",
    shouldResolve: shouldResolveGatewayPasswordSecretRef(params),
  });
}

export async function resolveGatewayAuthSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  path: GatewayAuthSecretInputPath;
  shouldResolve: boolean;
}): Promise<OpenClawConfig> {
  const value = await resolveGatewayAuthSecretRefValue(params);
  if (!value) {
    return params.cfg;
  }
  const nextConfig = structuredClone(params.cfg);
  nextConfig.gateway ??= {};
  nextConfig.gateway.auth ??= {};
  assignResolvedGatewaySecretInput({
    config: nextConfig,
    path: params.path,
    value,
  });
  return nextConfig;
}

export async function resolveGatewayPasswordSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): Promise<OpenClawConfig> {
  return resolveGatewayAuthSecretRef({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.password",
    shouldResolve: shouldResolveGatewayPasswordSecretRef(params),
  });
}

export async function materializeGatewayAuthSecretRefs(
  params: GatewayAuthSecretRefResolutionParams,
): Promise<OpenClawConfig> {
  const cfgWithToken = await resolveGatewayAuthSecretRef({
    cfg: params.cfg,
    env: params.env,
    path: "gateway.auth.token",
    shouldResolve: shouldResolveGatewayTokenSecretRef(params),
  });
  return await resolveGatewayPasswordSecretRef({
    cfg: cfgWithToken,
    env: params.env,
    hasPasswordCandidate: params.hasPasswordCandidate,
    hasTokenCandidate:
      params.hasTokenCandidate ||
      hasConfiguredGatewayAuthSecretInput(cfgWithToken, "gateway.auth.token"),
    mode: params.mode,
  });
}
