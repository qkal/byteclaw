import { requireApiKey, resolveApiKeyForProvider } from "../../../../src/agents/model-auth.js";
import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import type { EmbeddingProviderOptions } from "./embeddings.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const { remote } = params.options;
  const remoteApiKey = resolveMemorySecretInputString({
    path: "agents.*.memorySearch.remote.apiKey",
    value: remote?.apiKey,
  });
  const remoteBaseUrl = remote?.baseUrl?.trim();
  const providerConfig = params.options.config.models?.providers?.[params.provider];
  const apiKey = remoteApiKey
    ? remoteApiKey
    : requireApiKey(
        await resolveApiKeyForProvider({
          agentDir: params.options.agentDir,
          cfg: params.options.config,
          provider: params.provider,
        }),
        params.provider,
      );
  const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || params.defaultBaseUrl;
  const headerOverrides = { ...providerConfig?.headers, ...remote?.headers };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
