import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { type SsrFPolicy, fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
} from "./defaults.js";

export interface OllamaTagModel {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

export interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  capabilities?: string[];
};

const OLLAMA_SHOW_CONCURRENCY = 8;

export function buildOllamaBaseUrlSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return {
      allowedHostnames: [parsed.hostname],
      hostnameAllowlist: [parsed.hostname],
    };
  } catch {
    return undefined;
  }
}

export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export interface OllamaModelShowInfo {
  contextWindow?: number;
  capabilities?: string[];
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
): Promise<OllamaModelShowInfo> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      auditContext: "ollama-provider-models.show",
      init: {
        body: JSON.stringify({ name: modelName }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(3000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      url: `${apiBase}/api/show`,
    });
    try {
      if (!response.ok) {
        return {};
      }
      const data = (await response.json()) as {
        model_info?: Record<string, unknown>;
        capabilities?: unknown;
      };

      let contextWindow: number | undefined;
      if (data.model_info) {
        for (const [key, value] of Object.entries(data.model_info)) {
          if (
            key.endsWith(".context_length") &&
            typeof value === "number" &&
            Number.isFinite(value)
          ) {
            const ctx = Math.floor(value);
            if (ctx > 0) {
              contextWindow = ctx;
              break;
            }
          }
        }
      }

      const capabilities = Array.isArray(data.capabilities)
        ? (data.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;

      return { capabilities, contextWindow };
    } finally {
      await release();
    }
  } catch {
    return {};
  }
}

/** @deprecated Use queryOllamaModelShowInfo instead. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  return (await queryOllamaModelShowInfo(apiBase, modelName)).contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const showInfo = await queryOllamaModelShowInfo(apiBase, model.name);
        return {
          ...model,
          capabilities: showInfo.capabilities,
          contextWindow: showInfo.contextWindow,
        };
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  capabilities?: string[],
): ModelDefinitionConfig {
  const hasVision = capabilities?.includes("vision") ?? false;
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  return {
    contextWindow: contextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW,
    cost: OLLAMA_DEFAULT_COST,
    id: modelId,
    input,
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    name: modelId,
    reasoning: isReasoningModelHeuristic(modelId),
  };
}

export async function fetchOllamaModels(
  baseUrl: string,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const { response, release } = await fetchWithSsrFGuard({
      auditContext: "ollama-provider-models.tags",
      init: {
        signal: AbortSignal.timeout(5000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      url: `${apiBase}/api/tags`,
    });
    try {
      if (!response.ok) {
        return { models: [], reachable: true };
      }
      const data = (await response.json()) as OllamaTagsResponse;
      const models = (data.models ?? []).filter((m) => m.name);
      return { models, reachable: true };
    } finally {
      await release();
    }
  } catch {
    return { models: [], reachable: false };
  }
}
