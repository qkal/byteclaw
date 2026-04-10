import { resolveProviderMatch } from "../plugins/provider-auth-choice-helpers.js";
import { resolvePluginProviders } from "../plugins/provider-auth-choice.runtime.js";
import type { ProviderAuthKind } from "../plugins/types.js";
import { normalizeTokenProviderInput } from "./auth-choice.apply-helpers.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.types.js";
import type { AuthChoice } from "./onboard-types.js";

function resolveProviderAuthChoiceByKind(params: {
  providerId: string;
  kind: ProviderAuthKind;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice | undefined {
  const provider = resolveProviderMatch(
    resolvePluginProviders({
      config: params.config,
      env: params.env,
      mode: "setup",
      workspaceDir: params.workspaceDir,
    }),
    params.providerId,
  );
  const choiceId = provider?.auth.find((method) => method.kind === params.kind)?.wizard?.choiceId;
  return choiceId as AuthChoice | undefined;
}

export function normalizeApiKeyTokenProviderAuthChoice(params: {
  authChoice: AuthChoice;
  tokenProvider?: string;
  config?: ApplyAuthChoiceParams["config"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): AuthChoice {
  if (!params.tokenProvider) {
    return params.authChoice;
  }
  const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  if (!normalizedTokenProvider) {
    return params.authChoice;
  }
  if (params.authChoice === "token" || params.authChoice === "setup-token") {
    return (
      resolveProviderAuthChoiceByKind({
        config: params.config,
        env: params.env,
        kind: "token",
        providerId: normalizedTokenProvider,
        workspaceDir: params.workspaceDir,
      }) ?? params.authChoice
    );
  }
  if (params.authChoice !== "apiKey") {
    return params.authChoice;
  }
  return (
    resolveProviderAuthChoiceByKind({
      config: params.config,
      env: params.env,
      kind: "api_key",
      providerId: normalizedTokenProvider,
      workspaceDir: params.workspaceDir,
    }) ?? params.authChoice
  );
}

export async function applyAuthChoiceApiProviders(
  _params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  return null;
}
