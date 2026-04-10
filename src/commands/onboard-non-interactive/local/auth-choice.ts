import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveManifestDeprecatedProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
} from "../../auth-choice-legacy.js";
import { normalizeSecretInputModeInput } from "../../auth-choice.apply-helpers.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "../../auth-choice.apply.api-providers.js";
import {
  CustomApiError,
  applyCustomApiConfig,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

type ResolvedNonInteractiveApiKey = NonNullable<
  Awaited<ReturnType<typeof resolveNonInteractiveApiKey>>
>;

export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}): Promise<OpenClawConfig | null> {
  const { opts, runtime, baseConfig } = params;
  const authChoice = normalizeApiKeyTokenProviderAuthChoice({
    authChoice: params.authChoice,
    config: params.nextConfig,
    env: process.env,
    tokenProvider: opts.tokenProvider,
  });
  const { nextConfig } = params;
  const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
  if (opts.secretInputMode && !requestedSecretInputMode) {
    runtime.error('Invalid --secret-input-mode. Use "plaintext" or "ref".');
    runtime.exit(1);
    return null;
  }
  const toStoredSecretInput = (resolved: ResolvedNonInteractiveApiKey): SecretInput | null => {
    const storePlaintextSecret = requestedSecretInputMode !== "ref"; // Pragma: allowlist secret
    if (storePlaintextSecret) {
      return resolved.key;
    }
    if (resolved.source !== "env") {
      return resolved.key;
    }
    if (!resolved.envVarName) {
      runtime.error(
        [
          `Unable to determine which environment variable to store as a ref for provider "${authChoice}".`,
          "Set an explicit provider env var and retry, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      runtime.exit(1);
      return null;
    }
    return {
      id: resolved.envVarName,
      provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
        preferFirstProviderForSource: true,
      }),
      source: "env",
    };
  };
  const resolveApiKey = (input: Parameters<typeof resolveNonInteractiveApiKey>[0]) =>
    resolveNonInteractiveApiKey({
      ...input,
      secretInputMode: requestedSecretInputMode,
    });
  const toApiKeyCredential = (params: {
    provider: string;
    resolved: ResolvedNonInteractiveApiKey;
    email?: string;
    metadata?: Record<string, string>;
  }): ApiKeyCredential | null => {
    const storeSecretRef = requestedSecretInputMode === "ref" && params.resolved.source === "env"; // Pragma: allowlist secret
    if (storeSecretRef) {
      if (!params.resolved.envVarName) {
        runtime.error(
          [
            `--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`,
            "Set the provider API key env var and retry, or use --secret-input-mode plaintext.",
          ].join("\n"),
        );
        runtime.exit(1);
        return null;
      }
      return {
        keyRef: {
          id: params.resolved.envVarName,
          provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
            preferFirstProviderForSource: true,
          }),
          source: "env",
        },
        provider: params.provider,
        type: "api_key",
        ...(params.email ? { email: params.email } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };
    }
    return {
      key: params.resolved.key,
      provider: params.provider,
      type: "api_key",
      ...(params.email ? { email: params.email } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  };
  if (isDeprecatedAuthChoice(authChoice, { config: nextConfig, env: process.env })) {
    runtime.error(
      formatDeprecatedNonInteractiveAuthChoiceError(authChoice, {
        config: nextConfig,
        env: process.env,
      })!,
    );
    runtime.exit(1);
    return null;
  }

  const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
    authChoice,
    baseConfig,
    nextConfig,
    opts,
    resolveApiKey: (input) =>
      resolveApiKey({
        ...input,
        cfg: baseConfig,
        runtime,
      }),
    runtime,
    toApiKeyCredential,
  });
  if (pluginProviderChoice !== undefined) {
    return pluginProviderChoice;
  }

  if (authChoice === "setup-token" || authChoice === "token") {
    runtime.error(
      [
        `Auth choice "${params.authChoice}" was not matched to a provider setup flow.`,
        'For Anthropic legacy token auth, use "--auth-choice setup-token --token-provider anthropic --token <token>" or pass "--auth-choice token --token-provider anthropic".',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  const deprecatedChoice = resolveManifestDeprecatedProviderAuthChoice(authChoice as string, {
    config: nextConfig,
    env: process.env,
  });
  if (deprecatedChoice) {
    runtime.error(
      `"${authChoice as string}" is no longer supported. Use --auth-choice ${deprecatedChoice.choiceId} instead.`,
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "custom-api-key") {
    try {
      const customAuth = parseNonInteractiveCustomApiFlags({
        apiKey: opts.customApiKey,
        baseUrl: opts.customBaseUrl,
        compatibility: opts.customCompatibility,
        modelId: opts.customModelId,
        providerId: opts.customProviderId,
      });
      const resolvedProviderId = resolveCustomProviderId({
        baseUrl: customAuth.baseUrl,
        config: nextConfig,
        providerId: customAuth.providerId,
      });
      const resolvedCustomApiKey = await resolveApiKey({
        cfg: baseConfig,
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        flagName: "--custom-api-key",
        flagValue: customAuth.apiKey,
        provider: resolvedProviderId.providerId,
        required: false,
        runtime,
      });
      let customApiKeyInput: SecretInput | undefined;
      if (resolvedCustomApiKey) {
        const storeCustomApiKeyAsRef = requestedSecretInputMode === "ref"; // Pragma: allowlist secret
        if (storeCustomApiKeyAsRef) {
          const stored = toStoredSecretInput(resolvedCustomApiKey);
          if (!stored) {
            return null;
          }
          customApiKeyInput = stored;
        } else {
          customApiKeyInput = resolvedCustomApiKey.key;
        }
      }
      const result = applyCustomApiConfig({
        apiKey: customApiKeyInput,
        baseUrl: customAuth.baseUrl,
        compatibility: customAuth.compatibility,
        config: nextConfig,
        modelId: customAuth.modelId,
        providerId: customAuth.providerId,
      });
      if (result.providerIdRenamedFrom && result.providerId) {
        runtime.log(
          `Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
        );
      }
      return result.config;
    } catch (error) {
      if (error instanceof CustomApiError) {
        switch (error.code) {
          case "missing_required":
          case "invalid_compatibility": {
            runtime.error(error.message);
            break;
          }
          default: {
            runtime.error(`Invalid custom provider config: ${error.message}`);
            break;
          }
        }
        runtime.exit(1);
        return null;
      }
      const reason = formatErrorMessage(error);
      runtime.error(`Invalid custom provider config: ${reason}`);
      runtime.exit(1);
      return null;
    }
  }

  if (
    authChoice === "oauth" ||
    authChoice === "chutes" ||
    authChoice === "minimax-global-oauth" ||
    authChoice === "minimax-cn-oauth"
  ) {
    runtime.error(
      authChoice === "oauth"
        ? 'Auth choice "oauth" is no longer supported directly. Use "--auth-choice setup-token --token-provider anthropic" for Anthropic legacy token auth, or a provider-specific OAuth choice.'
        : "OAuth requires interactive mode.",
    );
    runtime.exit(1);
    return null;
  }

  return nextConfig;
}
