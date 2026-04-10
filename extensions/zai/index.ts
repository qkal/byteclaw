import {
  type ProviderAuthContext,
  type ProviderAuthMethod,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  type SecretInput,
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  upsertAuthProfile,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  normalizeModelCompat,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { fetchZaiUsage, resolveLegacyPiAgentAccessToken } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { type ZaiEndpointId, detectZaiEndpoint } from "./detect.js";
import { zaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildZaiModelDefinition } from "./model-definitions.js";
import { ZAI_DEFAULT_MODEL_REF, applyZaiConfig, applyZaiProviderConfig } from "./onboard.js";

const PROVIDER_ID = "zai";
const GLM5_TEMPLATE_MODEL_ID = "glm-4.7";
const PROFILE_ID = "zai:default";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});
const ZAI_TOOL_STREAM_HOOKS = buildProviderStreamFamilyHooks("tool-stream-default-on");

function resolveGlm5ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmedModelId).startsWith("glm-5")) {
    return undefined;
  }

  const existing = ctx.modelRegistry.find(
    PROVIDER_ID,
    trimmedModelId,
  ) as ProviderRuntimeModel | null;
  if (existing) {
    return existing;
  }

  const def = buildZaiModelDefinition({ id: trimmedModelId });
  const template = ctx.modelRegistry.find(
    PROVIDER_ID,
    GLM5_TEMPLATE_MODEL_ID,
  ) as ProviderRuntimeModel | null;
  return normalizeModelCompat({
    ...template,
    api: "openai-completions",
    contextWindow: def.contextWindow,
    cost: def.cost,
    id: def.id,
    input: def.input,
    maxTokens: def.maxTokens,
    name: def.name,
    provider: PROVIDER_ID,
    reasoning: def.reasoning,
  } as ProviderRuntimeModel);
}

function resolveZaiDefaultModel(modelIdOverride?: string): string {
  return modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
}

async function promptForZaiEndpoint(ctx: ProviderAuthContext): Promise<ZaiEndpointId> {
  return await ctx.prompter.select<ZaiEndpointId>({
    initialValue: "global",
    message: "Select Z.AI endpoint",
    options: [
      { hint: "Z.AI Global (api.z.ai)", label: "Global", value: "global" },
      { hint: "Z.AI CN (open.bigmodel.cn)", label: "CN", value: "cn" },
      {
        hint: "GLM Coding Plan Global (api.z.ai)",
        label: "Coding-Plan-Global",
        value: "coding-global",
      },
      {
        hint: "GLM Coding Plan CN (open.bigmodel.cn)",
        label: "Coding-Plan-CN",
        value: "coding-cn",
      },
    ],
  });
}

async function runZaiApiKeyAuth(
  ctx: ProviderAuthContext,
  endpoint?: ZaiEndpointId,
): Promise<{
  profiles: { profileId: string; credential: ReturnType<typeof buildApiKeyCredential> }[];
  configPatch: ReturnType<typeof applyZaiProviderConfig>;
  defaultModel: string;
  notes?: string[];
}> {
  let capturedSecretInput: SecretInput | undefined;
  let capturedCredential = false;
  let capturedMode: "plaintext" | "ref" | undefined;
  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    config: ctx.config,
    envLabel: "ZAI_API_KEY",
    expectedProviders: [PROVIDER_ID, "z-ai"],
    normalize: normalizeApiKeyInput,
    promptMessage: "Enter Z.AI API key",
    prompter: ctx.prompter,
    provider: PROVIDER_ID,
    secretInputMode:
      ctx.allowSecretRefPrompt === false
        ? (ctx.secretInputMode ?? "plaintext")
        : ctx.secretInputMode,
    setCredential: async (key, mode) => {
      capturedSecretInput = key;
      capturedCredential = true;
      capturedMode = mode;
    },
    token:
      normalizeOptionalSecretInput(ctx.opts?.zaiApiKey) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.zaiApiKey)
      ? PROVIDER_ID
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    validate: validateApiKeyInput,
  });
  if (!capturedCredential) {
    throw new Error("Missing Z.AI API key.");
  }
  const credentialInput = capturedSecretInput ?? "";

  const detected = await detectZaiEndpoint({ apiKey, ...(endpoint ? { endpoint } : {}) });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint ?? (await promptForZaiEndpoint(ctx));
  return {
    configPatch: applyZaiProviderConfig(ctx.config, {
      ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
      ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
    }),
    defaultModel: resolveZaiDefaultModel(modelIdOverride),
    profiles: [
      {
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          credentialInput,
          undefined,
          capturedMode ? { secretInputMode: capturedMode } : undefined,
        ),
        profileId: PROFILE_ID,
      },
    ],
    ...(detected?.note ? { notes: [detected.note] } : {}),
  };
}

async function runZaiApiKeyAuthNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  endpoint?: ZaiEndpointId,
) {
  const resolved = await ctx.resolveApiKey({
    envVar: "ZAI_API_KEY",
    flagName: "--zai-api-key",
    flagValue: normalizeOptionalSecretInput(ctx.opts.zaiApiKey),
    provider: PROVIDER_ID,
  });
  if (!resolved) {
    return null;
  }
  const detected = await detectZaiEndpoint({
    apiKey: resolved.key,
    ...(endpoint ? { endpoint } : {}),
  });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint;

  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: PROVIDER_ID,
      resolved,
    });
    if (!credential) {
      return null;
    }
    upsertAuthProfile({
      agentDir: ctx.agentDir,
      credential,
      profileId: PROFILE_ID,
    });
  }

  const next = applyAuthProfileConfig(ctx.config, {
    mode: "api_key",
    profileId: PROFILE_ID,
    provider: PROVIDER_ID,
  });
  return applyZaiConfig(next, {
    ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
    ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
  });
}

function buildZaiApiKeyMethod(params: {
  id: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  endpoint?: ZaiEndpointId;
}): ProviderAuthMethod {
  return {
    hint: params.choiceHint,
    id: params.id,
    kind: "api_key",
    label: params.choiceLabel,
    run: async (ctx) => await runZaiApiKeyAuth(ctx, params.endpoint),
    runNonInteractive: async (ctx) => await runZaiApiKeyAuthNonInteractive(ctx, params.endpoint),
    wizard: {
      choiceId: params.choiceId,
      choiceLabel: params.choiceLabel,
      ...(params.choiceHint ? { choiceHint: params.choiceHint } : {}),
      groupId: "zai",
      groupLabel: "Z.AI",
      groupHint: "GLM Coding Plan / Global / CN",
    },
  };
}

export default definePluginEntry({
  description: "Bundled Z.AI provider plugin",
  id: PROVIDER_ID,
  name: "Z.AI Provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Z.AI",
      aliases: ["z-ai", "z.ai"],
      docsPath: "/providers/models",
      envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
      auth: [
        buildZaiApiKeyMethod({
          choiceId: "zai-api-key",
          choiceLabel: "Z.AI API key",
          id: "api-key",
        }),
        buildZaiApiKeyMethod({
          choiceHint: "GLM Coding Plan Global (api.z.ai)",
          choiceId: "zai-coding-global",
          choiceLabel: "Coding-Plan-Global",
          endpoint: "coding-global",
          id: "coding-global",
        }),
        buildZaiApiKeyMethod({
          choiceHint: "GLM Coding Plan CN (open.bigmodel.cn)",
          choiceId: "zai-coding-cn",
          choiceLabel: "Coding-Plan-CN",
          endpoint: "coding-cn",
          id: "coding-cn",
        }),
        buildZaiApiKeyMethod({
          choiceHint: "Z.AI Global (api.z.ai)",
          choiceId: "zai-global",
          choiceLabel: "Global",
          endpoint: "global",
          id: "global",
        }),
        buildZaiApiKeyMethod({
          choiceHint: "Z.AI CN (open.bigmodel.cn)",
          choiceId: "zai-cn",
          choiceLabel: "CN",
          endpoint: "cn",
          id: "cn",
        }),
      ],
      resolveDynamicModel: (ctx) => resolveGlm5ForwardCompatModel(ctx),
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      prepareExtraParams: (ctx) => {
        if (ctx.extraParams?.tool_stream !== undefined) {
          return ctx.extraParams;
        }
        return {
          ...ctx.extraParams,
          tool_stream: true,
        };
      },
      ...ZAI_TOOL_STREAM_HOOKS,
      isBinaryThinking: () => true,
      isModernModelRef: ({ modelId }) => {
        const lower = normalizeLowercaseStringOrEmpty(modelId);
        return (
          lower.startsWith("glm-5") ||
          lower.startsWith("glm-4.7") ||
          lower.startsWith("glm-4.7-flash") ||
          lower.startsWith("glm-4.7-flashx")
        );
      },
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          envDirect: [ctx.env.ZAI_API_KEY, ctx.env.Z_AI_API_KEY],
          providerIds: [PROVIDER_ID, "z-ai"],
        });
        if (apiKey) {
          return { token: apiKey };
        }
        const legacyToken = resolveLegacyPiAgentAccessToken(ctx.env, ["z-ai", "zai"]);
        return legacyToken ? { token: legacyToken } : null;
      },
      fetchUsageSnapshot: async (ctx) => await fetchZaiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
      isCacheTtlEligible: () => true,
    });
    api.registerMediaUnderstandingProvider(zaiMediaUnderstandingProvider);
  },
});
