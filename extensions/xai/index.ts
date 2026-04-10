import { Type } from "@sinclair/typebox";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { jsonResult, readProviderEnvValue } from "openclaw/plugin-sdk/provider-web-search";
import {
  applyXaiModelCompat,
  normalizeXaiModelId,
  resolveXaiModelCompatPatch,
  resolveXaiTransport,
  shouldContributeXaiCompat,
} from "./api.js";
import { XAI_DEFAULT_MODEL_REF, applyXaiConfig } from "./onboard.js";
import { buildXaiProvider } from "./provider-catalog.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { resolveFallbackXaiAuth } from "./src/tool-auth-shared.js";
import { resolveEffectiveXSearchConfig } from "./src/x-search-config.js";
import { wrapXaiProviderStream } from "./stream.js";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";
import { createXaiWebSearchProvider } from "./web-search.js";
import {
  buildMissingXSearchApiKeyPayload,
  createXSearchToolDefinition,
} from "./x-search-tool-shared.js";

const PROVIDER_ID = "xai";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

function hasResolvableXaiApiKey(config: unknown): boolean {
  return Boolean(
    resolveFallbackXaiAuth(config as never)?.apiKey || readProviderEnvValue(["XAI_API_KEY"]),
  );
}

function isCodeExecutionEnabled(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return hasResolvableXaiApiKey(config);
  }
  const entries = (config as Record<string, unknown>).plugins;
  const pluginEntries =
    entries && typeof entries === "object"
      ? ((entries as Record<string, unknown>).entries as Record<string, unknown> | undefined)
      : undefined;
  const xaiEntry =
    pluginEntries && typeof pluginEntries.xai === "object"
      ? (pluginEntries.xai as Record<string, unknown>)
      : undefined;
  const pluginConfig =
    xaiEntry && typeof xaiEntry.config === "object"
      ? (xaiEntry.config as Record<string, unknown>)
      : undefined;
  const codeExecution =
    pluginConfig && typeof pluginConfig.codeExecution === "object"
      ? (pluginConfig.codeExecution as Record<string, unknown>)
      : undefined;
  if (codeExecution?.enabled === false) {
    return false;
  }
  return hasResolvableXaiApiKey(config);
}

function isXSearchEnabled(config: unknown): boolean {
  const resolved =
    config && typeof config === "object"
      ? resolveEffectiveXSearchConfig(config as never)
      : undefined;
  if (resolved?.enabled === false) {
    return false;
  }
  return hasResolvableXaiApiKey(config);
}

function createLazyCodeExecutionTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  if (!isCodeExecutionEnabled(effectiveConfig)) {
    return null;
  }

  return {
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    execute: async (toolCallId: string, args: Record<string, unknown>) => {
      const { createCodeExecutionTool } = await import("./code-execution.js");
      const tool = createCodeExecutionTool({
        config: ctx.config as never,
        runtimeConfig: (ctx.runtimeConfig as never) ?? null,
      });
      if (!tool) {
        return jsonResult({
          docs: "https://docs.openclaw.ai/tools/code-execution",
          error: "missing_xai_api_key",
          message:
            "code_execution needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
        });
      }
      return await tool.execute(toolCallId, args);
    },
    label: "Code Execution",
    name: "code_execution",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
  };
}

function createLazyXSearchTool(ctx: {
  config?: Record<string, unknown>;
  runtimeConfig?: Record<string, unknown>;
}) {
  const effectiveConfig = ctx.runtimeConfig ?? ctx.config;
  if (!isXSearchEnabled(effectiveConfig)) {
    return null;
  }

  return createXSearchToolDefinition(async (toolCallId: string, args: Record<string, unknown>) => {
    const { createXSearchTool } = await import("./x-search.js");
    const tool = createXSearchTool({
      config: ctx.config as never,
      runtimeConfig: (ctx.runtimeConfig as never) ?? null,
    });
    if (!tool) {
      return jsonResult(buildMissingXSearchApiKeyPayload());
    }
    return await tool.execute(toolCallId, args);
  });
}

export default defineSingleProviderPluginEntry({
  description: "Bundled xAI plugin",
  id: "xai",
  name: "xAI Plugin",
  provider: {
    label: "xAI",
    aliases: ["x-ai"],
    docsPath: "/providers/xai",
    auth: [
      {
        applyConfig: (cfg) => applyXaiConfig(cfg),
        defaultModel: XAI_DEFAULT_MODEL_REF,
        envVar: "XAI_API_KEY",
        flagName: "--xai-api-key",
        hint: "API key",
        label: "xAI API key",
        methodId: "api-key",
        optionKey: "xaiApiKey",
        promptMessage: "Enter xAI API key",
        wizard: {
          groupLabel: "xAI (Grok)",
        },
      },
    ],
    catalog: {
      buildProvider: buildXaiProvider,
    },
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    prepareExtraParams: (ctx) => {
      const { extraParams } = ctx;
      if (extraParams && extraParams.tool_stream !== undefined) {
        return extraParams;
      }
      return {
        ...extraParams,
        tool_stream: true,
      };
    },
    wrapStreamFn: wrapXaiProviderStream,
    // Provider-specific fallback auth stays owned by the xAI plugin so core
    // Auth/discovery code can consume it generically without parsing xAI's
    // Private config layout. Callers may receive a real key from the active
    // Runtime snapshot or a non-secret SecretRef marker from source config.
    resolveSyntheticAuth: ({ config }) => {
      const fallbackAuth = resolveFallbackXaiAuth(config);
      if (!fallbackAuth) {
        return undefined;
      }
      return {
        apiKey: fallbackAuth.apiKey,
        mode: "api-key" as const,
        source: fallbackAuth.source,
      };
    },
    normalizeResolvedModel: ({ model }) => applyXaiModelCompat(model),
    normalizeTransport: ({ provider, api, baseUrl }) =>
      resolveXaiTransport({ api, baseUrl, provider }),
    contributeResolvedModelCompat: ({ modelId, model }) =>
      shouldContributeXaiCompat({ model, modelId }) ? resolveXaiModelCompatPatch() : undefined,
    normalizeModelId: ({ modelId }) => normalizeXaiModelId(modelId),
    resolveDynamicModel: (ctx) => resolveXaiForwardCompatModel({ ctx, providerId: PROVIDER_ID }),
    isModernModelRef: ({ modelId }) => isModernXaiModel(modelId),
  },
  register(api) {
    api.registerWebSearchProvider(createXaiWebSearchProvider());
    api.registerVideoGenerationProvider(buildXaiVideoGenerationProvider());
    api.registerTool((ctx) => createLazyCodeExecutionTool(ctx), { name: "code_execution" });
    api.registerTool((ctx) => createLazyXSearchTool(ctx), { name: "x_search" });
  },
});
