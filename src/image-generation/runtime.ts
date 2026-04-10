import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildMediaGenerationNormalizationMetadata,
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import { parseImageGenerationModelRef } from "./model-ref.js";
import { resolveImageGenerationOverrides } from "./normalization.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedImageAsset,
  ImageGenerationIgnoredOverride,
  ImageGenerationNormalization,
  ImageGenerationResolution,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "./types.js";

const log = createSubsystemLogger("image-generation");

export interface GenerateImageParams {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inputImages?: ImageGenerationSourceImage[];
}

export interface GenerateImageRuntimeResult {
  images: GeneratedImageAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: ImageGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: ImageGenerationIgnoredOverride[];
}

function buildNoImageGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "image-generation",
    modelConfigKey: "imageGenerationModel",
    providers: listImageGenerationProviders(cfg),
  });
}

export function listRuntimeImageGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listImageGenerationProviders(params?.config);
}

export async function generateImage(
  params: GenerateImageParams,
): Promise<GenerateImageRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    agentDir: params.agentDir,
    cfg: params.cfg,
    listProviders: listImageGenerationProviders,
    modelConfig: params.cfg.agents?.defaults?.imageGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoImageGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getImageGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No image-generation provider registered for ${candidate.provider}`;
      attempts.push({
        error,
        model: candidate.model,
        provider: candidate.provider,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveImageGenerationOverrides({
        aspectRatio: params.aspectRatio,
        inputImages: params.inputImages,
        provider,
        resolution: params.resolution,
        size: params.size,
      });
      const result: ImageGenerationResult = await provider.generateImage({
        agentDir: params.agentDir,
        aspectRatio: sanitized.aspectRatio,
        authStore: params.authStore,
        cfg: params.cfg,
        count: params.count,
        inputImages: params.inputImages,
        model: candidate.model,
        prompt: params.prompt,
        provider: candidate.provider,
        resolution: sanitized.resolution,
        size: sanitized.size,
      });
      if (!Array.isArray(result.images) || result.images.length === 0) {
        throw new Error("Image generation provider returned no images.");
      }
      return {
        attempts,
        ignoredOverrides: sanitized.ignoredOverrides,
        images: result.images,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
          }),
        },
        model: result.model ?? candidate.model,
        normalization: sanitized.normalization,
        provider: candidate.provider,
      };
    } catch (error) {
      lastError = error;
      const described = isFailoverError(error) ? describeFailoverError(error) : undefined;
      attempts.push({
        code: described?.code,
        error: described?.message ?? formatErrorMessage(error),
        model: candidate.model,
        provider: candidate.provider,
        reason: described?.reason,
        status: described?.status,
      });
      log.debug(`image-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    attempts,
    capabilityLabel: "image generation",
    lastError,
  });
}
