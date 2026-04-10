import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    init: {
      body: JSON.stringify(params.body),
      headers: params.headers,
      method: "POST",
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
        };
        if (params.attachStatus) {
          err.status = res.status;
        }
        throw err;
      }
      return await params.parse(await res.json());
    },
    ssrfPolicy: params.ssrfPolicy,
    url: params.url,
  });
}
