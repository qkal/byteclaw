import type { Api, Model } from "@mariozechner/pi-ai";
import { getApiKeyForModel, resolveApiKeyForProvider } from "../../agents/model-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import { prepareProviderRuntimeAuth } from "../provider-runtime.runtime.js";
import type { ResolvedProviderRuntimeAuth } from "./model-auth-types.js";

export { getApiKeyForModel, resolveApiKeyForProvider };

/**
 * Resolve request-ready auth for a runtime model, applying any provider-owned
 * `prepareRuntimeAuth` exchange on top of the standard credential lookup.
 */
export async function getRuntimeAuthForModel(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<ResolvedProviderRuntimeAuth> {
  const resolvedAuth = await getApiKeyForModel({
    cfg: params.cfg,
    model: params.model,
  });

  if (!resolvedAuth.apiKey || resolvedAuth.mode === "aws-sdk") {
    return resolvedAuth;
  }

  const preparedAuth = await prepareProviderRuntimeAuth({
    config: params.cfg,
    context: {
      apiKey: resolvedAuth.apiKey,
      authMode: resolvedAuth.mode,
      config: params.cfg,
      env: process.env,
      model: params.model,
      modelId: params.model.id,
      profileId: resolvedAuth.profileId,
      provider: params.model.provider,
      workspaceDir: params.workspaceDir,
    },
    env: process.env,
    provider: params.model.provider,
    workspaceDir: params.workspaceDir,
  });

  if (!preparedAuth) {
    return resolvedAuth;
  }

  return {
    ...resolvedAuth,
    ...preparedAuth,
    apiKey: preparedAuth.apiKey ?? resolvedAuth.apiKey,
  };
}
