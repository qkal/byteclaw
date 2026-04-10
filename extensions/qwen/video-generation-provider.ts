import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { resolveProviderHttpRequestConfig } from "openclaw/plugin-sdk/provider-http";
import {
  DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
  runDashscopeVideoGenerationTask,
} from "openclaw/plugin-sdk/video-generation";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_QWEN_VIDEO_MODEL = DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL;

function resolveQwenVideoBaseUrl(req: VideoGenerationRequest): string {
  const direct = req.cfg?.models?.providers?.qwen?.baseUrl?.trim();
  if (!direct) {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
  try {
    return new URL(direct).toString();
  } catch {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (
      url.hostname === "coding-intl.dashscope.aliyuncs.com" ||
      url.hostname === "coding.dashscope.aliyuncs.com" ||
      url.hostname === "dashscope-intl.aliyuncs.com" ||
      url.hostname === "dashscope.aliyuncs.com"
    ) {
      return url.origin;
    }
  } catch {
    // Fall through to legacy prefix handling for non-URL strings.
  }
  if (baseUrl.startsWith(QWEN_STANDARD_CN_BASE_URL)) {
    return "https://dashscope.aliyuncs.com";
  }
  if (baseUrl.startsWith(QWEN_STANDARD_GLOBAL_BASE_URL)) {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
  return baseUrl.replace(/\/+$/u, "");
}

export function buildQwenVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
    defaultModel: DEFAULT_QWEN_VIDEO_MODEL,
    async generateVideo(req): Promise<VideoGenerationResult> {
      const fetchFn = fetch;
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "qwen",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Qwen API key missing");
      }

      const requestBaseUrl = resolveQwenVideoBaseUrl(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: requestBaseUrl,
          capability: "video",
          defaultBaseUrl: DEFAULT_QWEN_VIDEO_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          provider: "qwen",
          transport: "http",
        });

      const model = req.model?.trim() || DEFAULT_QWEN_VIDEO_MODEL;
      return await runDashscopeVideoGenerationTask({
        allowPrivateNetwork,
        baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
        defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
        dispatcherPolicy,
        fetchFn,
        headers,
        model,
        providerLabel: "Qwen",
        req,
        timeoutMs: req.timeoutMs,
        url: `${resolveDashscopeAigcApiBaseUrl(baseUrl)}/api/v1/services/aigc/video-generation/video-synthesis`,
      });
    },
    id: "qwen",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "qwen",
      }),
    label: "Qwen Cloud",
    models: [...DASHSCOPE_WAN_VIDEO_MODELS],
  };
}
