import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

function buildModel<TApi extends Api>(
  api: TApi,
  params: {
    id: string;
    provider: string;
    baseUrl: string;
  },
): Model<TApi> {
  return {
    api,
    baseUrl: params.baseUrl,
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: params.id,
    input: ["text"],
    maxTokens: 8192,
    name: params.id,
    provider: params.provider,
    reasoning: true,
  };
}

describe("provider transport stream contracts", () => {
  it("covers the supported transport api alias matrix", () => {
    const cases = [
      {
        alias: "openclaw-openai-responses-transport",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      },
      {
        alias: "openclaw-openai-responses-transport",
        api: "openai-codex-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api",
        id: "codex-mini-latest",
        provider: "openai-codex",
      },
      {
        alias: "openclaw-openai-completions-transport",
        api: "openai-completions" as const,
        baseUrl: "https://api.x.ai/v1",
        id: "grok-4",
        provider: "xai",
      },
      {
        alias: "openclaw-azure-openai-responses-transport",
        api: "azure-openai-responses" as const,
        baseUrl: "https://example.openai.azure.com/openai/v1",
        id: "gpt-5.4",
        provider: "azure-openai-responses",
      },
      {
        alias: "openclaw-anthropic-messages-transport",
        api: "anthropic-messages" as const,
        baseUrl: "https://api.anthropic.com",
        id: "claude-sonnet-4.6",
        provider: "anthropic",
      },
      {
        alias: "openclaw-google-generative-ai-transport",
        api: "google-generative-ai" as const,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        id: "gemini-3.1-pro-preview",
        provider: "google",
      },
    ];

    for (const testCase of cases) {
      const model = attachModelProviderRequestTransport(
        buildModel(testCase.api, {
          baseUrl: testCase.baseUrl,
          id: testCase.id,
          provider: testCase.provider,
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      );

      expect(isTransportAwareApiSupported(testCase.api)).toBe(true);
      expect(resolveTransportAwareSimpleApi(testCase.api)).toBe(testCase.alias);
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
      expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
        api: testCase.alias,
        id: testCase.id,
        provider: testCase.provider,
      });
    }
  });

  it("fails closed when unsupported apis carry transport overrides", () => {
    const model = attachModelProviderRequestTransport(
      buildModel("ollama", {
        baseUrl: "http://localhost:11434",
        id: "qwen3:32b",
        provider: "ollama",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(isTransportAwareApiSupported(model.api)).toBe(false);
    expect(resolveTransportAwareSimpleApi(model.api)).toBeUndefined();
    expect(createBoundaryAwareStreamFnForModel(model)).toBeUndefined();
    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(() => buildTransportAwareSimpleStreamFn(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(() => prepareTransportAwareSimpleModel(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
  });

  it("keeps unsupported apis unchanged when no transport overrides are attached", () => {
    const model = buildModel("ollama", {
      baseUrl: "http://localhost:11434",
      id: "qwen3:32b",
      provider: "ollama",
    });

    expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });
});
