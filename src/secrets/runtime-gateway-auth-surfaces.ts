import type { OpenClawConfig } from "../config/config.js";
import { createGatewayCredentialPlan } from "../gateway/credential-planner.js";
import type { SecretDefaults } from "./runtime-shared.js";
import { isRecord } from "./shared.js";

export const GATEWAY_AUTH_SURFACE_PATHS = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
] as const;

export type GatewayAuthSurfacePath = (typeof GATEWAY_AUTH_SURFACE_PATHS)[number];

export interface GatewayAuthSurfaceState {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
}

export type GatewayAuthSurfaceStateMap = Record<GatewayAuthSurfacePath, GatewayAuthSurfaceState>;

function formatAuthMode(mode: string | undefined): string {
  return mode ?? "unset";
}

function describeRemoteConfiguredSurface(parts: {
  remoteMode: boolean;
  remoteUrlConfigured: boolean;
  tailscaleRemoteExposure: boolean;
}): string {
  const reasons: string[] = [];
  if (parts.remoteMode) {
    reasons.push('gateway.mode is "remote"');
  }
  if (parts.remoteUrlConfigured) {
    reasons.push("gateway.remote.url is configured");
  }
  if (parts.tailscaleRemoteExposure) {
    reasons.push('gateway.tailscale.mode is "serve" or "funnel"');
  }
  return reasons.join("; ");
}

function createState(params: {
  path: GatewayAuthSurfacePath;
  active: boolean;
  reason: string;
  hasSecretRef: boolean;
}): GatewayAuthSurfaceState {
  return {
    active: params.active,
    hasSecretRef: params.hasSecretRef,
    path: params.path,
    reason: params.reason,
  };
}

export function evaluateGatewayAuthSurfaceStates(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  defaults?: SecretDefaults;
}): GatewayAuthSurfaceStateMap {
  const gateway = params.config.gateway as Record<string, unknown> | undefined;
  if (!isRecord(gateway)) {
    return {
      "gateway.auth.password": createState({
        active: false,
        hasSecretRef: false,
        path: "gateway.auth.password",
        reason: "gateway configuration is not set.",
      }),
      "gateway.auth.token": createState({
        active: false,
        hasSecretRef: false,
        path: "gateway.auth.token",
        reason: "gateway configuration is not set.",
      }),
      "gateway.remote.password": createState({
        active: false,
        hasSecretRef: false,
        path: "gateway.remote.password",
        reason: "gateway configuration is not set.",
      }),
      "gateway.remote.token": createState({
        active: false,
        hasSecretRef: false,
        path: "gateway.remote.token",
        reason: "gateway configuration is not set.",
      }),
    };
  }
  const auth = isRecord(gateway?.auth) ? gateway.auth : undefined;
  const remote = isRecord(gateway?.remote) ? gateway.remote : undefined;
  const plan = createGatewayCredentialPlan({
    config: params.config,
    defaults: params.defaults,
    env: params.env,
  });

  const authPasswordReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (plan.passwordCanWin) {
      return plan.authMode === "password"
        ? 'gateway.auth.mode is "password".'
        : "no token source can win, so password auth can win.";
    }
    if (
      plan.authMode === "token" ||
      plan.authMode === "none" ||
      plan.authMode === "trusted-proxy"
    ) {
      return `gateway.auth.mode is "${plan.authMode}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.localToken.configured) {
      return "gateway.auth.token is configured.";
    }
    if (plan.remoteToken.configured) {
      return "gateway.remote.token is configured.";
    }
    return "token auth can win.";
  })();

  const authTokenReason = (() => {
    if (!auth) {
      return "gateway.auth is not configured.";
    }
    if (plan.authMode === "token") {
      return plan.envToken
        ? "gateway token env var is configured."
        : 'gateway.auth.mode is "token".';
    }
    if (
      plan.authMode === "password" ||
      plan.authMode === "none" ||
      plan.authMode === "trusted-proxy"
    ) {
      return `gateway.auth.mode is "${plan.authMode}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.envPassword) {
      return "gateway password env var is configured.";
    }
    if (plan.localPassword.configured) {
      return "gateway.auth.password is configured.";
    }
    return "token auth can win (mode is unset and no password source is configured).";
  })();

  const remoteSurfaceReason = describeRemoteConfiguredSurface({
    remoteMode: plan.remoteMode,
    remoteUrlConfigured: plan.remoteUrlConfigured,
    tailscaleRemoteExposure: plan.tailscaleRemoteExposure,
  });

  const remoteTokenReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (plan.remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (plan.remoteTokenFallbackActive) {
      return "local token auth can win and no env/auth token is configured.";
    }
    if (!plan.localTokenCanWin) {
      return `token auth cannot win with gateway.auth.mode="${formatAuthMode(plan.authMode)}".`;
    }
    if (plan.envToken) {
      return "gateway token env var is configured.";
    }
    if (plan.localToken.configured) {
      return "gateway.auth.token is configured.";
    }
    return "remote token fallback is not active.";
  })();

  const remotePasswordReason = (() => {
    if (!remote) {
      return "gateway.remote is not configured.";
    }
    if (plan.remoteConfiguredSurface) {
      return `remote surface is active: ${remoteSurfaceReason}.`;
    }
    if (plan.remotePasswordFallbackActive) {
      return "password auth can win and no env/auth password is configured.";
    }
    if (!plan.passwordCanWin) {
      if (
        plan.authMode === "token" ||
        plan.authMode === "none" ||
        plan.authMode === "trusted-proxy"
      ) {
        return `password auth cannot win with gateway.auth.mode="${plan.authMode}".`;
      }
      return "a token source can win, so password auth cannot win.";
    }
    if (plan.envPassword) {
      return "gateway password env var is configured.";
    }
    if (plan.localPassword.configured) {
      return "gateway.auth.password is configured.";
    }
    return "remote password fallback is not active.";
  })();

  return {
    "gateway.auth.password": createState({
      active: plan.passwordCanWin,
      hasSecretRef: plan.localPassword.hasSecretRef,
      path: "gateway.auth.password",
      reason: authPasswordReason,
    }),
    "gateway.auth.token": createState({
      active: plan.localTokenSurfaceActive,
      hasSecretRef: plan.localToken.hasSecretRef,
      path: "gateway.auth.token",
      reason: authTokenReason,
    }),
    "gateway.remote.password": createState({
      active: plan.remotePasswordActive,
      hasSecretRef: plan.remotePassword.hasSecretRef,
      path: "gateway.remote.password",
      reason: remotePasswordReason,
    }),
    "gateway.remote.token": createState({
      active: plan.remoteTokenActive,
      hasSecretRef: plan.remoteToken.hasSecretRef,
      path: "gateway.remote.token",
      reason: remoteTokenReason,
    }),
  };
}
