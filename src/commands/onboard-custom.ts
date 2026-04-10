import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { buildModelAliasIndex, modelKey } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { type SecretInput, isSecretRef } from "../config/types.secrets.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../plugins/provider-model-defaults.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { ensureApiKeyFromEnvOrPrompt } from "./auth-choice.apply-helpers.js";
import { applyPrimaryModel } from "./model-picker.js";
import { normalizeAlias } from "./models/shared.js";
import type { SecretInputMode } from "./onboard-types.js";

const DEFAULT_CONTEXT_WINDOW = CONTEXT_WINDOW_HARD_MIN_TOKENS;
const DEFAULT_MAX_TOKENS = 4096;
// Azure OpenAI uses the Responses API which supports larger defaults
const AZURE_DEFAULT_CONTEXT_WINDOW = 400_000;
const AZURE_DEFAULT_MAX_TOKENS = 16_384;
const VERIFY_TIMEOUT_MS = 30_000;

function normalizeContextWindowForCustomModel(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return parsed >= CONTEXT_WINDOW_HARD_MIN_TOKENS ? parsed : CONTEXT_WINDOW_HARD_MIN_TOKENS;
}

function isAzureFoundryUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname);
    return host.endsWith(".services.ai.azure.com");
  } catch {
    return false;
  }
}

function isAzureOpenAiUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname);
    return host.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function isAzureUrl(baseUrl: string): boolean {
  return isAzureFoundryUrl(baseUrl) || isAzureOpenAiUrl(baseUrl);
}

/**
 * Transforms an Azure AI Foundry/OpenAI URL to include the deployment path.
 * Azure requires: https://host/openai/deployments/<model-id>/chat/completions?api-version=2024-xx-xx-preview
 * But we can't add query params here, so we just add the path prefix.
 * The api-version will be handled by the Azure OpenAI client or as a query param.
 *
 * Example:
 *   https://my-resource.services.ai.azure.com + gpt-5.4-nano
 *   => https://my-resource.services.ai.azure.com/openai/deployments/gpt-5.4-nano
 */
function transformAzureUrl(baseUrl: string, modelId: string): string {
  const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  // Check if the URL already includes the deployment path
  if (normalizedUrl.includes("/openai/deployments/")) {
    return normalizedUrl;
  }
  return `${normalizedUrl}/openai/deployments/${modelId}`;
}

/**
 * Transforms an Azure URL into the base URL stored in config.
 *
 * Example:
 *   https://my-resource.openai.azure.com
 *   => https://my-resource.openai.azure.com/openai/v1
 */
function transformAzureConfigUrl(baseUrl: string): string {
  const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (normalizedUrl.endsWith("/openai/v1")) {
    return normalizedUrl;
  }
  // Strip a full deployment path back to the base origin
  const deploymentIdx = normalizedUrl.indexOf("/openai/deployments/");
  const base = deploymentIdx !== -1 ? normalizedUrl.slice(0, deploymentIdx) : normalizedUrl;
  return `${base}/openai/v1`;
}

function hasSameHost(a: string, b: string): boolean {
  try {
    return (
      normalizeLowercaseStringOrEmpty(new URL(a).hostname) ===
      normalizeLowercaseStringOrEmpty(new URL(b).hostname)
    );
  } catch {
    return false;
  }
}

export type CustomApiCompatibility = "openai" | "anthropic";
type CustomApiCompatibilityChoice = CustomApiCompatibility | "unknown";
export interface CustomApiResult {
  config: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  providerIdRenamedFrom?: string;
}

export interface ApplyCustomApiConfigParams {
  config: OpenClawConfig;
  baseUrl: string;
  modelId: string;
  compatibility: CustomApiCompatibility;
  apiKey?: SecretInput;
  providerId?: string;
  alias?: string;
}

export interface ParseNonInteractiveCustomApiFlagsParams {
  baseUrl?: string;
  modelId?: string;
  compatibility?: string;
  apiKey?: string;
  providerId?: string;
}

export interface ParsedNonInteractiveCustomApiFlags {
  baseUrl: string;
  modelId: string;
  compatibility: CustomApiCompatibility;
  apiKey?: string;
  providerId?: string;
}

export type CustomApiErrorCode =
  | "missing_required"
  | "invalid_compatibility"
  | "invalid_base_url"
  | "invalid_model_id"
  | "invalid_provider_id"
  | "invalid_alias";

