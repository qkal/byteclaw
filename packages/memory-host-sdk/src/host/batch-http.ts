import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { retryAsync } from "../../../../src/infra/retry.js";
import { postJson } from "./post-json.js";

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  return await retryAsync(
    async () =>
      await postJson<T>({
        attachStatus: true,
        body: params.body,
        errorPrefix: params.errorPrefix,
        headers: params.headers,
        parse: async (payload) => payload as T,
        ssrfPolicy: params.ssrfPolicy,
        url: params.url,
      }),
    {
      attempts: 3,
      jitter: 0.2,
      maxDelayMs: 2000,
      minDelayMs: 300,
      shouldRetry: (err) => {
        const { status } = err as { status?: number };
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
}
