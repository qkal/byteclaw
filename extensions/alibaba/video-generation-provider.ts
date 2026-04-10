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

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const DEFAULT_ALIBABA_VIDEO_MODEL = DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL;

function resolveAlibabaVideoBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.alibaba?.baseUrl?.trim() || DEFAULT_ALIBABA_VIDEO_BASE_URL;
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

export function buildAlibabaVideoGenerationProvider(): VideoGenerationProvider {
  return {
    capabilities: DASHSCOPE_WAN_VIDEO_CAPABILITIES,
    defaultModel: DEFAULT_ALIBABA_VIDEO_MODEL,
    async generateVideo(req): Promise<VideoGenerationResult> {
      const fetchFn = fetch;
      const auth = await resolveApiKeyForProvider({
        agentDir: req.agentDir,
        cfg: req.cfg,
        provider: "alibaba",
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Alibaba Model Studio API key missing");
      }

      const requestBaseUrl = resolveAlibabaVideoBaseUrl(req);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: requestBaseUrl,
          capability: "video",
          defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          provider: "alibaba",
          transport: "http",
        });

      const model = req.model?.trim() || DEFAULT_ALIBABA_VIDEO_MODEL;
      return await runDashscopeVideoGenerationTask({
        allowPrivateNetwork,
        baseUrl: resolveDashscopeAigcApiBaseUrl(baseUrl),
        defaultTimeoutMs: DEFAULT_VIDEO_GENERATION_TIMEOUT_MS,
        dispatcherPolicy,
        fetchFn,
        headers,
        model,
        providerLabel: "Alibaba Wan",
        req,
        timeoutMs: req.timeoutMs,
        url: `${resolveDashscopeAigcApiBaseUrl(baseUrl)}/api/v1/services/aigc/video-generation/video-synthesis`,
      });
    },
    id: "alibaba",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        agentDir,
        provider: "alibaba",
      }),
    label: "Alibaba Model Studio",
    models: [...DASHSCOPE_WAN_VIDEO_MODELS],
  };
}
