import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { createTransportAwareStreamFnForModel } from "./provider-transport-stream.js";

export function registerProviderStreamForModel<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): StreamFn | undefined {
  const streamFn =
    resolveProviderStreamFn({
      config: params.cfg,
      context: {
        agentDir: params.agentDir,
        config: params.cfg,
        model: params.model,
        modelId: params.model.id,
        provider: params.model.provider,
        workspaceDir: params.workspaceDir,
      },
      env: params.env,
      provider: params.model.provider,
      workspaceDir: params.workspaceDir,
    }) ?? createTransportAwareStreamFnForModel(params.model);
  if (!streamFn) {
    return undefined;
  }
  ensureCustomApiRegistered(params.model.api, streamFn);
  return streamFn;
}
