import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";

const DEFAULT_MINIMAX_IMAGE_BASE_URL = "https://api.minimax.io";
const DEFAULT_MODEL = "image-01";
const DEFAULT_OUTPUT_MIME = "image/png";
const MINIMAX_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
] as const;

interface MinimaxImageApiResponse {
  data?: {
    image_base64?: string[];
  };
  metadata?: {
    success_count?: number;
    failed_count?: number;
  };
  id?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

function resolveMinimaxImageBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
  providerId: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  if (!direct) {
    return DEFAULT_MINIMAX_IMAGE_BASE_URL;
  }
  // Extract origin from the configured base URL (which may include path like /anthropic)
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_MINIMAX_IMAGE_BASE_URL;
  }
}

function buildMinimaxImageProvider(providerId: string): ImageGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxCount: 9,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsResolution: false,
        supportsSize: false,
      },
      generate: {
        maxCount: 9,
        supportsAspectRatio: true,
        supportsResolution: false,
        supportsSize: false,
      },
      geometry: {
        aspectRatios: [...MINIMAX_SUPPORTED_ASPECT_RATIOS],
      },
    },
    defaultModel: DEFAULT_MODEL,
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: providerId,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("MiniMax API key missing");
      }

      const baseUrl = resolveMinimaxImageBaseUrl(req.cfg, providerId);
      const {
        baseUrl: resolvedBaseUrl,
        allowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        allowPrivateNetwork: false,
        baseUrl,
        capability: "image",
        defaultBaseUrl: DEFAULT_MINIMAX_IMAGE_BASE_URL,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        provider: providerId,
        transport: "http",
      });

      const body: Record<string, unknown> = {
        model: req.model || DEFAULT_MODEL,
        n: req.count ?? 1,
        prompt: req.prompt,
        response_format: "base64",
      };

      if (req.aspectRatio?.trim()) {
        body.aspect_ratio = req.aspectRatio.trim();
      }

      // Map input images to subject_reference for image-to-image generation
      if (req.inputImages && req.inputImages.length > 0) {
        const ref = req.inputImages[0];
        const mime = ref.mimeType || "image/jpeg";
        const dataUrl = `data:${mime};base64,${ref.buffer.toString("base64")}`;
        body.subject_reference = [{ image_file: dataUrl, type: "character" }];
      }
      const { response, release } = await postJsonRequest({
        allowPrivateNetwork,
        body,
        dispatcherPolicy,
        fetchFn: fetch,
        headers,
        timeoutMs: req.timeoutMs,
        url: `${resolvedBaseUrl}/v1/image_generation`,
      });
      try {
        await assertOkOrThrowHttpError(response, "MiniMax image generation failed");

        const data = (await response.json()) as MinimaxImageApiResponse;

        const baseResp = data.base_resp;
        if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
          const msg = baseResp.status_msg ?? "";
          throw new Error(`MiniMax image generation API error (${baseResp.status_code}): ${msg}`);
        }

        const base64Images = data.data?.image_base64 ?? [];
        const failedCount = data.metadata?.failed_count ?? 0;

        if (base64Images.length === 0) {
          const reason =
            failedCount > 0 ? `${failedCount} image(s) failed to generate` : "no images returned";
          throw new Error(`MiniMax image generation returned no images: ${reason}`);
        }

        const images = base64Images
          .map((b64, index) => {
            if (!b64) {
              return null;
            }
            return {
              buffer: Buffer.from(b64, "base64"),
              fileName: `image-${index + 1}.png`,
              mimeType: DEFAULT_OUTPUT_MIME,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model: req.model || DEFAULT_MODEL,
        };
      } finally {
        await release();
      }
    },
    id: providerId,
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: providerId,
      }),
    label: "MiniMax",
    models: [DEFAULT_MODEL],
  };
}

export function buildMinimaxImageGenerationProvider(): ImageGenerationProvider {
  return buildMinimaxImageProvider("minimax");
}

export function buildMinimaxPortalImageGenerationProvider(): ImageGenerationProvider {
  return buildMinimaxImageProvider("minimax-portal");
}