export class CustomApiError extends Error {
  readonly code: CustomApiErrorCode;

  constructor(code: CustomApiErrorCode, message: string) {
    super(message);
    this.name = "CustomApiError";
    this.code = code;
  }
}

export interface ResolveCustomProviderIdParams {
  config: OpenClawConfig;
  baseUrl: string;
  providerId?: string;
}

export interface ResolvedCustomProviderId {
  providerId: string;
  providerIdRenamedFrom?: string;
}

const COMPATIBILITY_OPTIONS: {
  value: CustomApiCompatibilityChoice;
  label: string;
  hint: string;
}[] = [
  {
    hint: "Uses /chat/completions",
    label: "OpenAI-compatible",
    value: "openai",
  },
  {
    hint: "Uses /messages",
    label: "Anthropic-compatible",
    value: "anthropic",
  },
  {
    hint: "Probes OpenAI then Anthropic endpoints",
    label: "Unknown (detect automatically)",
    value: "unknown",
  },
];

function normalizeEndpointId(raw: string): string {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildEndpointIdFromUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const host = normalizeLowercaseStringOrEmpty(url.hostname.replace(/[^a-z0-9]+/gi, "-"));
    const port = url.port ? `-${url.port}` : "";
    const candidate = `custom-${host}${port}`;
    return normalizeEndpointId(candidate) || "custom";
  } catch {
    return "custom";
  }
}

function resolveUniqueEndpointId(params: {
  requestedId: string;
  baseUrl: string;
  providers: Record<string, ModelProviderConfig | undefined>;
}) {
  const normalized = normalizeEndpointId(params.requestedId) || "custom";
  const existing = params.providers[normalized];
  if (
    !existing?.baseUrl ||
    existing.baseUrl === params.baseUrl ||
    (isAzureUrl(params.baseUrl) && hasSameHost(existing.baseUrl, params.baseUrl))
  ) {
    return { providerId: normalized, renamed: false };
  }
  let suffix = 2;
  let candidate = `${normalized}-${suffix}`;
  while (params.providers[candidate]) {
    suffix += 1;
    candidate = `${normalized}-${suffix}`;
  }
  return { providerId: candidate, renamed: true };
}

