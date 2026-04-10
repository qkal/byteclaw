import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { loadConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
} from "../plugins/memory-embedding-provider-runtime.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "../plugins/memory-embedding-providers.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  OPENCLAW_MODEL_ID,
  getHeader,
  resolveAgentIdForRequest,
  resolveAgentIdFromModel,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";

interface OpenAiEmbeddingsHttpOptions {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}

interface EmbeddingsRequest {
  model?: unknown;
  input?: unknown;
  encoding_format?: unknown;
  dimensions?: unknown;
  user?: unknown;
}

const DEFAULT_EMBEDDINGS_BODY_BYTES = 5 * 1024 * 1024;
const MAX_EMBEDDING_INPUTS = 128;
const MAX_EMBEDDING_INPUT_CHARS = 8192;
const MAX_EMBEDDING_TOTAL_CHARS = 65_536;
type EmbeddingProviderRequest = string;

function coerceRequest(value: unknown): EmbeddingsRequest {
  return value && typeof value === "object" ? (value as EmbeddingsRequest) : {};
}

function resolveInputTexts(input: unknown): string[] | null {
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.every((entry) => typeof entry === "string")) {
    return input;
  }
  return null;
}

function encodeEmbeddingBase64(embedding: number[]): string {
  const float32 = Float32Array.from(embedding);
  return Buffer.from(float32.buffer).toString("base64");
}

function validateInputTexts(texts: string[]): string | undefined {
  if (texts.length > MAX_EMBEDDING_INPUTS) {
    return `Too many inputs (max ${MAX_EMBEDDING_INPUTS}).`;
  }
  let totalChars = 0;
  for (const text of texts) {
    if (text.length > MAX_EMBEDDING_INPUT_CHARS) {
      return `Input too long (max ${MAX_EMBEDDING_INPUT_CHARS} chars).`;
    }
    totalChars += text.length;
    if (totalChars > MAX_EMBEDDING_TOTAL_CHARS) {
      return `Total input too large (max ${MAX_EMBEDDING_TOTAL_CHARS} chars).`;
    }
  }
  return undefined;
}

function resolveAutoExplicitProviders(cfg: ReturnType<typeof loadConfig>): Set<string> {
  return new Set(
    listMemoryEmbeddingProviders(cfg)
      .filter((adapter) => adapter.allowExplicitWhenConfiguredAuto)
      .map((adapter) => adapter.id),
  );
}

function shouldContinueAutoSelection(
  adapter: MemoryEmbeddingProviderAdapter,
  err: unknown,
): boolean {
  return adapter.shouldContinueAutoSelection?.(err) ?? false;
}

