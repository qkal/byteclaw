import type { Api, Model } from "@mariozechner/pi-ai";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

function buildManagedResponse(response: Response, release: () => Promise<void>): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let released = false;
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    start() {
      reader = source.getReader();
    },
  });
  return new Response(wrappedBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function resolveModelRequestPolicy(model: Model<Api>) {
  const request = getModelProviderRequestTransport(model);
  return resolveProviderRequestPolicyConfig({
    allowPrivateNetwork: request?.allowPrivateNetwork === true,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    provider: model.provider,
    request,
    transport: "stream",
  });
}

export function buildGuardedModelFetch(model: Model<Api>): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const requestInit =
      request &&
      ({
        body: request.body ?? undefined,
        headers: request.headers,
        method: request.method,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const result = await fetchWithSsrFGuard({
      url,
      init: requestInit ?? init,
      dispatcherPolicy,
      // Provider transport intentionally keeps the secure default and never
      // Replays unsafe request bodies across cross-origin redirects.
      allowCrossOriginUnsafeRedirectReplay: false,
      ...(requestConfig.allowPrivateNetwork ? { policy: { allowPrivateNetwork: true } } : {}),
    });
    return buildManagedResponse(result.response, result.release);
  };
}