function resolveAliasError(params: {
  raw: string;
  cfg: OpenClawConfig;
  modelRef: string;
}): string | undefined {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let normalized: string;
  try {
    normalized = normalizeAlias(trimmed);
  } catch (error) {
    return error instanceof Error ? error.message : "Alias is invalid.";
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const aliasKey = normalizeLowercaseStringOrEmpty(normalized);
  const existing = aliasIndex.byAlias.get(aliasKey);
  if (!existing) {
    return undefined;
  }
  const existingKey = modelKey(existing.ref.provider, existing.ref.model);
  if (existingKey === params.modelRef) {
    return undefined;
  }
  return `Alias ${normalized} already points to ${existingKey}.`;
}

function buildAzureOpenAiHeaders(apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

function buildOpenAiHeaders(apiKey: string) {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildAnthropicHeaders(apiKey: string) {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  return headers;
}

function formatVerificationError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

interface VerificationResult {
  ok: boolean;
  status?: number;
  error?: unknown;
}

function normalizeOptionalProviderApiKey(value: unknown): SecretInput | undefined {
  if (isSecretRef(value)) {
    return value;
  }
  return normalizeOptionalSecretInput(value);
}

function resolveVerificationEndpoint(params: {
  baseUrl: string;
  modelId: string;
  endpointPath: "chat/completions" | "messages";
}) {
  const resolvedUrl = isAzureUrl(params.baseUrl)
    ? transformAzureUrl(params.baseUrl, params.modelId)
    : params.baseUrl;
  const endpointUrl = new URL(
    params.endpointPath,
    resolvedUrl.endsWith("/") ? resolvedUrl : `${resolvedUrl}/`,
  );
  if (isAzureUrl(params.baseUrl)) {
    endpointUrl.searchParams.set("api-version", "2024-10-21");
  }
  return endpointUrl.href;
}

async function requestVerification(params: {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<VerificationResult> {
  try {
    const res = await fetchWithTimeout(
      params.endpoint,
      {
        body: JSON.stringify(params.body),
        headers: {
          "Content-Type": "application/json",
          ...params.headers,
        },
        method: "POST",
      },
      VERIFY_TIMEOUT_MS,
    );
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { error, ok: false };
  }
}

async function requestOpenAiVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  const isBaseUrlAzureUrl = isAzureUrl(params.baseUrl);
  const headers = isBaseUrlAzureUrl
    ? buildAzureOpenAiHeaders(params.apiKey)
    : buildOpenAiHeaders(params.apiKey);
  if (isAzureOpenAiUrl(params.baseUrl)) {
    const endpoint = new URL(
      "responses",
      transformAzureConfigUrl(params.baseUrl).replace(/\/?$/, "/"),
    ).href;
    return await requestVerification({
      body: {
        input: "Hi",
        max_output_tokens: 16,
        model: params.modelId,
        stream: false,
      },
      endpoint,
      headers,
    });
  } else {
    const endpoint = resolveVerificationEndpoint({
      baseUrl: params.baseUrl,
      endpointPath: "chat/completions",
      modelId: params.modelId,
    });
    return await requestVerification({
      body: {
        max_tokens: 1,
        messages: [{ content: "Hi", role: "user" }],
        model: params.modelId,
        stream: false,
      },
      endpoint,
      headers,
    });
  }
}

async function requestAnthropicVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  // Use a base URL with /v1 injected for this raw fetch only. The rest of the app uses the
  // Anthropic client, which appends /v1 itself; config should store the base URL
  // Without /v1 to avoid /v1/v1/messages at runtime. See docs/gateway/configuration-reference.md.
  const baseUrlForRequest = /\/v1\/?$/.test(params.baseUrl.trim())
    ? params.baseUrl.trim()
    : params.baseUrl.trim().replace(/\/?$/, "") + "/v1";
  const endpoint = resolveVerificationEndpoint({
    baseUrl: baseUrlForRequest,
    endpointPath: "messages",
    modelId: params.modelId,
  });
  return await requestVerification({
    body: {
      max_tokens: 1,
      messages: [{ content: "Hi", role: "user" }],
      model: params.modelId,
      stream: false,
    },
    endpoint,
    headers: buildAnthropicHeaders(params.apiKey),
  });
}

async function promptBaseUrlAndKey(params: {
  prompter: WizardPrompter;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
  initialBaseUrl?: string;
}): Promise<{ baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string }> {
  const baseUrlInput = await params.prompter.text({
    initialValue: params.initialBaseUrl ?? OLLAMA_DEFAULT_BASE_URL,
    message: "API Base URL",
    placeholder: "https://api.example.com/v1",
    validate: (val) => {
      try {
        new URL(val);
        return undefined;
      } catch {
        return "Please enter a valid URL (e.g. http://...)";
      }
    },
  });
  const baseUrl = baseUrlInput.trim();
  const providerHint = buildEndpointIdFromUrl(baseUrl) || "custom";
  let apiKeyInput: SecretInput | undefined;
  const resolvedApiKey = await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    envLabel: "CUSTOM_API_KEY",
    normalize: normalizeSecretInput,
    promptMessage: "API Key (leave blank if not required)",
    prompter: params.prompter,
    provider: providerHint,
    secretInputMode: params.secretInputMode,
    setCredential: async (apiKey) => {
      apiKeyInput = apiKey;
    },
    validate: () => undefined,
  });
  return {
    apiKey: normalizeOptionalProviderApiKey(apiKeyInput),
    baseUrl,
    resolvedApiKey: normalizeSecretInput(resolvedApiKey),
  };
}

type CustomApiRetryChoice = "baseUrl" | "model" | "both";

async function promptCustomApiRetryChoice(prompter: WizardPrompter): Promise<CustomApiRetryChoice> {
  return await prompter.select({
    message: "What would you like to change?",
    options: [
      { label: "Change base URL", value: "baseUrl" },
      { label: "Change model", value: "model" },
      { label: "Change base URL and model", value: "both" },
    ],
  });
}

async function promptCustomApiModelId(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: "Model ID",
      placeholder: "e.g. llama3, claude-3-7-sonnet",
      validate: (val) => (val.trim() ? undefined : "Model ID is required"),
    })
  ).trim();
}

