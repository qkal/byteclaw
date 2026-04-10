import { randomBytes, randomUUID } from "node:crypto";
import { generatePkceVerifierChallenge, toFormUrlEncoded } from "openclaw/plugin-sdk/provider-auth";
import { ensureGlobalUndiciEnvProxyDispatcher } from "openclaw/plugin-sdk/runtime-env";

export type MiniMaxRegion = "cn" | "global";

const MINIMAX_OAUTH_CONFIG = {
  cn: {
    baseUrl: "https://api.minimaxi.com",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
  global: {
    baseUrl: "https://api.minimax.io",
    clientId: "78257093-7e40-4613-99e0-527b14b39113",
  },
} as const;

const MINIMAX_OAUTH_SCOPE = "group_id profile model.completion";
const MINIMAX_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";

function getOAuthEndpoints(region: MiniMaxRegion) {
  const config = MINIMAX_OAUTH_CONFIG[region];
  return {
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    codeEndpoint: `${config.baseUrl}/oauth/code`,
    tokenEndpoint: `${config.baseUrl}/oauth/token`,
  };
}

export interface MiniMaxOAuthAuthorization {
  user_code: string;
  verification_uri: string;
  expired_in: number;
  interval?: number;
  state: string;
}

export interface MiniMaxOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
  notification_message?: string;
}

interface TokenPending { status: "pending"; message?: string }

type TokenResult =
  | { status: "success"; token: MiniMaxOAuthToken }
  | TokenPending
  | { status: "error"; message: string };

function generatePkce(): { verifier: string; challenge: string; state: string } {
  const { verifier, challenge } = generatePkceVerifierChallenge();
  const state = randomBytes(16).toString("base64url");
  return { challenge, state, verifier };
}

async function requestOAuthCode(params: {
  challenge: string;
  state: string;
  region: MiniMaxRegion;
}): Promise<MiniMaxOAuthAuthorization> {
  const endpoints = getOAuthEndpoints(params.region);
  const response = await fetch(endpoints.codeEndpoint, {
    body: toFormUrlEncoded({
      client_id: endpoints.clientId,
      code_challenge: params.challenge,
      code_challenge_method: "S256",
      response_type: "code",
      scope: MINIMAX_OAUTH_SCOPE,
      state: params.state,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "x-request-id": randomUUID(),
    },
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiniMax OAuth authorization failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as MiniMaxOAuthAuthorization & { error?: string };
  if (!payload.user_code || !payload.verification_uri) {
    throw new Error(
      payload.error ??
        "MiniMax OAuth authorization returned an incomplete payload (missing user_code or verification_uri).",
    );
  }
  if (payload.state !== params.state) {
    throw new Error("MiniMax OAuth state mismatch: possible CSRF attack or session corruption.");
  }
  return payload;
}

async function pollOAuthToken(params: {
  userCode: string;
  verifier: string;
  region: MiniMaxRegion;
}): Promise<TokenResult> {
  const endpoints = getOAuthEndpoints(params.region);
  const response = await fetch(endpoints.tokenEndpoint, {
    body: toFormUrlEncoded({
      client_id: endpoints.clientId,
      code_verifier: params.verifier,
      grant_type: MINIMAX_OAUTH_GRANT_TYPE,
      user_code: params.userCode,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  const text = await response.text();
  let payload:
    | {
        status?: string;
        base_resp?: { status_code?: number; status_msg?: string };
      }
    | undefined;
  if (text) {
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    return {
      message:
        (payload?.base_resp?.status_msg ?? text) || "MiniMax OAuth failed to parse response.",
      status: "error",
    };
  }

  if (!payload) {
    return { message: "MiniMax OAuth failed to parse response.", status: "error" };
  }

  const tokenPayload = payload as {
    status: string;
    access_token?: string | null;
    refresh_token?: string | null;
    expired_in?: number | null;
    token_type?: string;
    resource_url?: string;
    notification_message?: string;
  };

  if (tokenPayload.status === "error") {
    return { message: "An error occurred. Please try again later", status: "error" };
  }

  if (tokenPayload.status !== "success") {
    return { message: "current user code is not authorized", status: "pending" };
  }

  if (!tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.expired_in) {
    return { message: "MiniMax OAuth returned incomplete token payload.", status: "error" };
  }

  return {
    status: "success",
    token: {
      access: tokenPayload.access_token,
      expires: tokenPayload.expired_in,
      notification_message: tokenPayload.notification_message,
      refresh: tokenPayload.refresh_token,
      resourceUrl: tokenPayload.resource_url,
    },
  };
}

export async function loginMiniMaxPortalOAuth(params: {
  openUrl: (url: string) => Promise<void>;
  note: (message: string, title?: string) => Promise<void>;
  progress: { update: (message: string) => void; stop: (message?: string) => void };
  region?: MiniMaxRegion;
}): Promise<MiniMaxOAuthToken> {
  // Ensure env-based proxy dispatcher is active before any outbound fetch calls.
  // Without this, HTTP_PROXY/HTTPS_PROXY env vars are silently ignored (#51619).
  ensureGlobalUndiciEnvProxyDispatcher();
  const region = params.region ?? "global";
  const { verifier, challenge, state } = generatePkce();
  const oauth = await requestOAuthCode({ challenge, region, state });
  const verificationUrl = oauth.verification_uri;

  const noteLines = [
    `Open ${verificationUrl} to approve access.`,
    `If prompted, enter the code ${oauth.user_code}.`,
    `Interval: ${oauth.interval ?? "default (2000ms)"}, Expires at: ${oauth.expired_in} unix timestamp`,
  ];
  await params.note(noteLines.join("\n"), "MiniMax OAuth");

  try {
    await params.openUrl(verificationUrl);
  } catch {
    // Fall back to manual copy/paste if browser open fails.
  }

  let pollIntervalMs = oauth.interval ? oauth.interval : 2000;
  const expireTimeMs = oauth.expired_in;

  while (Date.now() < expireTimeMs) {
    params.progress.update("Waiting for MiniMax OAuth approval…");
    const result = await pollOAuthToken({
      region,
      userCode: oauth.user_code,
      verifier,
    });

    if (result.status === "success") {
      return result.token;
    }

    if (result.status === "error") {
      throw new Error(result.message);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    pollIntervalMs = Math.max(pollIntervalMs, 2000);
  }

  throw new Error("MiniMax OAuth timed out before authorization completed.");
}
