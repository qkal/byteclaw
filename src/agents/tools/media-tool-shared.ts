import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import { getDefaultLocalRoots } from "../../media/web-media.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeProviderId } from "../provider-id.js";
import { ToolInputError, readStringArrayParam, readStringParam } from "./common.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import {
  type ToolModelConfig,
  buildToolModelConfigFromCandidates,
  coerceToolModelConfig,
  hasAuthForProvider,
  hasToolModelConfig,
  resolveDefaultModelRef,
} from "./model-config.helpers.js";
import { getApiKeyForModel, normalizeWorkspaceDir, requireApiKey } from "./tool-runtime.helpers.js";

interface TextToolAttempt {
  provider: string;
  model: string;
  error: string;
}

interface TextToolResult {
  text: string;
  provider: string;
  model: string;
  attempts: TextToolAttempt[];
}

interface GenerationModelRef {
  provider: string;
  model: string;
}

type ParseGenerationModelRef = (raw: string | undefined) => GenerationModelRef | null;

interface MediaReferenceDetailEntry {
  rewrittenFrom?: string;
}

interface TaskRunDetailHandle {
  taskId: string;
  runId: string;
}

export function applyImageModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  imageModelConfig: ImageModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "imageModel", imageModelConfig);
}

export function applyImageGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  imageGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "imageGenerationModel", imageGenerationModelConfig);
}

export function applyVideoGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  videoGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "videoGenerationModel", videoGenerationModelConfig);
}

export function applyMusicGenerationModelConfigDefaults(
  cfg: OpenClawConfig | undefined,
  musicGenerationModelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  return applyAgentDefaultModelConfig(cfg, "musicGenerationModel", musicGenerationModelConfig);
}

function applyAgentDefaultModelConfig(
  cfg: OpenClawConfig | undefined,
  key: "imageModel" | "imageGenerationModel" | "videoGenerationModel" | "musicGenerationModel",
  modelConfig: ToolModelConfig,
): OpenClawConfig | undefined {
  if (!cfg) {
    return undefined;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        [key]: modelConfig,
      },
    },
  };
}

interface CapabilityProvider {
  id: string;
  aliases?: string[];
  defaultModel?: string;
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
}

export function findCapabilityProviderById<T extends CapabilityProvider>(params: {
  providers: T[];
  providerId?: string;
}): T | undefined {
  const selectedProvider = normalizeProviderId(params.providerId ?? "");
  return params.providers.find(
    (provider) =>
      normalizeProviderId(provider.id) === selectedProvider ||
      (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === selectedProvider),
  );
}

export function isCapabilityProviderConfigured<T extends CapabilityProvider>(params: {
  providers: T[];
  provider?: T;
  providerId?: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  const provider =
    params.provider ??
    findCapabilityProviderById({
      providerId: params.providerId,
      providers: params.providers,
    });
  if (!provider) {
    return params.providerId
      ? hasAuthForProvider({ agentDir: params.agentDir, provider: params.providerId })
      : false;
  }
  if (provider.isConfigured) {
    return provider.isConfigured({
      agentDir: params.agentDir,
      cfg: params.cfg,
    });
  }
  return hasAuthForProvider({ agentDir: params.agentDir, provider: provider.id });
}

export function resolveSelectedCapabilityProvider<T extends CapabilityProvider>(params: {
  providers: T[];
  modelConfig: ToolModelConfig;
  modelOverride?: string;
  parseModelRef: ParseGenerationModelRef;
}): T | undefined {
  const selectedRef =
    params.parseModelRef(params.modelOverride) ?? params.parseModelRef(params.modelConfig.primary);
  if (!selectedRef) {
    return undefined;
  }
  return findCapabilityProviderById({
    providerId: selectedRef.provider,
    providers: params.providers,
  });
}

export function resolveCapabilityModelCandidatesForTool<T extends CapabilityProvider>(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  providers: T[];
}): string[] {
  const providerDefaults = new Map<string, string>();
  for (const provider of params.providers) {
    const providerId = provider.id.trim();
    const modelId = provider.defaultModel?.trim();
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !isCapabilityProviderConfigured({
        agentDir: params.agentDir,
        cfg: params.cfg,
        provider,
        providers: params.providers,
      })
    ) {
      continue;
    }
    providerDefaults.set(providerId, `${providerId}/${modelId}`);
  }

  const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
  const orderedProviders = [
    primaryProvider,
    ...[...providerDefaults.keys()]
      .filter((providerId) => providerId !== primaryProvider)
      .toSorted(),
  ];
  const orderedRefs: string[] = [];
  const seen = new Set<string>();
  for (const providerId of orderedProviders) {
    const ref = providerDefaults.get(providerId);
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    orderedRefs.push(ref);
  }
  return orderedRefs;
}