async function applyCustomApiRetryChoice(params: {
  prompter: WizardPrompter;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
  retryChoice: CustomApiRetryChoice;
  current: { baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string; modelId: string };
}): Promise<{ baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string; modelId: string }> {
  let { baseUrl, apiKey, resolvedApiKey, modelId } = params.current;
  if (params.retryChoice === "baseUrl" || params.retryChoice === "both") {
    const retryInput = await promptBaseUrlAndKey({
      config: params.config,
      initialBaseUrl: baseUrl,
      prompter: params.prompter,
      secretInputMode: params.secretInputMode,
    });
    ({ baseUrl } = retryInput);
    ({ apiKey } = retryInput);
    ({ resolvedApiKey } = retryInput);
  }
  if (params.retryChoice === "model" || params.retryChoice === "both") {
    modelId = await promptCustomApiModelId(params.prompter);
  }
  return { apiKey, baseUrl, modelId, resolvedApiKey };
}

function resolveProviderApi(
  compatibility: CustomApiCompatibility,
): "openai-completions" | "anthropic-messages" {
  return compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";
}

function parseCustomApiCompatibility(raw?: string): CustomApiCompatibility {
  const compatibilityRaw = normalizeOptionalLowercaseString(raw);
  if (!compatibilityRaw) {
    return "openai";
  }
  if (compatibilityRaw !== "openai" && compatibilityRaw !== "anthropic") {
    throw new CustomApiError(
      "invalid_compatibility",
      'Invalid --custom-compatibility (use "openai" or "anthropic").',
    );
  }
  return compatibilityRaw;
}

export function resolveCustomProviderId(
  params: ResolveCustomProviderIdParams,
): ResolvedCustomProviderId {
  const providers = params.config.models?.providers ?? {};
  const baseUrl = params.baseUrl.trim();
  const explicitProviderId = params.providerId?.trim();
  if (explicitProviderId && !normalizeEndpointId(explicitProviderId)) {
    throw new CustomApiError(
      "invalid_provider_id",
      "Custom provider ID must include letters, numbers, or hyphens.",
    );
  }
  const requestedProviderId = explicitProviderId || buildEndpointIdFromUrl(baseUrl);
  const providerIdResult = resolveUniqueEndpointId({
    baseUrl,
    providers,
    requestedId: requestedProviderId,
  });

  return {
    providerId: providerIdResult.providerId,
    ...(providerIdResult.renamed
      ? {
          providerIdRenamedFrom: normalizeEndpointId(requestedProviderId) || "custom",
        }
      : {}),
  };
}

export function parseNonInteractiveCustomApiFlags(
  params: ParseNonInteractiveCustomApiFlagsParams,
): ParsedNonInteractiveCustomApiFlags {
  const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!baseUrl || !modelId) {
    throw new CustomApiError(
      "missing_required",
      [
        'Auth choice "custom-api-key" requires a base URL and model ID.',
        "Use --custom-base-url and --custom-model-id.",
      ].join("\n"),
    );
  }

  const apiKey = normalizeOptionalString(params.apiKey);
  const providerId = normalizeOptionalString(params.providerId);
  if (providerId && !normalizeEndpointId(providerId)) {
    throw new CustomApiError(
      "invalid_provider_id",
      "Custom provider ID must include letters, numbers, or hyphens.",
    );
  }
  return {
    baseUrl,
    compatibility: parseCustomApiCompatibility(params.compatibility),
    modelId,
    ...(apiKey ? { apiKey } : {}),
    ...(providerId ? { providerId } : {}),
  };
}

