import { resolveOAuthClientConfig } from "./oauth.credentials.js";
import { fetchWithTimeout } from "./oauth.http.js";
import { resolveGoogleOAuthIdentity, resolveGooglePersonalOAuthIdentity } from "./oauth.project.js";
import { isGeminiCliPersonalOAuth } from "./oauth.settings.js";
import { type GeminiCliOAuthCredentials, REDIRECT_URI, TOKEN_URL } from "./oauth.shared.js";

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<GeminiCliOAuthCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetchWithTimeout(TOKEN_URL, {
    body,
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "google-api-nodejs-client/9.15.1",
    },
    method: "POST",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error("No refresh token received. Please try again.");
  }

  const identity = isGeminiCliPersonalOAuth()
    ? await resolveGooglePersonalOAuthIdentity(data.access_token)
    : await resolveGoogleOAuthIdentity(data.access_token);
  const expiresAt = Date.now() + data.expires_in * 1000 - 5 * 60 * 1000;

  return {
    access: data.access_token,
    email: identity.email,
    expires: expiresAt,
    projectId: identity.projectId,
    refresh: data.refresh_token,
  };
}
