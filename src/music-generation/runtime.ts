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
import { parseMusicGenerationModelRef } from "./model-ref.js";
import { resolveMusicGenerationOverrides } from "./normalization.js";
import { getMusicGenerationProvider, listMusicGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedMusicAsset,
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationOutputFormat,
  MusicGenerationResult,
  MusicGenerationSourceImage,
} from "./types.js";

const log = createSubsystemLogger("music-generation");

export interface GenerateMusicParams {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
}

export interface GenerateMusicRuntimeResult {
  tracks: GeneratedMusicAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  lyrics?: string[];
  normalization?: MusicGenerationNormalization;
  metadata?: Record<string, unknown>;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
}

export function listRuntimeMusicGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listMusicGenerationProviders(params?.config);
}

export async function generateMusic(
  params: GenerateMusicParams,
): Promise<GenerateMusicRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    agentDir: params.agentDir,
    cfg: params.cfg,
    listProviders: listMusicGenerationProviders,
    modelConfig: params.cfg.agents?.defaults?.musicGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(
      buildNoCapabilityModelConfiguredMessage({
        capabilityLabel: "music-generation",
        fallbackSampleRef: "google/lyria-3-clip-preview",
        modelConfigKey: "musicGenerationModel",
        providers: listMusicGenerationProviders(params.cfg),
      }),
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getMusicGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No music-generation provider registered for ${candidate.provider}`;
      attempts.push({
        error,
        model: candidate.model,
        provider: candidate.provider,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveMusicGenerationOverrides({
        durationSeconds: params.durationSeconds,
        format: params.format,
        inputImages: params.inputImages,
        instrumental: params.instrumental,
        lyrics: params.lyrics,
        model: candidate.model,
        provider,
      });
      const result: MusicGenerationResult = await provider.generateMusic({
        agentDir: params.agentDir,
        authStore: params.authStore,
        cfg: params.cfg,
        durationSeconds: sanitized.durationSeconds,
        format: sanitized.format,
        inputImages: params.inputImages,
        instrumental: sanitized.instrumental,
        lyrics: sanitized.lyrics,
        model: candidate.model,
        prompt: params.prompt,
        provider: candidate.provider,
      });
      if (!Array.isArray(result.tracks) || result.tracks.length === 0) {
        throw new Error("Music generation provider returned no tracks.");
      }
      return {
        attempts,
        ignoredOverrides: sanitized.ignoredOverrides,
        lyrics: result.lyrics,
        metadata: {
          ...result.metadata,
          ...buildMediaGenerationNormalizationMetadata({
            normalization: sanitized.normalization,
          }),
        },
        model: result.model ?? candidate.model,
        normalization: sanitized.normalization,
        provider: candidate.provider,
        tracks: result.tracks,
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
      log.debug(`music-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    attempts,
    capabilityLabel: "music generation",
    lastError,
  });
}
