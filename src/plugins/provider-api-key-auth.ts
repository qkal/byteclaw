import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type {
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderPluginWizardSetup,
} from "./types.js";

interface ProviderApiKeyAuthMethodOptions {
  providerId: string;
  methodId: string;
  label: string;
  hint?: string;
  wizard?: ProviderPluginWizardSetup;
  optionKey: string;
  flagName: `--${string}`;
  envVar: string;
  promptMessage: string;
  profileId?: string;
  profileIds?: string[];
  allowProfile?: boolean;
  defaultModel?: string;
  expectedProviders?: string[];
  metadata?: Record<string, string>;
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}

const loadProviderApiKeyAuthRuntime = createLazyRuntimeSurface(
  () => import("./provider-api-key-auth.runtime.js"),
  ({ providerApiKeyAuthRuntime }) => providerApiKeyAuthRuntime,
);

function resolveStringOption(opts: Record<string, unknown> | undefined, optionKey: string) {
  return normalizeOptionalSecretInput(opts?.[optionKey]);
}

function resolveProfileId(params: { providerId: string; profileId?: string }) {
  return normalizeOptionalString(params.profileId) || `${params.providerId}:default`;
}

function resolveProfileIds(params: {
  providerId: string;
  profileId?: string;
  profileIds?: string[];
}) {
  const explicit = [...new Set(normalizeStringEntries(params.profileIds ?? []))];
  if (explicit.length > 0) {
    return explicit;
  }
  return [resolveProfileId(params)];
}

async function applyApiKeyConfig(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  profileIds: string[];
  defaultModel?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const { applyAuthProfileConfig, applyPrimaryModel } = await loadProviderApiKeyAuthRuntime();
  let next = params.ctx.config;
  for (const profileId of params.profileIds) {
    next = applyAuthProfileConfig(next, {
      mode: "api_key",
      profileId,
      provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
    });
  }
  if (params.applyConfig) {
    next = params.applyConfig(next);
  }
  return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
}

export function createProviderApiKeyAuthMethod(
  params: ProviderApiKeyAuthMethodOptions,
): ProviderAuthMethod {
  return {
    hint: params.hint,
    id: params.methodId,
    kind: "api_key",
    label: params.label,
    run: async (ctx) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const flagValue = resolveStringOption(opts, params.optionKey);
      let capturedSecretInput: SecretInput | undefined;
      let capturedCredential = false;
      let capturedMode: "plaintext" | "ref" | undefined;
      const {
        buildApiKeyCredential,
        ensureApiKeyFromOptionEnvOrPrompt,
        normalizeApiKeyInput,
        validateApiKeyInput,
      } = await loadProviderApiKeyAuthRuntime();

      await ensureApiKeyFromOptionEnvOrPrompt({
        config: ctx.config,
        env: ctx.env,
        envLabel: params.envVar,
        expectedProviders: params.expectedProviders ?? [params.providerId],
        normalize: normalizeApiKeyInput,
        noteMessage: params.noteMessage,
        noteTitle: params.noteTitle,
        promptMessage: params.promptMessage,
        prompter: ctx.prompter,
        provider: params.providerId,
        secretInputMode:
          ctx.allowSecretRefPrompt === false
            ? (ctx.secretInputMode ?? "plaintext")
            : ctx.secretInputMode,
        setCredential: async (apiKey, mode) => {
          capturedSecretInput = apiKey;
          capturedCredential = true;
          capturedMode = mode;
        },
        token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
        tokenProvider: flagValue
          ? params.providerId
          : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
        validate: validateApiKeyInput,
      });

      if (!capturedCredential) {
        throw new Error(`Missing API key input for provider "${params.providerId}".`);
      }
      const credentialInput = capturedSecretInput ?? "";
      const profileIds = resolveProfileIds(params);

      return {
        profiles: profileIds.map((profileId) => ({
          credential: buildApiKeyCredential(
            normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
            credentialInput,
            params.metadata,
            capturedMode ? { secretInputMode: capturedMode } : undefined,
          ),
          profileId,
        })),
        ...(params.applyConfig ? { configPatch: params.applyConfig(ctx.config) } : {}),
        ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
      };
    },
    runNonInteractive: async (ctx) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const resolved = await ctx.resolveApiKey({
        envVar: params.envVar,
        flagName: params.flagName,
        flagValue: resolveStringOption(opts, params.optionKey),
        provider: params.providerId,
        ...(params.allowProfile === false ? { allowProfile: false } : {}),
      });
      if (!resolved) {
        return null;
      }

      const profileIds = resolveProfileIds(params);
      if (resolved.source !== "profile") {
        for (const profileId of profileIds) {
          const credential = ctx.toApiKeyCredential({
            provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
            resolved,
            ...(params.metadata ? { metadata: params.metadata } : {}),
          });
          if (!credential) {
            return null;
          }
          upsertAuthProfile({
            agentDir: ctx.agentDir,
            credential,
            profileId,
          });
        }
      }

      return await applyApiKeyConfig({
        applyConfig: params.applyConfig,
        ctx,
        defaultModel: params.defaultModel,
        profileIds,
        providerId: params.providerId,
      });
    },
    wizard: params.wizard,
  };
}
