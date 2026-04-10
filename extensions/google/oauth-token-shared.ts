import { readStringValue } from "openclaw/plugin-sdk/text-runtime";

interface GoogleOauthApiKeyCredential {
  type?: string;
  access?: string;
  projectId?: string;
}

export function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
} | null {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
    return {
      projectId: readStringValue(parsed.projectId),
      token: readStringValue(parsed.token),
    };
  } catch {
    return null;
  }
}

export function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    projectId: cred.projectId,
    token: cred.access,
  });
}

export function parseGoogleUsageToken(apiKey: string): string {
  const parsed = parseGoogleOauthApiKey(apiKey);
  if (parsed?.token) {
    return parsed.token;
  }

  // Keep the raw token when the stored credential is not a project-aware JSON payload.
  return apiKey;
}
