import { type Context, complete } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { type PdfExtractedContent, extractPdfContent } from "../../media/pdf-extract.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import {
  applyImageModelConfigDefaults,
  buildTextToolResult,
  resolveMediaToolLocalRoots,
  resolveModelFromRegistry,
  resolveModelRuntimeApiKey,
  resolvePromptAndModelOverride,
} from "./media-tool-shared.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfInputs,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import {
  type AnyAgentTool,
  type SandboxFsBridge,
  type SandboxedBridgeMediaPathConfig,
  type ToolFsPolicy,
  createSandboxBridgeReadFile,
  discoverAuthStorage,
  discoverModels,
  ensureOpenClawModelsJson,
  resolveSandboxedBridgeMediaPath,
  runWithImageModelFallback,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;

const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4_000_000;

export const PdfToolSchema = Type.Object({
  maxBytesMb: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
  pages: Type.Optional(
    Type.String({
      description: 'Page range to process, e.g. "1-5", "1,3,5-7". Defaults to all pages.',
    }),
  ),
  pdf: Type.Optional(Type.String({ description: "Single PDF path or URL." })),
  pdfs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Multiple PDF paths or URLs (up to 10).",
    }),
  ),
  prompt: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Model resolution (mirrors image tool pattern)
// ---------------------------------------------------------------------------

export { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";

// ---------------------------------------------------------------------------
// Build context for extraction fallback path
// ---------------------------------------------------------------------------

function buildPdfExtractionContext(prompt: string, extractions: PdfExtractedContent[]): Context {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];

  // Add extracted text and images
  for (let i = 0; i < extractions.length; i++) {
    const extraction = extractions[i];
    if (extraction.text.trim()) {
      const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
      content.push({ text: label + extraction.text, type: "text" });
    }
    for (const img of extraction.images) {
      content.push({ data: img.data, mimeType: img.mimeType, type: "image" });
    }
  }

  // Add the user prompt
  content.push({ text: prompt, type: "text" });

  return {
    messages: [{ content, role: "user", timestamp: Date.now() }],
  };
}

// ---------------------------------------------------------------------------
// Run PDF prompt with model fallback
// ---------------------------------------------------------------------------

interface PdfSandboxConfig {
  root: string;
  bridge: SandboxFsBridge;
}

async function runPdfPrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  pdfBuffers: { base64: string; filename: string }[];
  pageNumbers?: number[];
  getExtractions: () => Promise<PdfExtractedContent[]>;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  native: boolean;
  attempts: { provider: string; model: string; error: string }[];
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.pdfModelConfig);

  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  let extractionCache: PdfExtractedContent[] | null = null;
  const getExtractions = async (): Promise<PdfExtractedContent[]> => {
    if (!extractionCache) {
      extractionCache = await params.getExtractions();
    }
    return extractionCache;
  };

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = resolveModelFromRegistry({ modelId, modelRegistry, provider });
      const apiKey = await resolveModelRuntimeApiKey({
        agentDir: params.agentDir,
        authStorage,
        cfg: effectiveCfg,
        model,
      });

      if (providerSupportsNativePdf(provider)) {
        if (params.pageNumbers && params.pageNumbers.length > 0) {
          throw new Error(
            `pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`,
          );
        }

        const pdfs = params.pdfBuffers.map((p) => ({
          base64: p.base64,
          filename: p.filename,
        }));

        if (provider === "anthropic") {
          const text = await anthropicAnalyzePdf({
            apiKey,
            baseUrl: model.baseUrl,
            maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
            modelId,
            pdfs,
            prompt: params.prompt,
          });
          return { model: modelId, native: true, provider, text };
        }

        if (provider === "google") {
          const text = await geminiAnalyzePdf({
            apiKey,
            baseUrl: model.baseUrl,
            modelId,
            pdfs,
            prompt: params.prompt,
          });
          return { model: modelId, native: true, provider, text };
        }
      }

      const extractions = await getExtractions();
      const hasImages = extractions.some((e) => e.images.length > 0);
      if (hasImages && !model.input?.includes("image")) {
        const hasText = extractions.some((e) => e.text.trim().length > 0);
        if (!hasText) {
          throw new Error(
            `Model ${provider}/${modelId} does not support images and PDF has no extractable text.`,
          );
        }
        const textOnlyExtractions: PdfExtractedContent[] = extractions.map((e) => ({
          images: [],
          text: e.text,
        }));
        const context = buildPdfExtractionContext(params.prompt, textOnlyExtractions);
        const message = await complete(model, context, {
          apiKey,
          maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
        });
        const text = coercePdfAssistantText({ message, model: modelId, provider });
        return { model: modelId, native: false, provider, text };
      }

      const context = buildPdfExtractionContext(params.prompt, extractions);
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
      });
      const text = coercePdfAssistantText({ message, model: modelId, provider });
      return { model: modelId, native: false, provider, text };
    },
  });

  return {
    attempts: result.attempts.map((a) => ({
      error: a.error,
      model: a.model,
      provider: a.provider,
    })),
    model: result.result.model,
    native: result.result.native,
    provider: result.result.provider,
    text: result.result.text,
  };
}

// ---------------------------------------------------------------------------
// PDF tool factory
// ---------------------------------------------------------------------------

