import type { OpenClawConfig } from "../../config/config.js";
import { resolveManifestContractOwnerPluginId } from "../../plugins/manifest-registry.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  resolveWebSearchDefinition,
  resolveWebSearchProviderId,
  runWebSearch,
} from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { SEARCH_CACHE } from "./web-search-provider-common.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  const runtimeProviderId =
    options?.runtimeWebSearch?.selectedProvider ?? options?.runtimeWebSearch?.providerConfigured;
  const preferRuntimeProviders =
    Boolean(runtimeProviderId) &&
    !resolveManifestContractOwnerPluginId({
      config: options?.config,
      contract: "webSearchProviders",
      origin: "bundled",
      value: runtimeProviderId,
    });
  const resolved = resolveWebSearchDefinition({
    ...options,
    preferRuntimeProviders,
  });
  if (!resolved) {
    return null;
  }

  return {
    description: resolved.definition.description,
    execute: async (_toolCallId, args) => {
      const result = await runWebSearch({
        args,
        config: options?.config,
        preferRuntimeProviders,
        runtimeWebSearch: options?.runtimeWebSearch,
        sandboxed: options?.sandboxed,
      });
      return jsonResult({
        ...result.result,
        provider: result.provider,
      });
    },
    label: "Web Search",
    name: "web_search",
    parameters: resolved.definition.parameters,
  };
}

export const __testing = {
  SEARCH_CACHE,
  resolveSearchProvider: (search?: Parameters<typeof resolveWebSearchProviderId>[0]["search"]) =>
    resolveWebSearchProviderId({ search }),
};