export function applyCustomApiConfig(params: ApplyCustomApiConfigParams): CustomApiResult {
  const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
  try {
    new URL(baseUrl);
  } catch {
    throw new CustomApiError("invalid_base_url", "Custom provider base URL must be a valid URL.");
  }

  if (params.compatibility !== "openai" && params.compatibility !== "anthropic") {
    throw new CustomApiError(
      "invalid_compatibility",
      'Custom provider compatibility must be "openai" or "anthropic".',
    );
  }

  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!modelId) {
    throw new CustomApiError("invalid_model_id", "Custom provider model ID is required.");
  }

  const isAzure = isAzureUrl(baseUrl);
  const isAzureOpenAi = isAzureOpenAiUrl(baseUrl);
  const resolvedBaseUrl = isAzure ? transformAzureConfigUrl(baseUrl) : baseUrl;

  const providerIdResult = resolveCustomProviderId({
    baseUrl: resolvedBaseUrl,
    config: params.config,
    providerId: params.providerId,
  });
  const {providerId} = providerIdResult;
  const providers = params.config.models?.providers ?? {};

  const modelRef = modelKey(providerId, modelId);
  const alias = normalizeOptionalString(params.alias) ?? "";
  const aliasError = resolveAliasError({
    cfg: params.config,
    modelRef,
    raw: alias,
  });
  if (aliasError) {
    throw new CustomApiError("invalid_alias", aliasError);
  }

  const existingProvider = providers[providerId];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasModel = existingModels.some((model) => model.id === modelId);
  const isLikelyReasoningModel = isAzure && /\b(o[134]|gpt-([5-9]|\d{2,}))\b/i.test(modelId);
  const nextModel = isAzure
    ? {
        compat: { supportsStore: false },
        contextWindow: AZURE_DEFAULT_CONTEXT_WINDOW,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: modelId,
        input: isLikelyReasoningModel
          ? (["text", "image"] as ("text" | "image")[])
          : (["text"] as ["text"]),
        maxTokens: AZURE_DEFAULT_MAX_TOKENS,
        name: `${modelId} (Custom Provider)`,
        reasoning: isLikelyReasoningModel,
      }
    : {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: modelId,
        input: ["text"] as ["text"],
        maxTokens: DEFAULT_MAX_TOKENS,
        name: `${modelId} (Custom Provider)`,
        reasoning: false,
      };
  const mergedModels = hasModel
    ? existingModels.map((model) =>
        model.id === modelId
          ? {
              ...model,
              ...(isAzure ? nextModel : {}),
              contextWindow: normalizeContextWindowForCustomModel(model.contextWindow),
              cost: model.cost ?? nextModel.cost,
              maxTokens: model.maxTokens ?? nextModel.maxTokens,
              name: model.name ?? nextModel.name,
            }
          : model,
      )
    : [...existingModels, nextModel];
  const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
  const normalizedApiKey =
    normalizeOptionalProviderApiKey(params.apiKey) ??
    normalizeOptionalProviderApiKey(existingApiKey);

  const providerApi = isAzureOpenAi
    ? ("azure-openai-responses" as const)
    : resolveProviderApi(params.compatibility);
  const azureHeaders = isAzure && normalizedApiKey ? { "api-key": normalizedApiKey } : undefined;

  let config: OpenClawConfig = {
    ...params.config,
    models: {
      ...params.config.models,
      mode: params.config.models?.mode ?? "merge",
      providers: {
        ...providers,
        [providerId]: {
          ...existingProviderRest,
          baseUrl: resolvedBaseUrl,
          api: providerApi,
          ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
          ...(isAzure ? { authHeader: false } : {}),
          ...(azureHeaders ? { headers: azureHeaders } : {}),
          models: mergedModels.length > 0 ? mergedModels : [nextModel],
        },
      },
    },
  };

  config = applyPrimaryModel(config, modelRef);
  if (isAzure && isLikelyReasoningModel) {
    const existingPerModelThinking = config.agents?.defaults?.models?.[modelRef]?.params?.thinking;
    if (!existingPerModelThinking) {
      config = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            models: {
              ...config.agents?.defaults?.models,
              [modelRef]: {
                ...config.agents?.defaults?.models?.[modelRef],
                params: {
                  ...config.agents?.defaults?.models?.[modelRef]?.params,
                  thinking: "medium",
                },
              },
            },
          },
        },
      };
    }
  }
  if (alias) {
    config = {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          models: {
            ...config.agents?.defaults?.models,
            [modelRef]: {
              ...config.agents?.defaults?.models?.[modelRef],
              alias,
            },
          },
        },
      },
    };
  }

  return {
    config,
    modelId,
    providerId,
    ...(providerIdResult.providerIdRenamedFrom
      ? { providerIdRenamedFrom: providerIdResult.providerIdRenamedFrom }
      : {}),
  };
}

