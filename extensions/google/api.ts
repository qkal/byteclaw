import {
  type ProviderRequestTransportOverrides,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  type OpenClawConfig,
  applyAgentDefaultModelPrimary,
} from "openclaw/plugin-sdk/provider-onboard";
import { parseGoogleOauthApiKey } from "./oauth-token-shared.js";
import { DEFAULT_GOOGLE_API_BASE_URL, normalizeGoogleApiBaseUrl } from "./provider-policy.js";
export { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
export {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleGenerativeAiApi,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "./provider-policy.js";

export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  const parsed = apiKey.startsWith("{") ? parseGoogleOauthApiKey(apiKey) : null;
  if (parsed?.token) {
    return {
      headers: {
        Authorization: `Bearer ${parsed.token}`,
        "Content-Type": "application/json",
      },
    };
  }

  return {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
  };
}

export function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ProviderRequestTransportOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}) {
  return resolveProviderHttpRequestConfig({
    allowPrivateNetwork: Boolean(params.baseUrl?.trim()),
    api: "google-generative-ai",
    baseUrl: normalizeGoogleApiBaseUrl(params.baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL),
    capability: params.capability,
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    defaultHeaders: parseGeminiAuth(params.apiKey).headers,
    headers: params.headers,
    provider: "google",
    request: params.request,
    transport: params.transport,
  });
}

export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";

export function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;
  if (currentPrimary === GOOGLE_GEMINI_DEFAULT_MODEL) {
    return { changed: false, next: cfg };
  }
  return {
    changed: true,
    next: applyAgentDefaultModelPrimary(cfg, GOOGLE_GEMINI_DEFAULT_MODEL),
  };
}
