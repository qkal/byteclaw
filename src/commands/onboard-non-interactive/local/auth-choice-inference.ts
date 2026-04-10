import type { OpenClawConfig } from "../../../config/config.js";
import { resolveManifestProviderOnboardAuthFlags } from "../../../plugins/provider-auth-choices.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { CORE_ONBOARD_AUTH_FLAGS } from "../../onboard-core-auth-flags.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";

interface AuthChoiceFlag {
  optionKey: string;
  authChoice: AuthChoice;
  label: string;
}

export interface AuthChoiceInference {
  choice?: AuthChoice;
  matches: AuthChoiceFlag[];
}

function hasStringValue(value: unknown): boolean {
  return typeof value === "string" ? Boolean(normalizeOptionalString(value)) : Boolean(value);
}

// Infer auth choice from explicit provider API key flags.
export function inferAuthChoiceFromFlags(
  opts: OnboardOptions,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): AuthChoiceInference {
  const flags = [
    ...CORE_ONBOARD_AUTH_FLAGS,
    ...resolveManifestProviderOnboardAuthFlags({
      config: params?.config,
      env: params?.env,
      includeUntrustedWorkspacePlugins: false,
      workspaceDir: params?.workspaceDir,
    }),
  ] as readonly {
    optionKey: string;
    authChoice: string;
    cliFlag: string;
  }[];
  const matches: AuthChoiceFlag[] = flags
    .filter(({ optionKey }) => hasStringValue(opts[optionKey]))
    .map((flag) => ({
      authChoice: flag.authChoice as AuthChoice,
      label: flag.cliFlag,
      optionKey: flag.optionKey,
    }));

  if (
    hasStringValue(opts.customBaseUrl) ||
    hasStringValue(opts.customModelId) ||
    hasStringValue(opts.customApiKey)
  ) {
    matches.push({
      authChoice: "custom-api-key",
      label: "--custom-base-url/--custom-model-id/--custom-api-key",
      optionKey: "customBaseUrl",
    });
  }

  return {
    choice: matches[0]?.authChoice,
    matches,
  };
}
