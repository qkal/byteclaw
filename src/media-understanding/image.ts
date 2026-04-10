import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { isMinimaxVlmModel, minimaxUnderstandImage } from "../agents/minimax-vlm.js";
import {
  getApiKeyForModel,
  requireApiKey,
  resolveApiKeyForProvider,
} from "../agents/model-auth.js";
import { normalizeModelRef } from "../agents/model-selection.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import { coerceImageAssistantText } from "../agents/tools/image-tool.helpers.js";
import type {
  ImageDescriptionRequest,
  ImageDescriptionResult,
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
} from "./types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

function resolveImageToolMaxTokens(modelMaxTokens: number | undefined, requestedMaxTokens = 4096) {
  if (
    typeof modelMaxTokens !== "number" ||
    !Number.isFinite(modelMaxTokens) ||
    modelMaxTokens <= 0
  ) {
    return requestedMaxTokens;
  }
  return Math.min(requestedMaxTokens, modelMaxTokens);
}

async function resolveImageRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  model: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; model: Model<Api> }> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const resolvedRef = normalizeModelRef(params.provider, params.model);
  const model = modelRegistry.find(resolvedRef.provider, resolvedRef.model) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${resolvedRef.provider}/${resolvedRef.model}`);
  }
  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    agentDir: params.agentDir,
    cfg: params.cfg,
    model,
    preferredProfile: params.preferredProfile,
    profileId: params.profile,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);
  authStorage.setRuntimeApiKey(model.provider, apiKey);
  return { apiKey, model };
}

function buildImageContext(
  prompt: string,
  images: { buffer: Buffer; mime?: string }[],
): Context {
  return {
    messages: [
      {
        content: images.map((image) => ({
          type: "image" as const,
          data: image.buffer.toString("base64"),
          mimeType: image.mime ?? "image/jpeg",
        })),
        role: "user",
        timestamp: Date.now(),
      },
    ],
    systemPrompt: prompt,
  };
}

async function describeImagesWithMinimax(params: {
  apiKey: string;
  modelId: string;
  modelBaseUrl?: string;
  prompt: string;
  images: { buffer: Buffer; mime?: string }[];
}): Promise<ImagesDescriptionResult> {
  const responses: string[] = [];
  for (const [index, image] of params.images.entries()) {
    const prompt =
      params.images.length > 1
        ? `${params.prompt}\n\nDescribe image ${index + 1} of ${params.images.length} independently.`
        : params.prompt;
    const text = await minimaxUnderstandImage({
      apiKey: params.apiKey,
      imageDataUrl: `data:${image.mime ?? "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      modelBaseUrl: params.modelBaseUrl,
      prompt,
    });
    responses.push(params.images.length > 1 ? `Image ${index + 1}:\n${text.trim()}` : text.trim());
  }
  return {
    model: params.modelId,
    text: responses.join("\n\n").trim(),
  };
}

function isUnknownModelError(err: unknown): boolean {
  return err instanceof Error && /^Unknown model:/i.test(err.message);
}

function resolveConfiguredProviderBaseUrl(
  cfg: ImageDescriptionRequest["cfg"],
  provider: string,
): string | undefined {
  const direct = cfg.models?.providers?.[provider];
  if (typeof direct?.baseUrl === "string" && direct.baseUrl.trim()) {
    return direct.baseUrl.trim();
  }
  return undefined;
}

async function resolveMinimaxVlmFallbackRuntime(params: {
  cfg: ImageDescriptionRequest["cfg"];
  agentDir: string;
  provider: string;
  profile?: string;
  preferredProfile?: string;
}): Promise<{ apiKey: string; modelBaseUrl?: string }> {
  const auth = await resolveApiKeyForProvider({
    agentDir: params.agentDir,
    cfg: params.cfg,
    preferredProfile: params.preferredProfile,
    profileId: params.profile,
    provider: params.provider,
  });
  return {
    apiKey: requireApiKey(auth, params.provider),
    modelBaseUrl: resolveConfiguredProviderBaseUrl(params.cfg, params.provider),
  };
}

export async function describeImagesWithModel(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  const prompt = params.prompt ?? "Describe the image.";
  let apiKey: string;
  let model: Model<Api> | undefined;

  try {
    const resolved = await resolveImageRuntime(params);
    ({ apiKey } = resolved);
    ({ model } = resolved);
  } catch (error) {
    if (!isMinimaxVlmModel(params.provider, params.model) || !isUnknownModelError(error)) {
      throw error;
    }
    const fallback = await resolveMinimaxVlmFallbackRuntime(params);
    return await describeImagesWithMinimax({
      apiKey: fallback.apiKey,
      images: params.images,
      modelBaseUrl: fallback.modelBaseUrl,
      modelId: params.model,
      prompt,
    });
  }

  if (isMinimaxVlmModel(model.provider, model.id)) {
    return await describeImagesWithMinimax({
      apiKey,
      images: params.images,
      modelBaseUrl: model.baseUrl,
      modelId: model.id,
      prompt,
    });
  }

  const context = buildImageContext(prompt, params.images);
  const controller = new AbortController();
  const timeout =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  const message = await complete(model, context, {
    apiKey,
    maxTokens: resolveImageToolMaxTokens(model.maxTokens, params.maxTokens ?? 512),
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
  const text = coerceImageAssistantText({
    message,
    model: model.id,
    provider: model.provider,
  });
  return { model: model.id, text };
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  return await describeImagesWithModel({
    agentDir: params.agentDir,
    cfg: params.cfg,
    images: [
      {
        buffer: params.buffer,
        fileName: params.fileName,
        mime: params.mime,
      },
    ],
    maxTokens: params.maxTokens,
    model: params.model,
    preferredProfile: params.preferredProfile,
    profile: params.profile,
    prompt: params.prompt,
    provider: params.provider,
    timeoutMs: params.timeoutMs,
  });
}
