import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import {
  resolveVideoGenerationMode,
  resolveVideoGenerationModeCapabilities,
} from "../../video-generation/capabilities.js";
import { parseVideoGenerationModelRef } from "../../video-generation/model-ref.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationProvider,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  applyVideoGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  normalizeMediaReferenceInputs,
  readBooleanToolParam,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import type { ToolModelConfig } from "./model-config.helpers.js";
import {
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "./tool-runtime.helpers.js";
import {
  type VideoGenerationTaskHandle,
  completeVideoGenerationTaskRun,
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  wakeVideoGenerationTaskCompletion,
} from "./video-generate-background.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateListActionResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 5;
const MAX_INPUT_VIDEOS = 4;
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default), "status" to inspect the active session task, or "list" to inspect available providers/models.',
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Optional aspect ratio hint: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Optional audio toggle when the provider supports generated audio.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional target duration in seconds. OpenClaw may round this to the nearest provider-supported duration.",
      minimum: 1,
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Optional single reference image path or URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video generation prompt." })),
  resolution: Type.Optional(
    Type.String({
      description: "Optional resolution hint: 480P, 720P, 768P, or 1080P.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Optional size hint like 1280x720 or 1920x1080 when the provider supports it.",
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "Optional single reference video path or URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference videos (up to ${MAX_INPUT_VIDEOS}).`,
    }),
  ),
  watermark: Type.Optional(
    Type.Boolean({
      description: "Optional watermark toggle when the provider supports it.",
    }),
  ),
});

export function resolveVideoGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    agentDir: params.agentDir,
    cfg: params.cfg,
    modelConfig: params.cfg?.agents?.defaults?.videoGenerationModel,
    providers: listRuntimeVideoGenerationProviders({ config: params.cfg }),
  });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    allowed: ["generate", "status", "list"],
    args,
    defaultAction: "generate",
  });
}

function normalizeResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "480P" ||
    normalized === "720P" ||
    normalized === "768P" ||
    normalized === "1080P"
  ) {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 480P, 720P, 768P, or 1080P");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
  );
}

function normalizeReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: "image" | "video";
  pluralKey: "images" | "videos";
  maxCount: number;
}): string[] {
  return normalizeMediaReferenceInputs({
    args: params.args,
    label: `reference ${params.pluralKey}`,
    maxCount: params.maxCount,
    pluralKey: params.pluralKey,
    singularKey: params.singularKey,
  });
}

function resolveSelectedVideoGenerationProvider(params: {
  config?: OpenClawConfig;
  videoGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): VideoGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    modelConfig: params.videoGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
    providers: listRuntimeVideoGenerationProviders({ config: params.config }),
  });
}

