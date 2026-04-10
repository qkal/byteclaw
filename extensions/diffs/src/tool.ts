import fs from "node:fs/promises";
import type { Static} from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { type DiffScreenshotter, PlaywrightDiffScreenshotter } from "./browser.js";
import { resolveDiffImageRenderOptions } from "./config.js";
import { renderDiffDocument } from "./render.js";
import type { DiffArtifactStore } from "./store.js";
import type {
  DiffArtifactContext,
  DiffRenderOptions,
  DiffRenderTarget,
  DiffToolDefaults,
} from "./types.js";
import {
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES,
  type DiffImageQualityPreset,
  type DiffInput,
  type DiffLayout,
  type DiffMode,
  type DiffOutputFormat,
  type DiffTheme,
} from "./types.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

const MAX_BEFORE_AFTER_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_BYTES = 1024;
const MAX_PATH_BYTES = 2048;
const MAX_LANG_BYTES = 128;

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    description,
    enum: [...values],
    type: "string",
  });
}

const DiffsToolSchema = Type.Object(
  {
    after: Type.Optional(Type.String({ description: "Updated text content." })),
    baseUrl: Type.Optional(
      Type.String({
        description:
          "Optional gateway base URL override used when building the viewer URL. Overrides configured viewerBaseUrl, for example https://gateway.example.com.",
      }),
    ),
    before: Type.Optional(Type.String({ description: "Original text content." })),
    expandUnchanged: Type.Optional(
      Type.Boolean({ description: "Expand unchanged sections instead of collapsing them." }),
    ),
    fileFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Rendered file format: png or pdf.")),
    fileMaxWidth: Type.Optional(
      Type.Number({
        description: "Optional rendered-file max width in CSS pixels (640-2400).",
        maximum: 2400,
        minimum: 640,
      }),
    ),
    fileQuality: Type.Optional(
      stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "File quality preset: standard, hq, or print."),
    ),
    fileScale: Type.Optional(
      Type.Number({
        description: "Optional rendered-file device scale factor override (1-4).",
        maximum: 4,
        minimum: 1,
      }),
    ),
    imageFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Deprecated alias for fileFormat.")),
    imageMaxWidth: Type.Optional(
      Type.Number({
        description: "Deprecated alias for fileMaxWidth.",
        maximum: 2400,
        minimum: 640,
      }),
    ),
    imageQuality: Type.Optional(
      stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "Deprecated alias for fileQuality."),
    ),
    imageScale: Type.Optional(
      Type.Number({
        description: "Deprecated alias for fileScale.",
        maximum: 4,
        minimum: 1,
      }),
    ),
    lang: Type.Optional(
      Type.String({
        description: "Optional language override for before/after input.",
        maxLength: MAX_LANG_BYTES,
      }),
    ),
    layout: Type.Optional(stringEnum(DIFF_LAYOUTS, "Diff layout. Default: unified.")),
    mode: Type.Optional(
      stringEnum(
        DIFF_MODES,
        "Output mode: view, file, image (deprecated alias for file), or both. Default: both.",
      ),
    ),
    patch: Type.Optional(
      Type.String({
        description: "Unified diff or patch text.",
        maxLength: MAX_PATCH_BYTES,
      }),
    ),
    path: Type.Optional(
      Type.String({
        description: "Display path for before/after input.",
        maxLength: MAX_PATH_BYTES,
      }),
    ),
    theme: Type.Optional(stringEnum(DIFF_THEMES, "Viewer theme. Default: dark.")),
    title: Type.Optional(
      Type.String({
        description: "Optional title for the rendered diff.",
        maxLength: MAX_TITLE_BYTES,
      }),
    ),
    ttlSeconds: Type.Optional(
      Type.Number({
        description: "Artifact lifetime in seconds. Default: 1800. Maximum: 21600.",
        maximum: 21_600,
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

type DiffsToolParams = Static<typeof DiffsToolSchema>;
type DiffsToolRawParams = DiffsToolParams & {
  // Keep backward compatibility for direct calls that still pass `format`.
  format?: DiffOutputFormat;
};

export function createDiffsTool(params: {
  api: OpenClawPluginApi;
  store: DiffArtifactStore;
  defaults: DiffToolDefaults;
  viewerBaseUrl?: string;
  screenshotter?: DiffScreenshotter;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    description:
      "Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for canvas use and can also render the same diff to a PNG or PDF.",
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as DiffsToolRawParams;
      const artifactContext = buildArtifactContext(params.context);
      const input = normalizeDiffInput(toolParams);
      const mode = normalizeMode(toolParams.mode, params.defaults.mode);
      const theme = normalizeTheme(toolParams.theme, params.defaults.theme);
      const layout = normalizeLayout(toolParams.layout, params.defaults.layout);
      const expandUnchanged = toolParams.expandUnchanged === true;
      const ttlMs = normalizeTtlMs(toolParams.ttlSeconds);
      const image = resolveDiffImageRenderOptions({
        defaults: params.defaults,
        fileFormat: normalizeOutputFormat(
          toolParams.fileFormat ?? toolParams.imageFormat ?? toolParams.format,
        ),
        fileMaxWidth: toolParams.fileMaxWidth ?? toolParams.imageMaxWidth,
        fileQuality: normalizeFileQuality(toolParams.fileQuality ?? toolParams.imageQuality),
        fileScale: toolParams.fileScale ?? toolParams.imageScale,
      });
      const renderTarget = resolveRenderTarget(mode);

      const rendered = await renderDiffDocument(
        input,
        {
          expandUnchanged,
          image,
          presentation: {
            ...params.defaults,
            layout,
            theme,
          },
        },
        renderTarget,
      );

      const screenshotter =
        params.screenshotter ?? new PlaywrightDiffScreenshotter({ config: params.api.config });

      if (isArtifactOnlyMode(mode)) {
        const artifactFile = await renderDiffArtifactFile({
          context: artifactContext,
          html: requireRenderedHtml(rendered.imageHtml, "image"),
          image,
          screenshotter,
          store: params.store,
          theme,
          ttlMs,
        });

        return {
          content: [
            {
              text: buildFileArtifactMessage({
                format: image.format,
                filePath: artifactFile.path,
              }),
              type: "text",
            },
          ],
          details: buildArtifactDetails({
            artifactFile,
            baseDetails: {
              ...(artifactFile.artifactId ? { artifactId: artifactFile.artifactId } : {}),
              ...(artifactFile.expiresAt ? { expiresAt: artifactFile.expiresAt } : {}),
              fileCount: rendered.fileCount,
              inputKind: rendered.inputKind,
              mode,
              title: rendered.title,
              ...(artifactContext ? { context: artifactContext } : {}),
            },
            image,
          }),
        };
      }

      const artifact = await params.store.createArtifact({
        context: artifactContext,
        fileCount: rendered.fileCount,
        html: requireRenderedHtml(rendered.html, "viewer"),
        inputKind: rendered.inputKind,
        title: rendered.title,
        ttlMs,
      });

      const viewerUrl = buildViewerUrl({
        baseUrl: normalizeBaseUrl(toolParams.baseUrl) ?? params.viewerBaseUrl,
        config: params.api.config,
        viewerPath: artifact.viewerPath,
      });

      const baseDetails = {
        artifactId: artifact.id,
        expiresAt: artifact.expiresAt,
        fileCount: artifact.fileCount,
        inputKind: artifact.inputKind,
        mode,
        title: artifact.title,
        viewerPath: artifact.viewerPath,
        viewerUrl,
        ...(artifactContext ? { context: artifactContext } : {}),
      };

      if (mode === "view") {
        return {
          content: [
            {
              text: `Diff viewer ready.\n${viewerUrl}`,
              type: "text",
            },
          ],
          details: baseDetails,
        };
      }

      try {
        const artifactFile = await renderDiffArtifactFile({
          artifactId: artifact.id,
          html: requireRenderedHtml(rendered.imageHtml, "image"),
          image,
          screenshotter,
          store: params.store,
          theme,
        });
        await params.store.updateFilePath(artifact.id, artifactFile.path);

        return {
          content: [
            {
              text: buildFileArtifactMessage({
                format: image.format,
                filePath: artifactFile.path,
                viewerUrl,
              }),
              type: "text",
            },
          ],
          details: buildArtifactDetails({
            artifactFile,
            baseDetails,
            image,
          }),
        };
      } catch (error) {
        if (mode === "both") {
          const errorMessage = formatErrorMessage(error);
          return {
            content: [
              {
                text: `Diff viewer ready.\n${viewerUrl}\nFile rendering failed: ${errorMessage}`,
                type: "text",
              },
            ],
            details: {
              ...baseDetails,
              fileError: errorMessage,
              imageError: errorMessage,
            },
          };
        }
        throw error;
      }
    },
    label: "Diffs",
    name: "diffs",
    parameters: DiffsToolSchema,
  };
}

function normalizeFileQuality(
  fileQuality: DiffImageQualityPreset | undefined,
): DiffImageQualityPreset | undefined {
  return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality) ? fileQuality : undefined;
}

function normalizeOutputFormat(format: DiffOutputFormat | undefined): DiffOutputFormat | undefined {
  return format && DIFF_OUTPUT_FORMATS.includes(format) ? format : undefined;
}

function isArtifactOnlyMode(mode: DiffMode): mode is "image" | "file" {
  return mode === "image" || mode === "file";
}

function resolveRenderTarget(mode: DiffMode): DiffRenderTarget {
  if (mode === "view") {
    return "viewer";
  }
  if (isArtifactOnlyMode(mode)) {
    return "image";
  }
  return "both";
}

function requireRenderedHtml(html: string | undefined, target: DiffRenderTarget): string {
  if (html !== undefined) {
    return html;
  }
  throw new Error(`Missing ${target} render output.`);
}

function buildArtifactDetails(params: {
  baseDetails: Record<string, unknown>;
  artifactFile: { path: string; bytes: number };
  image: DiffRenderOptions["image"];
}) {
  return {
    ...params.baseDetails,
    fileBytes: params.artifactFile.bytes,
    fileFormat: params.image.format,
    fileMaxWidth: params.image.maxWidth,
    filePath: params.artifactFile.path,
    fileQuality: params.image.qualityPreset,
    fileScale: params.image.scale,
    format: params.image.format,
    imageBytes: params.artifactFile.bytes,
    imageMaxWidth: params.image.maxWidth,
    imagePath: params.artifactFile.path,
    imageQuality: params.image.qualityPreset,
    imageScale: params.image.scale,
    path: params.artifactFile.path,
  };
}

function buildFileArtifactMessage(params: {
  format: DiffOutputFormat;
  filePath: string;
  viewerUrl?: string;
}): string {
  const lines = params.viewerUrl ? [`Diff viewer: ${params.viewerUrl}`] : [];
  lines.push(`Diff ${params.format.toUpperCase()} generated at: ${params.filePath}`);
  lines.push("Use the `message` tool with `path` or `filePath` to send this file.");
  return lines.join("\n");
}

async function renderDiffArtifactFile(params: {
  screenshotter: DiffScreenshotter;
  store: DiffArtifactStore;
  artifactId?: string;
  html: string;
  theme: DiffTheme;
  image: DiffRenderOptions["image"];
  ttlMs?: number;
  context?: DiffArtifactContext;
}): Promise<{ path: string; bytes: number; artifactId?: string; expiresAt?: string }> {
  const standaloneArtifact = params.artifactId
    ? undefined
    : await params.store.createStandaloneFileArtifact({
        context: params.context,
        format: params.image.format,
        ttlMs: params.ttlMs,
      });
  const outputPath = params.artifactId
    ? params.store.allocateFilePath(params.artifactId, params.image.format)
    : standaloneArtifact!.filePath;

  await params.screenshotter.screenshotHtml({
    html: params.html,
    image: params.image,
    outputPath,
    theme: params.theme,
  });

  const stats = await fs.stat(outputPath);
  return {
    bytes: stats.size,
    path: outputPath,
    ...(standaloneArtifact?.id ? { artifactId: standaloneArtifact.id } : {}),
    ...(standaloneArtifact?.expiresAt ? { expiresAt: standaloneArtifact.expiresAt } : {}),
  };
}

function buildArtifactContext(
  context: OpenClawPluginToolContext | undefined,
): DiffArtifactContext | undefined {
  if (!context) {
    return undefined;
  }

  const artifactContext = {
    agentAccountId: normalizeOptionalString(context.agentAccountId),
    agentId: normalizeOptionalString(context.agentId),
    messageChannel: normalizeOptionalString(context.messageChannel),
    sessionId: normalizeOptionalString(context.sessionId),
  };

  return Object.values(artifactContext).some((value) => value !== undefined)
    ? artifactContext
    : undefined;
}

function normalizeDiffInput(params: DiffsToolParams): DiffInput {
  const patch = params.patch?.trim();
  const {before} = params;
  const {after} = params;

  if (patch) {
    assertMaxBytes(patch, "patch", MAX_PATCH_BYTES);
    if (before !== undefined || after !== undefined) {
      throw new PluginToolInputError("Provide either patch or before/after input, not both.");
    }
    const title = params.title?.trim();
    if (title) {
      assertMaxBytes(title, "title", MAX_TITLE_BYTES);
    }
    return {
      kind: "patch",
      patch,
      title,
    };
  }

  if (before === undefined || after === undefined) {
    throw new PluginToolInputError("Provide patch or both before and after text.");
  }
  assertMaxBytes(before, "before", MAX_BEFORE_AFTER_BYTES);
  assertMaxBytes(after, "after", MAX_BEFORE_AFTER_BYTES);
  const path = normalizeOptionalString(params.path);
  const lang = normalizeOptionalString(params.lang);
  const title = normalizeOptionalString(params.title);
  if (path) {
    assertMaxBytes(path, "path", MAX_PATH_BYTES);
  }
  if (lang) {
    assertMaxBytes(lang, "lang", MAX_LANG_BYTES);
  }
  if (title) {
    assertMaxBytes(title, "title", MAX_TITLE_BYTES);
  }

  return {
    after,
    before,
    kind: "before_after",
    lang,
    path,
    title,
  };
}

function assertMaxBytes(value: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return;
  }
  throw new PluginToolInputError(`${label} exceeds maximum size (${maxBytes} bytes).`);
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  const normalized = baseUrl?.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return normalizeViewerBaseUrl(normalized);
  } catch {
    throw new PluginToolInputError(`Invalid baseUrl: ${normalized}`);
  }
}

function normalizeMode(mode: DiffMode | undefined, fallback: DiffMode): DiffMode {
  return mode && DIFF_MODES.includes(mode) ? mode : fallback;
}

function normalizeTheme(theme: DiffTheme | undefined, fallback: DiffTheme): DiffTheme {
  return theme && DIFF_THEMES.includes(theme) ? theme : fallback;
}

function normalizeLayout(layout: DiffLayout | undefined, fallback: DiffLayout): DiffLayout {
  return layout && DIFF_LAYOUTS.includes(layout) ? layout : fallback;
}

function normalizeTtlMs(ttlSeconds?: number): number | undefined {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds === undefined) {
    return undefined;
  }
  return Math.floor(ttlSeconds * 1000);
}

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
