import { requireApiKey, resolveApiKeyForProvider } from "../../agents/model-auth.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { EmbeddingProviderOptions } from "./embeddings.types.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: EmbeddingProviderOptions;
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string>; ssrfPolicy?: SsrFPolicy }> {
  const {remote} = params.options;
  const remoteApiKey = resolveMemorySecretInputString({
    path: "agents.*.memorySearch.remote.apiKey",
    value: remote?.apiKey,
  });
  const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
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
  const baseUrl =
    remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
  const headerOverrides = { ...providerConfig?.headers, ...remote?.headers};
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...headerOverrides,
  };
  return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
