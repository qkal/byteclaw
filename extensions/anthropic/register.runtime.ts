import { formatCliCommand, parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";
import type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  type AuthProfileStore,
  type OpenClawConfig as ProviderAuthConfig,
  type ProviderAuthResult,
  applyAuthProfileConfig,
  buildTokenProfileId,
  createProviderApiKeyAuthMethod,
  listProfilesForProvider,
  suggestOAuthProfileIdForLegacyDefault,
  upsertAuthProfile,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchClaudeUsage } from "openclaw/plugin-sdk/provider-usage";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import * as claudeCliAuth from "./cli-auth-seam.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { buildAnthropicCliMigrationResult } from "./cli-migration.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
} from "./cli-shared.js";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from "./config-defaults.js";
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildAnthropicReplayPolicy } from "./replay-policy.js";
import { wrapAnthropicProviderStream } from "./stream-wrappers.js";

const PROVIDER_ID = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;
const _ANTHROPIC_OAUTH_ALLOWLIST = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
] as const;
const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
  "Anthropic setup-token auth is supported in OpenClaw.",
  "OpenClaw prefers Claude CLI reuse when it is available on the host.",
  "Anthropic staff told us this OpenClaw path is allowed again.",
  `If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`,
] as const;

function normalizeAnthropicSetupTokenInput(value: string): string {
  return value.replaceAll(/\s+/g, "").trim();
}

function resolveAnthropicSetupTokenProfileId(rawProfileId?: unknown): string {
  if (typeof rawProfileId === "string") {
    const trimmed = rawProfileId.trim();
    if (trimmed.length > 0) {
      if (trimmed.startsWith(`${PROVIDER_ID}:`)) {
        return trimmed;
      }
      return buildTokenProfileId({ name: trimmed, provider: PROVIDER_ID });
    }
  }
  return `${PROVIDER_ID}:default`;
}

function resolveAnthropicSetupTokenExpiry(rawExpiresIn?: unknown): number | undefined {
  if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) {
    return undefined;
  }
  return Date.now() + parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" });
}

async function runAnthropicSetupTokenAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const providedToken =
    typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0
      ? normalizeAnthropicSetupTokenInput(ctx.opts.token)
      : undefined;
  const token =
    providedToken ??
    normalizeAnthropicSetupTokenInput(
      await ctx.prompter.text({
        message: "Paste Anthropic setup-token",
        validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value)),
      }),
    );
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);

  return {
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES],
    profiles: [
      {
        credential: {
          provider: PROVIDER_ID,
          token,
          type: "token",
          ...(expires ? { expires } : {}),
        },
        profileId,
      },
    ],
  };
}

async function runAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<ProviderAuthConfig | null> {
  const rawToken =
    typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";
  const tokenError = validateAnthropicSetupToken(rawToken);
  if (tokenError) {
    ctx.runtime.error(
      ["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join(
        "\n",
      ),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);
  upsertAuthProfile({
    agentDir: ctx.agentDir,
    credential: {
      provider: PROVIDER_ID,
      token: rawToken,
      type: "token",
      ...(expires ? { expires } : {}),
    },
    profileId,
  });

  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);

  const withProfile = applyAuthProfileConfig(ctx.config, {
    mode: "token",
    profileId,
    provider: PROVIDER_ID,
  });
  const existingModelConfig =
    withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object"
      ? withProfile.agents.defaults.model
      : {};
  return {
    ...withProfile,
    agents: {
      ...withProfile.agents,
      defaults: {
        ...withProfile.agents?.defaults,
        model: {
          ...existingModelConfig,
          primary: DEFAULT_ANTHROPIC_MODEL,
        },
      },
    },
  };
}

function resolveAnthropic46ForwardCompatModel(params: {
  ctx: ProviderResolveDynamicModelContext;
  dashModelId: string;
  dotModelId: string;
  dashTemplateId: string;
  dotTemplateId: string;
  fallbackTemplateIds: readonly string[];
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.ctx.modelId.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
  const is46Model =
    lower === params.dashModelId ||
    lower === params.dotModelId ||
    lower.startsWith(`${params.dashModelId}-`) ||
    lower.startsWith(`${params.dotModelId}-`);
  if (!is46Model) {
    return undefined;
  }

  const templateIds: string[] = [];
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
  }
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
  }
  templateIds.push(...params.fallbackTemplateIds);

  return cloneFirstTemplateModel({
    ctx: params.ctx,
    modelId: trimmedModelId,
    patch:
      normalizeLowercaseStringOrEmpty(params.ctx.provider) === CLAUDE_CLI_BACKEND_ID
        ? { provider: CLAUDE_CLI_BACKEND_ID }
        : undefined,
    providerId: PROVIDER_ID,
    templateIds,
  });
}

function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dashTemplateId: "claude-opus-4-5",
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dotTemplateId: "claude-opus-4.5",
      fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    }) ??
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dashTemplateId: "claude-sonnet-4-5",
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dotTemplateId: "claude-sonnet-4.5",
      fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    })
  );
}

function shouldUseAnthropicAdaptiveThinkingDefault(modelId: string): boolean {
  const lowerModelId = normalizeLowercaseStringOrEmpty(modelId);
  return (
    lowerModelId.startsWith(ANTHROPIC_OPUS_46_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_OPUS_46_DOT_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_SONNET_46_MODEL_ID) ||
    lowerModelId.startsWith(ANTHROPIC_SONNET_46_DOT_MODEL_ID)
  );
}

function matchesAnthropicModernModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return ANTHROPIC_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function buildAnthropicAuthDoctorHint(params: {
  config?: ProviderAuthContext["config"];
  store: AuthProfileStore;
  profileId?: string;
}): string {
  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    legacyProfileId,
    provider: PROVIDER_ID,
    store: params.store,
  });
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

function resolveClaudeCliSyntheticAuth() {
  const credential = claudeCliAuth.readClaudeCliCredentialsForRuntime();
  if (!credential) {
    return undefined;
  }
  return credential.type === "oauth"
    ? {
        apiKey: credential.access,
        mode: "oauth" as const,
        source: "Claude CLI native auth",
      }
    : {
        apiKey: credential.token,
        mode: "token" as const,
        source: "Claude CLI native auth",
      };
}

async function runAnthropicCliMigration(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetup();
  if (!credential) {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  return buildAnthropicCliMigrationResult(ctx.config, credential);
}

async function runAnthropicCliMigrationNonInteractive(ctx: {
  config: ProviderAuthContext["config"];
  runtime: ProviderAuthContext["runtime"];
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetupNonInteractive();
  if (!credential) {
    ctx.runtime.error(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        `Run ${formatCliCommand("claude auth login")} first.`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }

  const result = buildAnthropicCliMigrationResult(ctx.config, credential);
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;
  const migratedModel = result.configPatch?.agents?.defaults?.model;
  const migratedFallbacks =
    migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel
      ? migratedModel.fallbacks
      : undefined;
  const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;

  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          ...(Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {}),
          primary: result.defaultModel,
        },
      },
    },
  };
}

export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  const providerId = "anthropic";
  const defaultAnthropicModel = "anthropic/claude-sonnet-4-6";
  const _anthropicOauthAllowlist = [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
  ] as const;
  api.registerCliBackend(buildAnthropicCliBackend());
  api.registerProvider({
    applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
    auth: [
      {
        hint: "Reuse a local Claude CLI login and switch model selection to claude-cli/*",
        id: "cli",
        kind: "custom",
        label: "Claude CLI",
        run: async (ctx: ProviderAuthContext) => await runAnthropicCliMigration(ctx),
        runNonInteractive: async (ctx) =>
          await runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
            agentDir: ctx.agentDir,
          }),
        wizard: {
          assistantPriority: -20,
          choiceHint: "Reuse a local Claude CLI login on this host",
          choiceId: "anthropic-cli",
          choiceLabel: "Anthropic Claude CLI",
          groupHint: "Claude CLI + API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          modelAllowlist: {
            allowedKeys: [...CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS],
            initialSelections: [CLAUDE_CLI_DEFAULT_MODEL_REF],
            message: "Claude CLI models",
          },
        },
      },
      {
        hint: "Manual bearer token path",
        id: "setup-token",
        kind: "token",
        label: "Anthropic setup-token",
        run: async (ctx: ProviderAuthContext) => await runAnthropicSetupTokenAuth(ctx),
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await runAnthropicSetupTokenNonInteractive(ctx),
        wizard: {
          assistantPriority: 40,
          choiceHint: "Manual token path",
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          groupHint: "Claude CLI + API key + token",
          groupId: "anthropic",
          groupLabel: "Anthropic",
        },
      },
      createProviderApiKeyAuthMethod({
        defaultModel: defaultAnthropicModel,
        envVar: "ANTHROPIC_API_KEY",
        expectedProviders: ["anthropic"],
        flagName: "--anthropic-api-key",
        hint: "Direct Anthropic API key",
        label: "Anthropic API key",
        methodId: "api-key",
        optionKey: "anthropicApiKey",
        promptMessage: "Enter Anthropic API key",
        providerId,
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupHint: "Claude CLI + API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
        },
      }),
    ],
    buildAuthDoctorHint: (ctx) =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        profileId: ctx.profileId,
        store: ctx.store,
      }),
    buildReplayPolicy: buildAnthropicReplayPolicy,
    docsPath: "/providers/models",
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    fetchUsageSnapshot: async (ctx) =>
      await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    hookAliases: [CLAUDE_CLI_BACKEND_ID],
    id: providerId,
    isCacheTtlEligible: () => true,
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    label: "Anthropic",
    normalizeConfig: ({ providerConfig }) => normalizeAnthropicProviderConfig(providerConfig),
    oauthProfileIdRepairs: [
      {
        legacyProfileId: "anthropic:default",
        promptLabel: "Anthropic",
      },
    ],
    resolveDefaultThinkingLevel: ({ modelId }) =>
      matchesAnthropicModernModel(modelId) && shouldUseAnthropicAdaptiveThinkingDefault(modelId)
        ? "adaptive"
        : undefined,
    resolveDynamicModel: (ctx) => resolveAnthropicForwardCompatModel(ctx),
    resolveReasoningOutputMode: () => "native",
    resolveSyntheticAuth: ({ provider }) =>
      normalizeLowercaseStringOrEmpty(provider) === CLAUDE_CLI_BACKEND_ID
        ? resolveClaudeCliSyntheticAuth()
        : undefined,
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    wrapStreamFn: wrapAnthropicProviderStream,
  });
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
