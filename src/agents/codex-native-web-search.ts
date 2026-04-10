import type { OpenClawConfig } from "../config/config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

export type CodexNativeSearchMode = "cached" | "live";
export type CodexNativeSearchContextSize = "low" | "medium" | "high";

export interface CodexNativeSearchUserLocation {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

export interface ResolvedCodexNativeWebSearchConfig {
  enabled: boolean;
  mode: CodexNativeSearchMode;
  allowedDomains?: string[];
  contextSize?: CodexNativeSearchContextSize;
  userLocation?: CodexNativeSearchUserLocation;
}

export interface CodexNativeSearchActivation {
  globalWebSearchEnabled: boolean;
  codexNativeEnabled: boolean;
  codexMode: CodexNativeSearchMode;
  nativeEligible: boolean;
  hasRequiredAuth: boolean;
  state: "managed_only" | "native_active";
  inactiveReason?:
    | "globally_disabled"
    | "codex_not_enabled"
    | "model_not_eligible"
    | "codex_auth_missing";
}

export interface CodexNativeSearchPayloadPatchResult {
  status: "payload_not_object" | "native_tool_already_present" | "injected";
}

function normalizeAllowedDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped = [
    ...new Set(
      value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => typeof entry === "string"),
    ),
  ];
  return deduped.length > 0 ? deduped : undefined;
}

function normalizeContextSize(value: unknown): CodexNativeSearchContextSize | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function normalizeMode(value: unknown): CodexNativeSearchMode {
  return value === "live" ? "live" : "cached";
}

function normalizeUserLocation(value: unknown): CodexNativeSearchUserLocation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const location = {
    city: normalizeOptionalString(value.city),
    country: normalizeOptionalString(value.country),
    region: normalizeOptionalString(value.region),
    timezone: normalizeOptionalString(value.timezone),
  };
  return location.country || location.region || location.city || location.timezone
    ? location
    : undefined;
}

export function resolveCodexNativeWebSearchConfig(
  config: OpenClawConfig | undefined,
): ResolvedCodexNativeWebSearchConfig {
  const nativeConfig = config?.tools?.web?.search?.openaiCodex;
  return {
    allowedDomains: normalizeAllowedDomains(nativeConfig?.allowedDomains),
    contextSize: normalizeContextSize(nativeConfig?.contextSize),
    enabled: nativeConfig?.enabled === true,
    mode: normalizeMode(nativeConfig?.mode),
    userLocation: normalizeUserLocation(nativeConfig?.userLocation),
  };
}

export function isCodexNativeSearchEligibleModel(params: {
  modelProvider?: string;
  modelApi?: string;
}): boolean {
  return params.modelProvider === "openai-codex" || params.modelApi === "openai-codex-responses";
}

export function hasCodexNativeWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some(
    (tool) => isRecord(tool) && typeof tool.type === "string" && tool.type === "web_search",
  );
}

export function hasAvailableCodexAuth(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (params.agentDir) {
    try {
      if (
        listProfilesForProvider(ensureAuthProfileStore(params.agentDir), "openai-codex").length > 0
      ) {
        return true;
      }
    } catch {
      // Fall back to config-based detection below.
    }
  }

  return Object.values(params.config?.auth?.profiles ?? {}).some(
    (profile) => isRecord(profile) && profile.provider === "openai-codex",
  );
}

export function resolveCodexNativeSearchActivation(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): CodexNativeSearchActivation {
  const globalWebSearchEnabled = params.config?.tools?.web?.search?.enabled !== false;
  const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
  const nativeEligible = isCodexNativeSearchEligibleModel(params);
  const hasRequiredAuth = params.modelProvider !== "openai-codex" || hasAvailableCodexAuth(params);

  if (!globalWebSearchEnabled) {
    return {
      codexMode: codexConfig.mode,
      codexNativeEnabled: codexConfig.enabled,
      globalWebSearchEnabled,
      hasRequiredAuth,
      inactiveReason: "globally_disabled",
      nativeEligible,
      state: "managed_only",
    };
  }

  if (!codexConfig.enabled) {
    return {
      codexMode: codexConfig.mode,
      codexNativeEnabled: false,
      globalWebSearchEnabled,
      hasRequiredAuth,
      inactiveReason: "codex_not_enabled",
      nativeEligible,
      state: "managed_only",
    };
  }

  if (!nativeEligible) {
    return {
      codexMode: codexConfig.mode,
      codexNativeEnabled: true,
      globalWebSearchEnabled,
      hasRequiredAuth,
      inactiveReason: "model_not_eligible",
      nativeEligible: false,
      state: "managed_only",
    };
  }

  if (!hasRequiredAuth) {
    return {
      codexMode: codexConfig.mode,
      codexNativeEnabled: true,
      globalWebSearchEnabled,
      hasRequiredAuth: false,
      inactiveReason: "codex_auth_missing",
      nativeEligible: true,
      state: "managed_only",
    };
  }

  return {
    codexMode: codexConfig.mode,
    codexNativeEnabled: true,
    globalWebSearchEnabled,
    hasRequiredAuth: true,
    nativeEligible: true,
    state: "native_active",
  };
}

export function buildCodexNativeWebSearchTool(
  config: OpenClawConfig | undefined,
): Record<string, unknown> {
  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  const tool: Record<string, unknown> = {
    external_web_access: nativeConfig.mode === "live",
    type: "web_search",
  };

  if (nativeConfig.allowedDomains) {
    tool.filters = {
      allowed_domains: nativeConfig.allowedDomains,
    };
  }

  if (nativeConfig.contextSize) {
    tool.search_context_size = nativeConfig.contextSize;
  }

  if (nativeConfig.userLocation) {
    tool.user_location = {
      type: "approximate",
      ...nativeConfig.userLocation,
    };
  }

  return tool;
}

export function patchCodexNativeWebSearchPayload(params: {
  payload: unknown;
  config?: OpenClawConfig;
}): CodexNativeSearchPayloadPatchResult {
  if (!isRecord(params.payload)) {
    return { status: "payload_not_object" };
  }

  const {payload} = params;
  if (hasCodexNativeWebSearchTool(payload.tools)) {
    return { status: "native_tool_already_present" };
  }

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  tools.push(buildCodexNativeWebSearchTool(params.config));
  payload.tools = tools;
  return { status: "injected" };
}

export function shouldSuppressManagedWebSearchTool(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): boolean {
  return resolveCodexNativeSearchActivation(params).state === "native_active";
}

export function isCodexNativeWebSearchRelevant(params: {
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): boolean {
  if (resolveCodexNativeWebSearchConfig(params.config).enabled) {
    return true;
  }
  if (hasAvailableCodexAuth(params)) {
    return true;
  }

  const defaultModel = resolveDefaultModelForAgent({
    agentId: params.agentId,
    cfg: params.config,
  });
  const configuredProvider = params.config.models?.providers?.[defaultModel.provider];
  const configuredModelApi = configuredProvider?.models?.find(
    (candidate) => candidate.id === defaultModel.model,
  )?.api;
  return isCodexNativeSearchEligibleModel({
    modelApi: configuredModelApi ?? configuredProvider?.api,
    modelProvider: defaultModel.provider,
  });
}

export function describeCodexNativeWebSearch(
  config: OpenClawConfig | undefined,
): string | undefined {
  if (config?.tools?.web?.search?.enabled === false) {
    return undefined;
  }

  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  if (!nativeConfig.enabled) {
    return undefined;
  }
  return `Codex native search: ${nativeConfig.mode} for Codex-capable models`;
}
