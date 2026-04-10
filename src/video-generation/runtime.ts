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
import { parseVideoGenerationModelRef } from "./model-ref.js";
import { resolveVideoGenerationOverrides } from "./normalization.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationResolution,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

const log = createSubsystemLogger("video-generation");

export interface GenerateVideoParams {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
}

export interface GenerateVideoRuntimeResult {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: VideoGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
}

function buildNoVideoGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "video-generation",
    modelConfigKey: "videoGenerationModel",
    providers: listVideoGenerationProviders(cfg),
  });
}

export function listRuntimeVideoGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listVideoGenerationProviders(params?.config);
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<GenerateVideoRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    agentDir: params.agentDir,
    cfg: params.cfg,
    listProviders: listVideoGenerationProviders,
    modelConfig: params.cfg.agents?.defaults?.videoGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getVideoGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({
        error,
        model: candidate.model,
        provider: candidate.provider,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveVideoGenerationOverrides({
        aspectRatio: params.aspectRatio,
        audio: params.audio,
        durationSeconds: params.durationSeconds,
        inputImageCount: params.inputImages?.length ?? 0,
        inputVideoCount: params.inputVideos?.length ?? 0,
        model: candidate.model,
        provider,
        resolution: params.resolution,
        size: params.size,
        watermark: params.watermark,
      });
      const result: VideoGenerationResult = await provider.generateVideo({
        agentDir: params.agentDir,
        aspectRatio: sanitized.aspectRatio,
        audio: sanitized.audio,
        authStore: params.authStore,
        cfg: params.cfg,
        durationSeconds: sanitized.durationSeconds,
        inputImages: params.inputImages,
        inputVideos: params.inputVideos,
        model: candidate.model,
        prompt: params.prompt,
        provider: candidate.provider,
        resolution: sanitized.resolution,
        size: sanitized.size,
        watermark: sanitized.watermark,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      return {
        attempts,
        ignoredOverrides: sanitized.ignoredOverrides,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            includeSupportedDurationSeconds: true,
            normalization: sanitized.normalization,
            requestedSizeForDerivedAspectRatio: params.size,
          }),
        },
        model: result.model ?? candidate.model,
        normalization: sanitized.normalization,
        provider: candidate.provider,
        videos: result.videos,
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
      log.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    attempts,
    capabilityLabel: "video generation",
    lastError,
  });
}