export function createPdfTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: PdfSandboxConfig;
  fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coercePdfModelConfig(options?.config);
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
      throw new Error("createPdfTool requires agentDir when enabled");
    }
    return null;
  }

  const pdfModelConfig = resolvePdfModelConfigForTool({ agentDir, cfg: options?.config });
  if (!pdfModelConfig) {
    return null;
  }

  const maxBytesMbDefault = (
    options?.config?.agents?.defaults as Record<string, unknown> | undefined
  )?.pdfMaxBytesMb;
  const maxPagesDefault = (options?.config?.agents?.defaults as Record<string, unknown> | undefined)
    ?.pdfMaxPages;
  const configuredMaxBytesMb =
    typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault)
      ? maxBytesMbDefault
      : DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages =
    typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault)
      ? Math.floor(maxPagesDefault)
      : DEFAULT_MAX_PAGES;

  const description =
    "Analyze one or more PDF documents with a model. Supports native PDF analysis for Anthropic and Google models, with text/image extraction fallback for other providers. Use pdf for a single path/URL, or pdfs for multiple (up to 10). Provide a prompt describing what to analyze.";

  return {
    description,
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize pdf + pdfs input
      const pdfInputs = resolvePdfInputs(record);

      // Enforce max PDFs cap
      if (pdfInputs.length > DEFAULT_MAX_PDFS) {
        return {
          content: [
            {
              text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
              type: "text",
            },
          ],
          details: { count: pdfInputs.length, error: "too_many_pdfs", max: DEFAULT_MAX_PDFS },
        };
      }

      const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
        record,
        DEFAULT_PROMPT,
      );
      const maxBytesMbRaw = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytesMb =
        typeof maxBytesMbRaw === "number" && Number.isFinite(maxBytesMbRaw) && maxBytesMbRaw > 0
          ? maxBytesMbRaw
          : configuredMaxBytesMb;
      const maxBytes = Math.floor(maxBytesMb * 1024 * 1024);

      // Parse page range
      const pagesRaw = normalizeOptionalString(record.pages);

      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options.sandbox.root.trim()
          ? {
              bridge: options.sandbox.bridge,
              root: options.sandbox.root.trim(),
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load each PDF
      const loadedPdfs: {
        base64: string;
        buffer: Buffer;
        filename: string;
        resolvedPath: string;
        rewrittenFrom?: string;
      }[] = [];

      for (const pdfRaw of pdfInputs) {
        const trimmed = pdfRaw.trim();
        const isHttpUrl = /^https?:\/\//i.test(trimmed);
        const isFileUrl = /^file:/i.test(trimmed);
        const isDataUrl = /^data:/i.test(trimmed);
        const looksLikeWindowsDrive = /^[a-zA-Z]:[\\/]/.test(trimmed);
        const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);

        if (hasScheme && !looksLikeWindowsDrive && !isFileUrl && !isHttpUrl && !isDataUrl) {
          return {
            content: [
              {
                text: `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`,
                type: "text",
              },
            ],
            details: { error: "unsupported_pdf_reference", pdf: pdfRaw },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed PDF tool does not allow remote URLs.");
        }

        const resolvedPdf = (() => {
          if (sandboxConfig) {
            return trimmed;
          }
          if (trimmed.startsWith("~")) {
            return resolveUserPath(trimmed);
          }
          return trimmed;
        })();

        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = sandboxConfig
          ? await resolveSandboxedBridgeMediaPath({
              inboundFallbackDir: "media/inbound",
              mediaPath: resolvedPdf,
              sandbox: sandboxConfig,
            })
          : {
              resolved: resolvedPdf.startsWith("file://")
                ? resolvedPdf.slice("file://".length)
                : resolvedPdf,
            };
        const localRoots = resolveMediaToolLocalRoots(
          options?.workspaceDir,
          {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          },
          [resolvedPathInfo.resolved],
        );

        const media = sandboxConfig
          ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
              sandboxValidated: true,
            })
          : await loadWebMediaRaw(resolvedPathInfo.resolved, {
              localRoots,
              maxBytes,
            });

        if (media.kind !== "document") {
          // Check MIME type more specifically
          const ct = normalizeLowercaseStringOrEmpty(media.contentType);
          if (!ct.includes("pdf") && !ct.includes("application/pdf")) {
            throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
          }
        }

        const base64 = media.buffer.toString("base64");
        const filename =
          media.fileName ??
          (isHttpUrl
            ? (new URL(trimmed).pathname.split("/").pop() ?? "document.pdf")
            : "document.pdf");

        loadedPdfs.push({
          base64,
          buffer: media.buffer,
          filename,
          resolvedPath: resolvedPathInfo.resolved,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      const pageNumbers = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;

      const getExtractions = async (): Promise<PdfExtractedContent[]> => {
        const extractedAll: PdfExtractedContent[] = [];
        for (const pdf of loadedPdfs) {
          const extracted = await extractPdfContent({
            buffer: pdf.buffer,
            maxPages: configuredMaxPages,
            maxPixels: PDF_MAX_PIXELS,
            minTextChars: PDF_MIN_TEXT_CHARS,
            pageNumbers,
          });
          extractedAll.push(extracted);
        }
        return extractedAll;
      };

      const result = await runPdfPrompt({
        agentDir,
        cfg: options?.config,
        getExtractions,
        modelOverride,
        pageNumbers,
        pdfBuffers: loadedPdfs.map((p) => ({ base64: p.base64, filename: p.filename })),
        pdfModelConfig,
        prompt: promptRaw,
      });

      const pdfDetails =
        loadedPdfs.length === 1
          ? {
              pdf: loadedPdfs[0].resolvedPath,
              ...(loadedPdfs[0].rewrittenFrom
                ? { rewrittenFrom: loadedPdfs[0].rewrittenFrom }
                : {}),
            }
          : {
              pdfs: loadedPdfs.map((p) => (Object.assign({pdf:p.resolvedPath}, p.rewrittenFrom?{rewrittenFrom:p.rewrittenFrom}:{}))),
            };

      return buildTextToolResult(result, { native: result.native, ...pdfDetails });
    },
    label: "PDF",
    name: "pdf",
    parameters: PdfToolSchema,
  };
}
