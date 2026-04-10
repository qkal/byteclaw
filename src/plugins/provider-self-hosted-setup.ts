import type { ApiKeyCredential, AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderDiscoveryContext,
  ProviderNonInteractiveApiKeyResult,
} from "./types.js";

export {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";

const log = createSubsystemLogger("plugins/self-hosted-provider-setup");

interface OpenAICompatModelsResponse {
  data?: {
    id?: string;
  }[];
}

function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

export async function discoverOpenAICompatibleLocalModels(params: {
  baseUrl: string;
  apiKey?: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelDefinitionConfig[]> {
  const env = params.env ?? process.env;
  if (env.VITEST || env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const trimmedApiKey = normalizeOptionalString(params.apiKey);
    const response = await fetch(url, {
      headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover ${params.label} models: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as OpenAICompatModelsResponse;
    const models = data.data ?? [];
    if (models.length === 0) {
      log.warn(`No ${params.label} models found on local instance`);
      return [];
    }

    return models
      .map((model) => ({ id: normalizeOptionalString(model.id) ?? "" }))
      .filter((model) => Boolean(model.id))
      .map((model) => {
        const modelId = model.id;
        return {
          contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
          cost: SELF_HOSTED_DEFAULT_COST,
          id: modelId,
          input: ["text"],
          maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
          name: modelId,
          reasoning: isReasoningModelHeuristic(modelId),
        } satisfies ModelDefinitionConfig;
      });
  } catch (error) {
    log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
    return [];
  }
}

export function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

function buildOpenAICompatibleSelfHostedProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  baseUrl: string;
  providerApiKey: string;
  modelId: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): { config: OpenClawConfig; modelId: string; modelRef: string; profileId: string } {
  const modelRef = `${params.providerId}/${params.modelId}`;
  const profileId = `${params.providerId}:default`;
  return {
    config: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        mode: params.cfg.models?.mode ?? "merge",
        providers: {
          ...params.cfg.models?.providers,
          [params.providerId]: {
            api: "openai-completions",
            apiKey: params.providerApiKey,
            baseUrl: params.baseUrl,
            models: [
              {
                contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
                cost: SELF_HOSTED_DEFAULT_COST,
                id: params.modelId,
                input: params.input ?? ["text"],
                maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
                name: params.modelId,
                reasoning: params.reasoning ?? false,
              },
            ],
          },
        },
      },
    },
    modelId: params.modelId,
    modelRef,
    profileId,
  };
}

interface OpenAICompatibleSelfHostedProviderSetupParams {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface OpenAICompatibleSelfHostedProviderPromptResult {
  config: OpenClawConfig;
  credential: AuthProfileCredential;
  modelId: string;
  modelRef: string;
  profileId: string;
}

function buildSelfHostedProviderAuthResult(
  result: OpenAICompatibleSelfHostedProviderPromptResult,
): ProviderAuthResult {
  return {
    configPatch: result.config,
    defaultModel: result.modelRef,
    profiles: [
      {
        credential: result.credential,
        profileId: result.profileId,
      },
    ],
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProvider(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<OpenAICompatibleSelfHostedProviderPromptResult> {
  const baseUrlRaw = await params.prompter.text({
    initialValue: params.defaultBaseUrl,
    message: `${params.providerLabel} base URL`,
    placeholder: params.defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: `${params.providerLabel} API key`,
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: `${params.providerLabel} model`,
    placeholder: params.modelPlaceholder,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = normalizeStringifiedOptionalString(apiKeyRaw) ?? "";
  const modelId = normalizeStringifiedOptionalString(modelIdRaw) ?? "";
  const credential: AuthProfileCredential = {
    key: apiKey,
    provider: params.providerId,
    type: "api_key",
  };
  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    baseUrl,
    cfg: params.cfg,
    contextWindow: params.contextWindow,
    input: params.input,
    maxTokens: params.maxTokens,
    modelId,
    providerApiKey: params.defaultApiKeyEnvVar,
    providerId: params.providerId,
    reasoning: params.reasoning,
  });

  return {
    config: configured.config,
    credential,
    modelId: configured.modelId,
    modelRef: configured.modelRef,
    profileId: configured.profileId,
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<ProviderAuthResult> {
  const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider(params);
  return buildSelfHostedProviderAuthResult(result);
}

export async function discoverOpenAICompatibleSelfHostedProvider<
  T extends Record<string, unknown>,
>(params: {
  ctx: ProviderDiscoveryContext;
  providerId: string;
  buildProvider: (params: { apiKey?: string }) => Promise<T>;
}): Promise<{ provider: T & { apiKey: string } } | null> {
  if (params.ctx.config.models?.providers?.[params.providerId]) {
    return null;
  }
  const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...(await params.buildProvider({ apiKey: discoveryApiKey })),
      apiKey,
    },
  };
}

function buildMissingNonInteractiveModelIdMessage(params: {
  authChoice: string;
  providerLabel: string;
  modelPlaceholder: string;
}): string {
  return [
    `Missing --custom-model-id for --auth-choice ${params.authChoice}.`,
    `Pass the ${params.providerLabel} model id to use, for example ${params.modelPlaceholder}.`,
  ].join("\n");
}

function buildSelfHostedProviderCredential(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  resolved: ProviderNonInteractiveApiKeyResult;
}): ApiKeyCredential | null {
  return params.ctx.toApiKeyCredential({
    provider: params.providerId,
    resolved: params.resolved,
  });
}

export async function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<OpenClawConfig | null> {
  const baseUrl = (
    normalizeOptionalSecretInput(params.ctx.opts.customBaseUrl) ?? params.defaultBaseUrl
  ).replace(/\/+$/, "");
  const modelId = normalizeOptionalSecretInput(params.ctx.opts.customModelId);
  if (!modelId) {
    params.ctx.runtime.error(
      buildMissingNonInteractiveModelIdMessage({
        authChoice: params.ctx.authChoice,
        modelPlaceholder: params.modelPlaceholder,
        providerLabel: params.providerLabel,
      }),
    );
    params.ctx.runtime.exit(1);
    return null;
  }

  const resolved = await params.ctx.resolveApiKey({
    envVar: params.defaultApiKeyEnvVar,
    envVarName: params.defaultApiKeyEnvVar,
    flagName: "--custom-api-key",
    flagValue: normalizeOptionalSecretInput(params.ctx.opts.customApiKey),
    provider: params.providerId,
  });
  if (!resolved) {
    return null;
  }

  const credential = buildSelfHostedProviderCredential({
    ctx: params.ctx,
    providerId: params.providerId,
    resolved,
  });
  if (!credential) {
    return null;
  }

  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    baseUrl,
    cfg: params.ctx.config,
    contextWindow: params.contextWindow,
    input: params.input,
    maxTokens: params.maxTokens,
    modelId,
    providerApiKey: params.defaultApiKeyEnvVar,
    providerId: params.providerId,
    reasoning: params.reasoning,
  });
  await upsertAuthProfileWithLock({
    agentDir: params.ctx.agentDir,
    credential,
    profileId: configured.profileId,
  });

  const withProfile = applyAuthProfileConfig(configured.config, {
    mode: "api_key",
    profileId: configured.profileId,
    provider: params.providerId,
  });
  params.ctx.runtime.log(`Default ${params.providerLabel} model: ${modelId}`);
  return applyProviderDefaultModel(withProfile, configured.modelRef);
}