export function resolveCapabilityModelConfigForTool<T extends CapabilityProvider>(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  modelConfig?: AgentModelConfig;
  providers: T[];
}): ToolModelConfig | null {
  const explicit = coerceToolModelConfig(params.modelConfig);
  if (hasToolModelConfig(explicit)) {
    return explicit;
  }
  return buildToolModelConfigFromCandidates({
    agentDir: params.agentDir,
    candidates: resolveCapabilityModelCandidatesForTool({
      agentDir: params.agentDir,
      cfg: params.cfg,
      providers: params.providers,
    }),
    explicit,
    isProviderConfigured: (providerId) =>
      isCapabilityProviderConfigured({
        agentDir: params.agentDir,
        cfg: params.cfg,
        providerId,
        providers: params.providers,
      }),
  });
}

function formatQuotedList(values: readonly string[]): string {
  if (values.length === 1) {
    return `"${values[0]}"`;
  }
  if (values.length === 2) {
    return `"${values[0]}" or "${values[1]}"`;
  }
  return `${values
    .slice(0, -1)
    .map((value) => `"${value}"`)
    .join(", ")}, or "${values[values.length - 1]}"`;
}

export function resolveGenerateAction<TAction extends string>(params: {
  args: Record<string, unknown>;
  allowed: readonly TAction[];
  defaultAction: TAction;
}): TAction {
  const raw = readStringParam(params.args, "action");
  if (!raw) {
    return params.defaultAction;
  }
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized && (params.allowed as readonly string[]).includes(normalized)) {
    return normalized as TAction;
  }
  throw new ToolInputError(`action must be ${formatQuotedList(params.allowed)}`);
}

export function readBooleanToolParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = normalizeOptionalLowercaseString(raw);
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

export function normalizeMediaReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: string;
  pluralKey: string;
  maxCount: number;
  label: string;
}): string[] {
  const single = readStringParam(params.args, params.singularKey);
  const multiple = readStringArrayParam(params.args, params.pluralKey);
  const combined = [...(single ? [single] : []), ...(multiple ?? [])];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of combined) {
    const trimmed = candidate.trim();
    const dedupe = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!dedupe || seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    deduped.push(trimmed);
  }
  if (deduped.length > params.maxCount) {
    throw new ToolInputError(
      `Too many ${params.label}: ${deduped.length} provided, maximum is ${params.maxCount}.`,
    );
  }
  return deduped;
}

export function buildMediaReferenceDetails<T extends MediaReferenceDetailEntry>(params: {
  entries: readonly T[];
  singleKey: string;
  pluralKey: string;
  getResolvedInput: (entry: T) => string | undefined;
  singleRewriteKey?: string;
}): Record<string, unknown> {
  if (params.entries.length === 1) {
    const entry = params.entries[0];
    if (!entry) {
      return {};
    }
    const rewriteKey = params.singleRewriteKey ?? "rewrittenFrom";
    return {
      [params.singleKey]: params.getResolvedInput(entry),
      ...(entry.rewrittenFrom ? { [rewriteKey]: entry.rewrittenFrom } : {}),
    };
  }
  if (params.entries.length > 1) {
    return {
      [params.pluralKey]: params.entries.map((entry) => ({
        [params.singleKey]: params.getResolvedInput(entry),
        ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
      })),
    };
  }
  return {};
}

export function buildTaskRunDetails(
  handle: TaskRunDetailHandle | null | undefined,
): Record<string, unknown> {
  return handle
    ? {
        task: {
          runId: handle.runId,
          taskId: handle.taskId,
        },
      }
    : {};
}

export function resolveMediaToolLocalRoots(
  workspaceDirRaw: string | undefined,
  options?: { workspaceOnly?: boolean },
  _mediaSources?: readonly string[],
): string[] {
  const workspaceDir = normalizeWorkspaceDir(workspaceDirRaw);
  if (options?.workspaceOnly) {
    return workspaceDir ? [workspaceDir] : [];
  }
  const roots = getDefaultLocalRoots();
  return workspaceDir ? [...new Set([...roots, workspaceDir])] : [...roots];
}

export function resolvePromptAndModelOverride(
  args: Record<string, unknown>,
  defaultPrompt: string,
): {
  prompt: string;
  modelOverride?: string;
} {
  const prompt = normalizeOptionalString(args.prompt) ?? defaultPrompt;
  const modelOverride = normalizeOptionalString(args.model);
  return { modelOverride, prompt };
}

export function buildTextToolResult(
  result: TextToolResult,
  extraDetails: Record<string, unknown>,
): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
} {
  return {
    content: [{ text: result.text, type: "text" }],
    details: {
      model: `${result.provider}/${result.model}`,
      ...extraDetails,
      attempts: result.attempts,
    },
  };
}

export function resolveModelFromRegistry(params: {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
}): Model<Api> {
  const model = params.modelRegistry.find(params.provider, params.modelId) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.modelId}`);
  }
  return model;
}

export async function resolveModelRuntimeApiKey(params: {
  model: Model<Api>;
  cfg: OpenClawConfig | undefined;
  agentDir: string;
  authStorage: {
    setRuntimeApiKey: (provider: string, apiKey: string) => void;
  };
}): Promise<string> {
  const apiKeyInfo = await getApiKeyForModel({
    agentDir: params.agentDir,
    cfg: params.cfg,
    model: params.model,
  });
  const apiKey = requireApiKey(apiKeyInfo, params.model.provider);
  params.authStorage.setRuntimeApiKey(params.model.provider, apiKey);
  return apiKey;
}