function validateVideoGenerationCapabilities(params: {
  provider: VideoGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  inputVideoCount: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
}) {
  const { provider } = params;
  if (!provider) {
    return;
  }
  const mode = resolveVideoGenerationMode({
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
    provider,
  });
  if (!caps && mode === "imageToVideo" && params.inputVideoCount === 0) {
    throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
  }
  if (!caps && mode === "videoToVideo" && params.inputImageCount === 0) {
    throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
  }
  if (!caps) {
    return;
  }
  if (
    mode === "imageToVideo" &&
    "enabled" in caps &&
    !caps.enabled &&
    params.inputVideoCount === 0
  ) {
    throw new ToolInputError(`${provider.id} does not support image-to-video reference inputs.`);
  }
  if (
    mode === "videoToVideo" &&
    "enabled" in caps &&
    !caps.enabled &&
    params.inputImageCount === 0
  ) {
    throw new ToolInputError(`${provider.id} does not support video-to-video reference inputs.`);
  }
  if (params.inputImageCount > 0) {
    const maxInputImages = caps.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
  if (params.inputVideoCount > 0) {
    const maxInputVideos = caps.maxInputVideos ?? MAX_INPUT_VIDEOS;
    if (params.inputVideoCount > maxInputVideos) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputVideos} reference video${maxInputVideos === 1 ? "" : "s"}.`,
      );
    }
  }
}

function formatIgnoredVideoGenerationOverride(override: VideoGenerationIgnoredOverride): string {
  return `${override.key}=${String(override.value)}`;
}

interface VideoGenerateSandboxConfig {
  root: string;
  bridge: SandboxFsBridge;
}

type VideoGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

function defaultScheduleVideoGenerateBackgroundWork(work: () => Promise<void>) {
  queueMicrotask(() => {
    void work().catch((error) => {
      log.error("Detached video generation job crashed", {
        error,
      });
    });
  });
}

async function loadReferenceAssets(params: {
  inputs: string[];
  expectedKind: "image" | "video";
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
}): Promise<
  {
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }[]
> {
  const loaded: {
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }[] = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!inputRaw) {
      throw new ToolInputError(`${params.expectedKind} required (empty string in array)`);
    }
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(inputRaw);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(inputRaw);
    const isFileUrl = /^file:/i.test(inputRaw);
    const isHttpUrl = /^https?:\/\//i.test(inputRaw);
    const isDataUrl = /^data:/i.test(inputRaw);
    if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
      throw new ToolInputError(
        `Unsupported ${params.expectedKind} reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError(
        `Sandboxed video_generate does not allow remote ${params.expectedKind} URLs.`,
      );
    }

    const resolvedInput = (() => {
      if (params.sandboxConfig) {
        return inputRaw;
      }
      if (inputRaw.startsWith("~")) {
        return resolveUserPath(inputRaw);
      }
      return inputRaw;
    })();

    if (isHttpUrl && !params.sandboxConfig) {
      loaded.push({
        resolvedInput,
        sourceAsset: { url: resolvedInput },
      });
      continue;
    }

    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            inboundFallbackDir: "media/inbound",
            mediaPath: resolvedInput,
            sandbox: params.sandboxConfig,
          })
        : {
            resolved: resolvedInput.startsWith("file://")
              ? resolvedInput.slice("file://".length)
              : resolvedInput,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );
    const media = isDataUrl
      ? params.expectedKind === "image"
        ? decodeDataUrl(resolvedInput)
        : (() => {
            throw new ToolInputError("Video data: URLs are not supported for video_generate.");
          })()
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            maxBytes: params.maxBytes,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
            sandboxValidated: true,
          })
        : await loadWebMedia(resolvedPath ?? resolvedInput, {
            localRoots,
            maxBytes: params.maxBytes,
          });
    if (media.kind !== params.expectedKind) {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      resolvedInput,
      sourceAsset: {
        buffer: media.buffer,
        fileName,
        mimeType,
      },
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

interface ExecutedVideoGeneration {
  provider: string;
  model: string;
  savedPaths: string[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
}

async function executeVideoGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  filename?: string;
  loadedReferenceImages: LoadedReferenceAsset[];
  loadedReferenceVideos: LoadedReferenceAsset[];
  taskHandle?: VideoGenerationTaskHandle | null;
}): Promise<ExecutedVideoGeneration> {
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating video",
    });
  }
  const result = await generateVideo({
    agentDir: params.agentDir,
    aspectRatio: params.aspectRatio,
    audio: params.audio,
    cfg: params.effectiveCfg,
    durationSeconds: params.durationSeconds,
    inputImages: params.loadedReferenceImages.map((entry) => entry.sourceAsset),
    inputVideos: params.loadedReferenceVideos.map((entry) => entry.sourceAsset),
    modelOverride: params.model,
    prompt: params.prompt,
    resolution: params.resolution,
    size: params.size,
    watermark: params.watermark,
  });
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated video",
    });
  }
  const savedVideos = await Promise.all(
    result.videos.map((video) =>
      saveMediaBuffer(
        video.buffer,
        video.mimeType,
        "tool-video-generation",
        undefined,
        params.filename || video.fileName,
      ),
    ),
  );
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.`
      : undefined;
  const normalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : requestedDurationSeconds);
  const supportedDurationSeconds =
    result.normalization?.durationSeconds?.supportedValues ??
    (Array.isArray(result.metadata?.supportedDurationSeconds)
      ? result.metadata.supportedDurationSeconds.filter(
          (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
        )
      : undefined);
  const normalizedSize =
    result.normalization?.size?.applied ??
    (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim()
      ? result.metadata.normalizedSize
      : undefined);
  const normalizedAspectRatio =
    result.normalization?.aspectRatio?.applied ??
    (typeof result.metadata?.normalizedAspectRatio === "string" &&
    result.metadata.normalizedAspectRatio.trim()
      ? result.metadata.normalizedAspectRatio
      : undefined);
  const normalizedResolution =
    result.normalization?.resolution?.applied ??
    (typeof result.metadata?.normalizedResolution === "string" &&
    result.metadata.normalizedResolution.trim()
      ? result.metadata.normalizedResolution
      : undefined);
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === params.size &&
      Boolean(normalizedAspectRatio));
  const lines = [
    `Generated ${savedVideos.length} video${savedVideos.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof normalizedDurationSeconds === "number" &&
    requestedDurationSeconds !== normalizedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.`
      : null,
    ...savedVideos.map((video) => `MEDIA:${video.path}`),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    contentText: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedVideos.length,
      media: {
        mediaUrls: savedVideos.map((video) => video.path),
      },
      paths: savedVideos.map((video) => video.path),
      ...buildTaskRunDetails(params.taskHandle),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        getResolvedInput: (entry) => entry.resolvedInput,
        pluralKey: "images",
        singleKey: "image",
      }),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceVideos,
        getResolvedInput: (entry) => entry.resolvedInput,
        pluralKey: "videos",
        singleKey: "video",
        singleRewriteKey: "videoRewrittenFrom",
      }),
      ...(normalizedSize ||
      (!ignoredOverrideKeys.has("size") && params.size && !sizeTranslatedToAspectRatio)
        ? { size: normalizedSize ?? params.size }
        : {}),
      ...(normalizedAspectRatio || (!ignoredOverrideKeys.has("aspectRatio") && params.aspectRatio)
        ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio }
        : {}),
      ...(normalizedResolution || (!ignoredOverrideKeys.has("resolution") && params.resolution)
        ? { resolution: normalizedResolution ?? params.resolution }
        : {}),
      ...(typeof normalizedDurationSeconds === "number"
        ? { durationSeconds: normalizedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof normalizedDurationSeconds === "number" &&
      requestedDurationSeconds !== normalizedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(supportedDurationSeconds && supportedDurationSeconds.length > 0
        ? { supportedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("audio") && typeof params.audio === "boolean"
        ? { audio: params.audio }
        : {}),
      ...(!ignoredOverrideKeys.has("watermark") && typeof params.watermark === "boolean"
        ? { watermark: params.watermark }
        : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
    model: result.model,
    provider: result.provider,
    savedPaths: savedVideos.map((video) => video.path),
    wakeResult: lines.join("\n"),
  };
}

export function createVideoGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: VideoGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: VideoGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? loadConfig();
  const videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({
    agentDir: options?.agentDir,
    cfg,
  });
  if (!videoGenerationModelConfig) {
    return null;
  }

  const sandboxConfig = options?.sandbox
    ? {
        bridge: options.sandbox.bridge,
        root: options.sandbox.root,
        workspaceOnly: options.fsPolicy?.workspaceOnly === true,
      }
    : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;

  return {
    description:
      "Generate videos using configured providers. Generated videos are saved under OpenClaw-managed media storage and delivered automatically as attachments. Duration requests may be rounded to the nearest provider-supported value.",
    displaySummary: "Generate videos",
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);
      const effectiveCfg =
        applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) ?? cfg;

      if (action === "list") {
        return createVideoGenerateListActionResult(effectiveCfg);
      }

      if (action === "status") {
        return createVideoGenerateStatusActionResult(options?.agentSessionKey);
      }

      const duplicateGuardResult = createVideoGenerateDuplicateGuardResult(
        options?.agentSessionKey,
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const model = readStringParam(args, "model");
      const filename = readStringParam(args, "filename");
      const size = readStringParam(args, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(args, "aspectRatio"));
      const resolution = normalizeResolution(readStringParam(args, "resolution"));
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const audio = readBooleanToolParam(args, "audio");
      const watermark = readBooleanToolParam(args, "watermark");
      const imageInputs = normalizeReferenceInputs({
        args,
        maxCount: MAX_INPUT_IMAGES,
        pluralKey: "images",
        singularKey: "image",
      });
      const videoInputs = normalizeReferenceInputs({
        args,
        maxCount: MAX_INPUT_VIDEOS,
        pluralKey: "videos",
        singularKey: "video",
      });

      const selectedProvider = resolveSelectedVideoGenerationProvider({
        config: effectiveCfg,
        modelOverride: model,
        videoGenerationModelConfig,
      });
      const loadedReferenceImages = await loadReferenceAssets({
        expectedKind: "image",
        inputs: imageInputs,
        sandboxConfig,
        workspaceDir: options?.workspaceDir,
      });
      const loadedReferenceVideos = await loadReferenceAssets({
        expectedKind: "video",
        inputs: videoInputs,
        sandboxConfig,
        workspaceDir: options?.workspaceDir,
      });
      validateVideoGenerationCapabilities({
        aspectRatio,
        audio,
        durationSeconds,
        inputImageCount: loadedReferenceImages.length,
        inputVideoCount: loadedReferenceVideos.length,
        model:
          parseVideoGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
        provider: selectedProvider,
        resolution,
        size,
        watermark,
      });
      const taskHandle = createVideoGenerationTaskRun({
        prompt,
        providerId: selectedProvider?.id,
        requesterOrigin: options?.requesterOrigin,
        sessionKey: options?.agentSessionKey,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleBackgroundWork(async () => {
          try {
            const executed = await executeVideoGenerationJob({
              agentDir: options?.agentDir,
              aspectRatio,
              audio,
              durationSeconds,
              effectiveCfg,
              filename,
              loadedReferenceImages,
              loadedReferenceVideos,
              model,
              prompt,
              resolution,
              size,
              taskHandle,
              watermark,
            });
            completeVideoGenerationTaskRun({
              count: executed.savedPaths.length,
              handle: taskHandle,
              model: executed.model,
              paths: executed.savedPaths,
              provider: executed.provider,
            });
            try {
              await wakeVideoGenerationTaskCompletion({
                config: effectiveCfg,
                handle: taskHandle,
                mediaUrls: executed.savedPaths,
                result: executed.wakeResult,
                status: "ok",
                statusLabel: "completed successfully",
              });
            } catch (error) {
              log.warn("Video generation completion wake failed after successful generation", {
                error,
                runId: taskHandle?.runId,
                taskId: taskHandle?.taskId,
              });
            }
          } catch (error) {
            failVideoGenerationTaskRun({
              error,
              handle: taskHandle,
            });
            await wakeVideoGenerationTaskCompletion({
              config: effectiveCfg,
              handle: taskHandle,
              result: formatErrorMessage(error),
              status: "error",
              statusLabel: "failed",
            });
            return;
          }
        });

        return {
          content: [
            {
              text: `Background task started for video generation (${taskHandle?.taskId ?? "unknown"}). Do not call video_generate again for this request. Wait for the completion event; I'll post the finished video here when it's ready.`,
              type: "text",
            },
          ],
          details: {
            async: true,
            status: "started",
            ...buildTaskRunDetails(taskHandle),
            ...buildMediaReferenceDetails({
              entries: loadedReferenceImages,
              getResolvedInput: (entry) => entry.resolvedInput,
              pluralKey: "images",
              singleKey: "image",
            }),
            ...buildMediaReferenceDetails({
              entries: loadedReferenceVideos,
              getResolvedInput: (entry) => entry.resolvedInput,
              pluralKey: "videos",
              singleKey: "video",
              singleRewriteKey: "videoRewrittenFrom",
            }),
            ...(model ? { model } : {}),
            ...(size ? { size } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(typeof audio === "boolean" ? { audio } : {}),
            ...(typeof watermark === "boolean" ? { watermark } : {}),
            ...(filename ? { filename } : {}),
          },
        };
      }

      try {
        const executed = await executeVideoGenerationJob({
          agentDir: options?.agentDir,
          aspectRatio,
          audio,
          durationSeconds,
          effectiveCfg,
          filename,
          loadedReferenceImages,
          loadedReferenceVideos,
          model,
          prompt,
          resolution,
          size,
          taskHandle,
          watermark,
        });
        completeVideoGenerationTaskRun({
          count: executed.savedPaths.length,
          handle: taskHandle,
          model: executed.model,
          paths: executed.savedPaths,
          provider: executed.provider,
        });

        return {
          content: [{ text: executed.contentText, type: "text" }],
          details: executed.details,
        };
      } catch (error) {
        failVideoGenerationTaskRun({
          error,
          handle: taskHandle,
        });
        throw error;
      }
    },
    label: "Video Generation",
    name: "video_generate",
    parameters: VideoGenerateToolSchema,
  };
}
