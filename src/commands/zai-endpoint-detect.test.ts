import { describe, expect, it } from "vitest";
import { detectZaiEndpoint } from "../plugins/provider-zai-endpoint.js";

interface FetchResponse { status: number; body?: unknown }

function makeFetch(map: Record<string, FetchResponse>) {
  return (async (url: string, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const entry = map[`${url}::${rawBody?.model ?? ""}`] ?? map[url];
    if (!entry) {
      throw new Error(`unexpected url: ${url} model=${String(rawBody?.model ?? "")}`);
    }
    const json = entry.body ?? {};
    return new Response(JSON.stringify(json), {
      headers: { "content-type": "application/json" },
      status: entry.status,
    });
  }) as typeof fetch;
}

describe("detectZaiEndpoint", () => {
  it("resolves preferred/fallback endpoints and null when probes fail", async () => {
    const scenarios: {
      endpoint?: "global" | "cn" | "coding-global" | "coding-cn";
      responses: Record<string, { status: number; body?: unknown }>;
      expected: { endpoint: string; modelId: string } | null;
    }[] = [
      {
        expected: { endpoint: "global", modelId: "glm-5.1" },
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.1": { status: 200 },
        },
      },
      {
        expected: { endpoint: "cn", modelId: "glm-5.1" },
        responses: {
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.1": {
            body: { error: { message: "not found" } },
            status: 404,
          },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.1": { status: 200 },
        },
      },
      {
        expected: { endpoint: "coding-global", modelId: "glm-5.1" },
        responses: {
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.1": { status: 200 },
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.1": { status: 404 },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.1": { status: 404 },
        },
      },
      {
        endpoint: "coding-global",
        expected: { endpoint: "coding-global", modelId: "glm-4.7" },
        responses: {
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-4.7": { status: 200 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.1": {
            body: { error: { message: "glm-5.1 unavailable" } },
            status: 404,
          },
        },
      },
      {
        endpoint: "coding-cn",
        expected: { endpoint: "coding-cn", modelId: "glm-5.1" },
        responses: {
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 200,
          },
        },
      },
      {
        endpoint: "coding-cn",
        expected: { endpoint: "coding-cn", modelId: "glm-4.7" },
        responses: {
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-4.7": { status: 200 },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            body: { error: { message: "glm-5.1 unavailable" } },
            status: 404,
          },
        },
      },
      {
        expected: null,
        responses: {
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-4.7": { status: 401 },
          "https://api.z.ai/api/coding/paas/v4/chat/completions::glm-5.1": { status: 401 },
          "https://api.z.ai/api/paas/v4/chat/completions::glm-5.1": { status: 401 },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-4.7": { status: 401 },
          "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions::glm-5.1": {
            status: 401,
          },
          "https://open.bigmodel.cn/api/paas/v4/chat/completions::glm-5.1": { status: 401 },
        },
      },
    ];

    for (const scenario of scenarios) {
      const detected = await detectZaiEndpoint({
        apiKey: "sk-test", // Pragma: allowlist secret
        ...(scenario.endpoint ? { endpoint: scenario.endpoint } : {}),
        fetchFn: makeFetch(scenario.responses),
      });

      if (scenario.expected === null) {
        expect(detected).toBeNull();
      } else {
        expect(detected?.endpoint).toBe(scenario.expected.endpoint);
        expect(detected?.modelId).toBe(scenario.expected.modelId);
      }
    }
  });
});