async function createConfiguredEmbeddingProvider(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentDir: string;
  provider: EmbeddingProviderRequest;
  model: string;
  memorySearch?: Pick<
    NonNullable<ReturnType<typeof resolveMemorySearchConfig>>,
    "local" | "remote" | "outputDimensionality"
  >;
}): Promise<MemoryEmbeddingProvider> {
  const createWithAdapter = async (adapter: MemoryEmbeddingProviderAdapter) => {
    const result = await adapter.create({
      agentDir: params.agentDir,
      config: params.cfg,
      local: params.memorySearch?.local,
      model: params.model || adapter.defaultModel || "",
      outputDimensionality: params.memorySearch?.outputDimensionality,
      remote: params.memorySearch?.remote
        ? {
            apiKey: params.memorySearch?.remote.apiKey,
            baseUrl: params.memorySearch?.remote.baseUrl,
            headers: params.memorySearch?.remote.headers,
          }
        : undefined,
    });
    return result.provider;
  };

  if (params.provider === "auto") {
    const adapters = listMemoryEmbeddingProviders(params.cfg)
      .filter((adapter) => typeof adapter.autoSelectPriority === "number")
      .toSorted(
        (a, b) =>
          (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) -
          (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER),
      );
    for (const adapter of adapters) {
      try {
        const provider = await createWithAdapter(adapter);
        if (provider) {
          return provider;
        }
      } catch (error) {
        if (shouldContinueAutoSelection(adapter, error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("No embeddings provider available.");
  }

  const adapter = getMemoryEmbeddingProvider(params.provider, params.cfg);
  if (!adapter) {
    throw new Error(`Unknown memory embedding provider: ${params.provider}`);
  }
  const provider = await createWithAdapter(adapter);
  if (!provider) {
    throw new Error(`Memory embedding provider ${params.provider} is unavailable.`);
  }
  return provider;
}

function resolveEmbeddingsTarget(params: {
  requestModel: string;
  configuredProvider: EmbeddingProviderRequest;
  cfg: ReturnType<typeof loadConfig>;
}): { provider: EmbeddingProviderRequest; model: string } | { errorMessage: string } {
  const raw = params.requestModel.trim();
  const slash = raw.indexOf("/");
  if (slash === -1) {
    return { model: raw, provider: params.configuredProvider };
  }

  const provider = normalizeLowercaseStringOrEmpty(raw.slice(0, slash));
  const model = raw.slice(slash + 1).trim();
  if (!model) {
    return { errorMessage: "Unsupported embedding model reference." };
  }

  if (params.configuredProvider === "auto") {
    const safeAutoExplicitProviders = resolveAutoExplicitProviders(params.cfg);
    if (provider === "auto") {
      return { model, provider: "auto" };
    }
    if (safeAutoExplicitProviders.has(provider)) {
      return { model, provider };
    }
    return {
      errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    };
  }

  if (provider !== params.configuredProvider) {
    return {
      errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    };
  }

  return { model, provider: params.configuredProvider };
}

export async function handleOpenAiEmbeddingsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAiEmbeddingsHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    allowRealIpFallback: opts.allowRealIpFallback,
    auth: opts.auth,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_EMBEDDINGS_BODY_BYTES,
    pathname: "/v1/embeddings",
    rateLimiter: opts.rateLimiter,
    requiredOperatorMethod: "chat.send",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    trustedProxies: opts.trustedProxies,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const requestModel = normalizeOptionalString(payload.model) ?? "";
  if (!requestModel) {
    sendJson(res, 400, {
      error: { message: "Missing `model`.", type: "invalid_request_error" },
    });
    return true;
  }

  const cfg = loadConfig();
  if (requestModel !== OPENCLAW_MODEL_ID && !resolveAgentIdFromModel(requestModel, cfg)) {
    sendJson(res, 400, {
      error: {
        message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const texts = resolveInputTexts(payload.input);
  if (!texts) {
    sendJson(res, 400, {
      error: {
        message: "`input` must be a string or an array of strings.",
        type: "invalid_request_error",
      },
    });
    return true;
  }
  const inputError = validateInputTexts(texts);
  if (inputError) {
    sendJson(res, 400, {
      error: { message: inputError, type: "invalid_request_error" },
    });
    return true;
  }

  const agentId = resolveAgentIdForRequest({ model: requestModel, req });
  const agentDir = resolveAgentDir(cfg, agentId);
  const memorySearch = resolveMemorySearchConfig(cfg, agentId);
  const configuredProvider = memorySearch?.provider ?? "openai";
  const overrideModel =
    normalizeOptionalString(getHeader(req, "x-openclaw-model")) ||
    normalizeOptionalString(memorySearch?.model) ||
    "";
  const target = resolveEmbeddingsTarget({
    cfg,
    configuredProvider,
    requestModel: overrideModel,
  });
  if ("errorMessage" in target) {
    sendJson(res, 400, {
      error: {
        message: target.errorMessage,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  try {
    const provider = await createConfiguredEmbeddingProvider({
      agentDir,
      cfg,
      memorySearch: memorySearch
        ? {
            ...memorySearch,
            outputDimensionality:
              typeof payload.dimensions === "number" && payload.dimensions > 0
                ? Math.floor(payload.dimensions)
                : memorySearch.outputDimensionality,
          }
        : undefined,
      model: target.model,
      provider: target.provider,
    });
    const embeddings = await provider.embedBatch(texts);
    const encodingFormat = payload.encoding_format === "base64" ? "base64" : "float";

    sendJson(res, 200, {
      data: embeddings.map((embedding, index) => ({
        embedding: encodingFormat === "base64" ? encodeEmbeddingBase64(embedding) : embedding,
        index,
        object: "embedding",
      })),
      model: requestModel,
      object: "list",
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    logWarn(`openai-compat: embeddings request failed: ${formatErrorMessage(error)}`);
    sendJson(res, 500, {
      error: {
        message: "internal error",
        type: "api_error",
      },
    });
  }

  return true;
}
