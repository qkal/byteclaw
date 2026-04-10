import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { postJson } from "./post-json.js";

export async function fetchRemoteEmbeddingVectors(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
}): Promise<number[][]> {
  return await postJson({
    body: params.body,
    errorPrefix: params.errorPrefix,
    headers: params.headers,
    parse: (payload) => {
      const typedPayload = payload as {
        data?: { embedding?: number[] }[];
      };
      const data = typedPayload.data ?? [];
      return data.map((entry) => entry.embedding ?? []);
    },
    ssrfPolicy: params.ssrfPolicy,
    url: params.url,
  });
}