export async function promptCustomApiConfig(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
}): Promise<CustomApiResult> {
  const { prompter, runtime, config } = params;

  const baseInput = await promptBaseUrlAndKey({
    config,
    prompter,
    secretInputMode: params.secretInputMode,
  });
  let {baseUrl} = baseInput;
  let {apiKey} = baseInput;
  let {resolvedApiKey} = baseInput;

  const compatibilityChoice = await prompter.select({
    message: "Endpoint compatibility",
    options: COMPATIBILITY_OPTIONS.map((option) => ({
      hint: option.hint,
      label: option.label,
      value: option.value,
    })),
  });

  let modelId = await promptCustomApiModelId(prompter);

  let compatibility: CustomApiCompatibility | null =
    compatibilityChoice === "unknown" ? null : compatibilityChoice;

  while (true) {
    let verifiedFromProbe = false;
    if (!compatibility) {
      const probeSpinner = prompter.progress("Detecting endpoint type...");
      const openaiProbe = await requestOpenAiVerification({
        apiKey: resolvedApiKey,
        baseUrl,
        modelId,
      });
      if (openaiProbe.ok) {
        probeSpinner.stop("Detected OpenAI-compatible endpoint.");
        compatibility = "openai";
        verifiedFromProbe = true;
      } else {
        const anthropicProbe = await requestAnthropicVerification({
          apiKey: resolvedApiKey,
          baseUrl,
          modelId,
        });
        if (anthropicProbe.ok) {
          probeSpinner.stop("Detected Anthropic-compatible endpoint.");
          compatibility = "anthropic";
          verifiedFromProbe = true;
        } else {
          probeSpinner.stop("Could not detect endpoint type.");
          await prompter.note(
            "This endpoint did not respond to OpenAI or Anthropic style requests.",
            "Endpoint detection",
          );
          const retryChoice = await promptCustomApiRetryChoice(prompter);
          ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
            config,
            current: { apiKey, baseUrl, modelId, resolvedApiKey },
            prompter,
            retryChoice,
            secretInputMode: params.secretInputMode,
          }));
          continue;
        }
      }
    }

    if (verifiedFromProbe) {
      break;
    }

    const verifySpinner = prompter.progress("Verifying...");
    const result =
      compatibility === "anthropic"
        ? await requestAnthropicVerification({ apiKey: resolvedApiKey, baseUrl, modelId })
        : await requestOpenAiVerification({ apiKey: resolvedApiKey, baseUrl, modelId });
    if (result.ok) {
      verifySpinner.stop("Verification successful.");
      break;
    }
    if (result.status !== undefined) {
      verifySpinner.stop(`Verification failed: status ${result.status}`);
    } else {
      verifySpinner.stop(`Verification failed: ${formatVerificationError(result.error)}`);
    }
    const retryChoice = await promptCustomApiRetryChoice(prompter);
    ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
      config,
      current: { apiKey, baseUrl, modelId, resolvedApiKey },
      prompter,
      retryChoice,
      secretInputMode: params.secretInputMode,
    }));
    if (compatibilityChoice === "unknown") {
      compatibility = null;
    }
  }

  const providers = config.models?.providers ?? {};
  const suggestedId = buildEndpointIdFromUrl(baseUrl);
  const providerIdInput = await prompter.text({
    initialValue: suggestedId,
    message: "Endpoint ID",
    placeholder: "custom",
    validate: (value) => {
      const normalized = normalizeEndpointId(value);
      if (!normalized) {
        return "Endpoint ID is required.";
      }
      return undefined;
    },
  });
  const aliasInput = await prompter.text({
    initialValue: "",
    message: "Model alias (optional)",
    placeholder: "e.g. local, ollama",
    validate: (value) => {
      const requestedId = normalizeEndpointId(providerIdInput) || "custom";
      const providerIdResult = resolveUniqueEndpointId({
        baseUrl,
        providers,
        requestedId,
      });
      const modelRef = modelKey(providerIdResult.providerId, modelId);
      return resolveAliasError({ cfg: config, modelRef, raw: value });
    },
  });
  const resolvedCompatibility = compatibility ?? "openai";
  const result = applyCustomApiConfig({
    alias: aliasInput,
    apiKey,
    baseUrl,
    compatibility: resolvedCompatibility,
    config,
    modelId,
    providerId: providerIdInput,
  });

  if (result.providerIdRenamedFrom && result.providerId) {
    await prompter.note(
      `Endpoint ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
      "Endpoint ID",
    );
  }

  runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
  return result;
}
