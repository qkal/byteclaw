import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";
import { resolveConfiguredOpenAIBaseUrl, toOpenAIDataUrl } from "./shared.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";

function shouldAllowPrivateImageEndpoint(req: {
  provider: string;
  cfg: OpenClawConfig | undefined;
}) {
  if (req.provider === MOCK_OPENAI_PROVIDER_ID) {
    return true;
  }
  const baseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
  if (!baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) {
    return false;
  }
  return process.env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER === "1";
}

interface OpenAIImageApiResponse {
  data?: {
    b64_json?: string;
    revised_prompt?: string;
  }[];
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsSize: true,
      },
      generate: {
        maxCount: 4,
        supportsAspectRatio: false,
        supportsResolution: false,
        supportsSize: true,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
    },
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "openai",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          allowPrivateNetwork: shouldAllowPrivateImageEndpoint(req),
          baseUrl: resolveConfiguredOpenAIBaseUrl(req.cfg),
          capability: "image",
          defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openai",
          transport: "http",
        });

      const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;
      const requestResult = isEdit
        ? await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              allowPrivateNetwork,
              body: {
                images: inputImages.map((image) => ({
                  image_url: toOpenAIDataUrl(
                    image.buffer,
                    image.mimeType?.trim() || DEFAULT_OUTPUT_MIME,
                  ),
                })),
                model,
                n: count,
                prompt: req.prompt,
                size,
              },
              dispatcherPolicy,
              fetchFn: fetch,
              headers: jsonHeaders,
              timeoutMs: req.timeoutMs,
              url: `${baseUrl}/images/edits`,
            });
          })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              allowPrivateNetwork,
              body: {
                model,
                n: count,
                prompt: req.prompt,
                size,
              },
              dispatcherPolicy,
              fetchFn: fetch,
              headers: jsonHeaders,
              timeoutMs: req.timeoutMs,
              url: `${baseUrl}/images/generations`,
            });
          })();
      const { response, release } = requestResult;
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed",
        );

        const data = (await response.json()) as OpenAIImageApiResponse;
        const images = (data.data ?? [])
          .map((entry, index) => {
            if (!entry.b64_json) {
              return null;
            }
            return Object.assign(
              {
                buffer: Buffer.from(entry.b64_json, `base64`),
                mimeType: DEFAULT_OUTPUT_MIME,
                fileName: `image-${index + 1}.png`,
              },
              entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {},
            );
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
    id: "openai",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "openai",
      }),
    label: "OpenAI",
    models: [DEFAULT_OPENAI_IMAGE_MODEL],
  };
}
