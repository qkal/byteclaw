import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  type QaProviderMode,
  defaultQaModelForMode,
  isQaFastModeModelRef,
  normalizeQaProviderMode,
  splitQaModelRef,
} from "./model-selection.js";

export const DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:18789",
  "http://localhost:18789",
  "http://127.0.0.1:43124",
  "http://localhost:43124",
]);

export type QaThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

export function normalizeQaThinkingLevel(input: unknown): QaThinkingLevel | undefined {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  const collapsed = value.replace(/[\s_-]+/g, "");
  if (collapsed === "off") {
    return "off";
  }
  if (collapsed === "minimal" || collapsed === "min") {
    return "minimal";
  }
  if (collapsed === "low") {
    return "low";
  }
  if (collapsed === "medium" || collapsed === "med") {
    return "medium";
  }
  if (collapsed === "high") {
    return "high";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  return undefined;
}

export function mergeQaControlUiAllowedOrigins(extraOrigins?: string[]) {
  const normalizedExtra = (extraOrigins ?? [])
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([...DEFAULT_QA_CONTROL_UI_ALLOWED_ORIGINS, ...normalizedExtra])];
}

export function buildQaGatewayConfig(params: {
  bind: "loopback" | "lan";
  gatewayPort: number;
  gatewayToken: string;
  providerBaseUrl?: string;
  qaBusBaseUrl: string;
  workspaceDir: string;
  controlUiRoot?: string;
  controlUiAllowedOrigins?: string[];
  controlUiEnabled?: boolean;
  providerMode?: QaProviderMode | "live-openai";
  primaryModel?: string;
  alternateModel?: string;
  imageGenerationModel?: string | null;
  enabledProviderIds?: string[];
  enabledPluginIds?: string[];
  liveProviderConfigs?: Record<string, ModelProviderConfig>;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
}): OpenClawConfig {
  const mockProviderBaseUrl = params.providerBaseUrl ?? "http://127.0.0.1:44080/v1";
  const mockOpenAiProvider: ModelProviderConfig = {
    api: "openai-responses",
    apiKey: "test",
    baseUrl: mockProviderBaseUrl,
    models: [
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
        },
        id: "gpt-5.4",
        input: ["text", "image"],
        maxTokens: 4096,
        name: "gpt-5.4",
        reasoning: false,
      },
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
        },
        id: "gpt-5.4-alt",
        input: ["text", "image"],
        maxTokens: 4096,
        name: "gpt-5.4-alt",
        reasoning: false,
      },
      {
        api: "openai-responses",
        contextWindow: 128_000,
        cost: {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
        },
        id: "gpt-image-1",
        input: ["text"],
        maxTokens: 4096,
        name: "gpt-image-1",
        reasoning: false,
      },
    ],
  };
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "mock-openai");
  const primaryModel = params.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
  const modelProviderIds = [primaryModel, alternateModel]
    .map((ref) => splitQaModelRef(ref)?.provider)
    .filter((provider): provider is string => Boolean(provider));
  const imageGenerationModelRef =
    params.imageGenerationModel !== undefined
      ? params.imageGenerationModel
      : providerMode === "mock-openai"
        ? "mock-openai/gpt-image-1"
        : modelProviderIds.includes("openai")
          ? "openai/gpt-image-1"
          : null;
  const selectedProviderIds =
    providerMode === "live-frontier"
      ? [
          ...new Set(
            [...(params.enabledProviderIds ?? []), ...modelProviderIds, imageGenerationModelRef]
              .map((value) =>
                typeof value === "string" ? (splitQaModelRef(value)?.provider ?? value) : null,
              )
              .filter((provider): provider is string => Boolean(provider)),
          ),
        ]
      : [];
  const selectedPluginIds =
    providerMode === "live-frontier"
      ? [
          ...new Set(
            (params.enabledPluginIds?.length ?? 0) > 0
              ? params.enabledPluginIds
              : selectedProviderIds,
          ),
        ]
      : [];
  const pluginEntries =
    providerMode === "live-frontier"
      ? Object.fromEntries(selectedPluginIds.map((pluginId) => [pluginId, { enabled: true }]))
      : {};
  const allowedPlugins =
    providerMode === "live-frontier"
      ? ["memory-core", ...selectedPluginIds, "qa-channel"]
      : ["memory-core", "qa-channel"];
  const liveModelParams =
    providerMode === "live-frontier"
      ? (modelRef: string) => ({
          openaiWsWarmup: false,
          transport: "sse",
          ...(params.fastMode === true || isQaFastModeModelRef(modelRef) ? { fastMode: true } : {}),
          ...(params.thinkingDefault ? { thinking: params.thinkingDefault } : {}),
        })
      : (_modelRef: string) => ({
          openaiWsWarmup: false,
          transport: "sse",
        });
  const allowedOrigins = mergeQaControlUiAllowedOrigins(params.controlUiAllowedOrigins);
  const liveProviderConfigs =
    providerMode === "live-frontier" ? (params.liveProviderConfigs ?? {}) : {};
  const hasLiveProviderConfigs = Object.keys(liveProviderConfigs).length > 0;

  return {
    plugins: {
      allow: allowedPlugins,
      entries: {
        acpx: {
          enabled: false,
        },
        "memory-core": {
          enabled: true,
        },
        ...pluginEntries,
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: {
          primary: primaryModel,
        },
        ...(imageGenerationModelRef
          ? {
              imageGenerationModel: {
                primary: imageGenerationModelRef,
              },
            }
          : {}),
        ...(params.thinkingDefault ? { thinkingDefault: params.thinkingDefault } : {}),
        memorySearch: {
          sync: {
            onSearch: true,
            onSessionStart: true,
            watch: true,
            watchDebounceMs: 25,
          },
        },
        models: {
          [primaryModel]: {
            params: liveModelParams(primaryModel),
          },
          [alternateModel]: {
            params: liveModelParams(alternateModel),
          },
        },
        subagents: {
          allowAgents: ["*"],
          maxConcurrent: 2,
        },
      },
      list: [
        {
          default: true,
          id: "qa",
          identity: {
            avatar: "avatars/c3po.png",
            emoji: "🤖",
            name: "C-3PO QA",
            theme: "Flustered Protocol Droid",
          },
          model: {
            primary: primaryModel,
          },
          subagents: {
            allowAgents: ["*"],
          },
        },
      ],
    },
    memory: {
      backend: "builtin",
    },
    ...(providerMode === "mock-openai"
      ? {
          models: {
            mode: "replace",
            providers: {
              "mock-openai": mockOpenAiProvider,
            },
          },
        }
      : (hasLiveProviderConfigs
        ? {
            models: {
              mode: "merge",
              providers: liveProviderConfigs,
            },
          }
        : {})),
    gateway: {
      auth: {
        mode: "token",
        token: params.gatewayToken,
      },
      bind: params.bind,
      controlUi: {
        enabled: params.controlUiEnabled ?? true,
        ...((params.controlUiEnabled ?? true) && params.controlUiRoot
          ? { root: params.controlUiRoot }
          : {}),
        ...((params.controlUiEnabled ?? true)
          ? {
              allowInsecureAuth: true,
              allowedOrigins,
            }
          : {}),
      },
      mode: "local",
      port: params.gatewayPort,
      reload: {
        // QA restart scenarios need deterministic reload timing instead of the
        // Much longer production deferral window.
        deferralTimeoutMs: 1000,
      },
    },
    discovery: {
      mdns: {
        mode: "off",
      },
    },
    channels: {
      "qa-channel": {
        allowFrom: ["*"],
        baseUrl: params.qaBusBaseUrl,
        botDisplayName: "OpenClaw QA",
        botUserId: "openclaw",
        enabled: true,
        pollTimeoutMs: 250,
      },
    },
    messages: {
      groupChat: {
        mentionPatterns: [String.raw`\b@?openclaw\b`],
      },
    },
  } satisfies OpenClawConfig;
}
