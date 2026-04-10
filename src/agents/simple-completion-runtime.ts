import { type Api, type Model, complete } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import {
  type ResolvedProviderAuth,
  applyLocalNoAuthHeaderOverride,
  getApiKeyForModel,
} from "./model-auth.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

interface SimpleCompletionAuthStorage {
  setRuntimeApiKey: (provider: string, apiKey: string) => void;
}

interface CompletionRuntimeCredential {
  apiKey: string;
  baseUrl?: string;
}

type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];

export interface SimpleCompletionModelOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

export type PreparedSimpleCompletionModel =
  | {
      model: Model<Api>;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      auth?: ResolvedProviderAuth;
    };

export interface AgentSimpleCompletionSelection {
  provider: string;
  modelId: string;
  profileId?: string;
  agentDir: string;
}

export type PreparedSimpleCompletionModelForAgent =
  | {
      selection: AgentSimpleCompletionSelection;
      model: Model<Api>;
      auth: ResolvedProviderAuth;
    }
  | {
      error: string;
      selection?: AgentSimpleCompletionSelection;
      auth?: ResolvedProviderAuth;
    };

export function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
}): AgentSimpleCompletionSelection | null {
  const fallbackRef = resolveDefaultModelForAgent({
    agentId: params.agentId,
    cfg: params.cfg,
  });
  const modelRef =
    params.modelRef?.trim() || resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
  });
  const resolved = split
    ? resolveModelRefFromString({
        aliasIndex,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        raw: split.model,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    modelId,
    profileId: split?.profile || undefined,
    provider,
  };
}

async function setRuntimeApiKeyForCompletion(params: {
  authStorage: SimpleCompletionAuthStorage;
  model: Model<Api>;
  apiKey: string;
}): Promise<CompletionRuntimeCredential> {
  if (params.model.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");
    const copilotToken = await resolveCopilotApiToken({
      githubToken: params.apiKey,
    });
    params.authStorage.setRuntimeApiKey(params.model.provider, copilotToken.token);
    return {
      apiKey: copilotToken.token,
      baseUrl: copilotToken.baseUrl,
    };
  }
  params.authStorage.setRuntimeApiKey(params.model.provider, params.apiKey);
  return {
    apiKey: params.apiKey,
  };
}

function hasMissingApiKeyAllowance(params: {
  mode: ResolvedProviderAuth["mode"];
  allowMissingApiKeyModes?: readonly AllowedMissingApiKeyMode[];
}): boolean {
  return Boolean(params.allowMissingApiKeyModes?.includes(params.mode));
}

export async function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: readonly AllowedMissingApiKeyMode[];
}): Promise<PreparedSimpleCompletionModel> {
  const resolved = resolveModel(params.provider, params.modelId, params.agentDir, params.cfg);
  if (!resolved.model) {
    return {
      error: resolved.error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }

  let auth: ResolvedProviderAuth;
  try {
    auth = await getApiKeyForModel({
      agentDir: params.agentDir,
      cfg: params.cfg,
      model: resolved.model,
      preferredProfile: params.preferredProfile,
      profileId: params.profileId,
    });
  } catch (error) {
    return {
      error: `Auth lookup failed for provider "${resolved.model.provider}": ${formatErrorMessage(error)}`,
    };
  }
  const rawApiKey = auth.apiKey?.trim();
  if (
    !rawApiKey &&
    !hasMissingApiKeyAllowance({
      allowMissingApiKeyModes: params.allowMissingApiKeyModes,
      mode: auth.mode,
    })
  ) {
    return {
      auth,
      error: `No API key resolved for provider "${resolved.model.provider}" (auth mode: ${auth.mode}).`,
    };
  }

  let resolvedApiKey = rawApiKey;
  let resolvedModel = resolved.model;
  if (rawApiKey) {
    const runtimeCredential = await setRuntimeApiKeyForCompletion({
      apiKey: rawApiKey,
      authStorage: resolved.authStorage,
      model: resolved.model,
    });
    resolvedApiKey = runtimeCredential.apiKey;
    const runtimeBaseUrl = runtimeCredential.baseUrl?.trim();
    if (runtimeBaseUrl) {
      resolvedModel = {
        ...resolvedModel,
        baseUrl: runtimeBaseUrl,
      };
    }
  }

  const resolvedAuth: ResolvedProviderAuth = {
    ...auth,
    apiKey: resolvedApiKey,
  };

  return {
    auth: resolvedAuth,
    model: applyLocalNoAuthHeaderOverride(resolvedModel, resolvedAuth),
  };
}

export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: readonly AllowedMissingApiKeyMode[];
}): Promise<PreparedSimpleCompletionModelForAgent> {
  const selection = resolveSimpleCompletionSelectionForAgent({
    agentId: params.agentId,
    cfg: params.cfg,
    modelRef: params.modelRef,
  });
  if (!selection) {
    return {
      error: `No model configured for agent ${params.agentId}.`,
    };
  }
  const prepared = await prepareSimpleCompletionModel({
    agentDir: selection.agentDir,
    allowMissingApiKeyModes: params.allowMissingApiKeyModes,
    cfg: params.cfg,
    modelId: selection.modelId,
    preferredProfile: params.preferredProfile,
    profileId: selection.profileId,
    provider: selection.provider,
  });
  if ("error" in prepared) {
    return {
      ...prepared,
      selection,
    };
  }
  return {
    auth: prepared.auth,
    model: prepared.model,
    selection,
  };
}

export async function completeWithPreparedSimpleCompletionModel(params: {
  model: Model<Api>;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof complete>[1];
  options?: SimpleCompletionModelOptions;
}) {
  return await complete(params.model, params.context, {
    ...params.options,
    apiKey: params.auth.apiKey,
  });
}
