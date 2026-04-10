import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import {
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
} from "../../auth.js";

interface HandshakeConnectAuth {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
}

export type DeviceTokenCandidateSource = "explicit-device-token" | "shared-token-fallback";

export interface ConnectAuthState {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  sharedAuthOk: boolean;
  sharedAuthProvided: boolean;
  bootstrapTokenCandidate?: string;
  deviceTokenCandidate?: string;
  deviceTokenCandidateSource?: DeviceTokenCandidateSource;
}

interface VerifyDeviceTokenResult {
  ok: boolean;
}
interface VerifyBootstrapTokenResult {
  ok: boolean;
  reason?: string;
}

export interface ConnectAuthDecision {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
}

function resolveSharedConnectAuth(
  connectAuth: HandshakeConnectAuth | null | undefined,
): { token?: string; password?: string } | undefined {
  const token = normalizeOptionalString(connectAuth?.token);
  const password = normalizeOptionalString(connectAuth?.password);
  if (!token && !password) {
    return undefined;
  }
  return { password, token };
}

function resolveDeviceTokenCandidate(connectAuth: HandshakeConnectAuth | null | undefined): {
  token?: string;
  source?: DeviceTokenCandidateSource;
} {
  const explicitDeviceToken = normalizeOptionalString(connectAuth?.deviceToken);
  if (explicitDeviceToken) {
    return { source: "explicit-device-token", token: explicitDeviceToken };
  }
  const fallbackToken = normalizeOptionalString(connectAuth?.token);
  if (!fallbackToken) {
    return {};
  }
  return { source: "shared-token-fallback", token: fallbackToken };
}

export async function resolveConnectAuthState(params: {
  resolvedAuth: ResolvedGatewayAuth;
  connectAuth: HandshakeConnectAuth | null | undefined;
  hasDeviceIdentity: boolean;
  req: IncomingMessage;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}): Promise<ConnectAuthState> {
  const sharedConnectAuth = resolveSharedConnectAuth(params.connectAuth);
  const sharedAuthProvided = Boolean(sharedConnectAuth);
  const bootstrapTokenCandidate = params.hasDeviceIdentity
    ? normalizeOptionalString(params.connectAuth?.bootstrapToken)
    : undefined;
  const { token: deviceTokenCandidate, source: deviceTokenCandidateSource } =
    params.hasDeviceIdentity ? resolveDeviceTokenCandidate(params.connectAuth) : {};

  const authResult: GatewayAuthResult = await authorizeWsControlUiGatewayConnect({
    allowRealIpFallback: params.allowRealIpFallback,
    auth: params.resolvedAuth,
    clientIp: params.clientIp,
    connectAuth: sharedConnectAuth,
    rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    rateLimiter: sharedAuthProvided ? params.rateLimiter : undefined,
    req: params.req,
    trustedProxies: params.trustedProxies,
  });

  const sharedAuthResult =
    sharedConnectAuth &&
    (await authorizeHttpGatewayConnect({
      auth: { ...params.resolvedAuth, allowTailscale: false },
      connectAuth: sharedConnectAuth,
      req: params.req,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      // Shared-auth probe only; rate-limit side effects are handled in the
      // Primary auth flow (or deferred for device-token candidates).
      rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    }));
  // Trusted-proxy auth is semantically shared: the proxy vouches for identity,
  // No per-device credential needed. Include it so operator connections
  // Can skip device identity via roleCanSkipDeviceIdentity().
  const sharedAuthOk =
    (sharedAuthResult?.ok === true &&
      (sharedAuthResult.method === "token" || sharedAuthResult.method === "password")) ||
    (authResult.ok && authResult.method === "trusted-proxy");

  return {
    authMethod:
      authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
    authOk: authResult.ok,
    authResult,
    bootstrapTokenCandidate,
    deviceTokenCandidate,
    deviceTokenCandidateSource,
    sharedAuthOk,
    sharedAuthProvided,
  };
}

export async function resolveConnectAuthDecision(params: {
  state: ConnectAuthState;
  hasDeviceIdentity: boolean;
  deviceId?: string;
  publicKey?: string;
  role: string;
  scopes: string[];
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  verifyBootstrapToken: (params: {
    deviceId: string;
    publicKey: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<VerifyBootstrapTokenResult>;
  verifyDeviceToken: (params: {
    deviceId: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<VerifyDeviceTokenResult>;
}): Promise<ConnectAuthDecision> {
  let { authResult } = params.state;
  let { authOk } = params.state;
  let { authMethod } = params.state;

  const { bootstrapTokenCandidate } = params.state;
  if (params.hasDeviceIdentity && params.deviceId && params.publicKey && bootstrapTokenCandidate) {
    const tokenCheck = await params.verifyBootstrapToken({
      deviceId: params.deviceId,
      publicKey: params.publicKey,
      role: params.role,
      scopes: params.scopes,
      token: bootstrapTokenCandidate,
    });
    if (tokenCheck.ok) {
      // Prefer an explicit valid bootstrap token even when another auth path
      // (for example tailscale serve header auth) already succeeded. QR pairing
      // Relies on the server classifying the handshake as bootstrap-token so the
      // Initial node pairing can be silently auto-approved and the bootstrap
      // Token can be revoked after approval.
      authOk = true;
      authMethod = "bootstrap-token";
    } else if (!authOk) {
      authResult = { ok: false, reason: tokenCheck.reason ?? "bootstrap_token_invalid" };
    }
  }

  const { deviceTokenCandidate } = params.state;
  if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) {
    return { authMethod, authOk, authResult };
  }

  let deviceTokenRateLimited = false;
  if (params.rateLimiter) {
    const deviceRateCheck = params.rateLimiter.check(
      params.clientIp,
      AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
    );
    if (!deviceRateCheck.allowed) {
      deviceTokenRateLimited = true;
      authResult = {
        ok: false,
        rateLimited: true,
        reason: "rate_limited",
        retryAfterMs: deviceRateCheck.retryAfterMs,
      };
    }
  }
  if (!deviceTokenRateLimited) {
    const tokenCheck = await params.verifyDeviceToken({
      deviceId: params.deviceId,
      role: params.role,
      scopes: params.scopes,
      token: deviceTokenCandidate,
    });
    if (tokenCheck.ok) {
      authOk = true;
      authMethod = "device-token";
      params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
      if (params.state.sharedAuthProvided) {
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
      }
    } else {
      authResult = {
        ok: false,
        reason:
          params.state.deviceTokenCandidateSource === "explicit-device-token"
            ? "device_token_mismatch"
            : (authResult.reason ?? "device_token_mismatch"),
      };
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    }
  }

  return { authMethod, authOk, authResult };
}
