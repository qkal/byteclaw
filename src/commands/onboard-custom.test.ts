import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_WINDOW_HARD_MIN_TOKENS } from "../agents/context-window-guard.js";
import type { OpenClawConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import {
  applyCustomApiConfig,
  parseNonInteractiveCustomApiFlags,
  promptCustomApiConfig,
} from "./onboard-custom.js";

const OLLAMA_DEFAULT_BASE_URL_FOR_TEST = "http://127.0.0.1:11434";

// Mock dependencies
vi.mock("./model-picker.js", () => ({
  applyPrimaryModel: vi.fn((cfg) => cfg),
}));

function createTestPrompter(params: { text: string[]; select?: string[] }): {
  text: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  note: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof vi.fn>;
} {
  const text = vi.fn();
  for (const answer of params.text) {
    text.mockResolvedValueOnce(answer);
  }
  const select = vi.fn();
  for (const answer of params.select ?? []) {
    select.mockResolvedValueOnce(answer);
  }
  return {
    confirm: vi.fn(),
    note: vi.fn(),
    progress: vi.fn(() => ({
      stop: vi.fn(),
      update: vi.fn(),
    })),
    select,
    text,
  };
}

function stubFetchSequence(
  responses: { ok: boolean; status?: number }[],
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      json: async () => ({}),
      ok: response.ok,
      status: response.status,
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runPromptCustomApi(
  prompter: ReturnType<typeof createTestPrompter>,
  config: object = {},
) {
  return promptCustomApiConfig({
    config,
    prompter: prompter as unknown as Parameters<typeof promptCustomApiConfig>[0]["prompter"],
    runtime: { ...defaultRuntime, log: vi.fn() },
  });
}

function expectOpenAiCompatResult(params: {
  prompter: ReturnType<typeof createTestPrompter>;
  textCalls: number;
  selectCalls: number;
  result: Awaited<ReturnType<typeof runPromptCustomApi>>;
}) {
  expect(params.prompter.text).toHaveBeenCalledTimes(params.textCalls);
  expect(params.prompter.select).toHaveBeenCalledTimes(params.selectCalls);
  expect(params.result.config.models?.providers?.custom?.api).toBe("openai-completions");
}

function getFirstFetchVerificationCall(fetchMock: ReturnType<typeof vi.fn>) {
  const firstCall = fetchMock.mock.calls[0];
  const firstUrl = firstCall?.[0];
  const firstInit = firstCall?.[1] as
    | { body?: string; headers?: Record<string, string> }
    | undefined;
  if (typeof firstUrl !== "string") {
    throw new Error("Expected first verification call URL");
  }
  return {
    body: JSON.parse(firstInit?.body ?? "{}"),
    init: firstInit,
    url: firstUrl,
  };
}

function buildCustomProviderConfig(contextWindow?: number) {
  if (contextWindow === undefined) {
    return {} as OpenClawConfig;
  }
  return {
    models: {
      providers: {
        custom: {
          api: "openai-completions" as const,
          baseUrl: "https://llm.example.com/v1",
          models: [
            {
              contextWindow,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "foo-large",
              input: ["text"],
              maxTokens: contextWindow > CONTEXT_WINDOW_HARD_MIN_TOKENS ? 4096 : 1024,
              name: "foo-large",
              reasoning: false,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

function applyCustomModelConfigWithContextWindow(contextWindow?: number) {
  return applyCustomApiConfig({
    baseUrl: "https://llm.example.com/v1",
    compatibility: "openai",
    config: buildCustomProviderConfig(contextWindow),
    modelId: "foo-large",
    providerId: "custom",
  });
}

describe("promptCustomApiConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("handles openai flow and saves alias", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: ["http://localhost:11434/v1", "", "llama3", "custom", "local"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, result, selectCalls: 2, textCalls: 5 });
    expect(result.config.agents?.defaults?.models?.["custom/llama3"]?.alias).toBe("local");
  });

  it("defaults custom setup to the native Ollama base URL", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: ["http://localhost:11434", "", "llama3", "custom", ""],
    });
    stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: OLLAMA_DEFAULT_BASE_URL_FOR_TEST,
        message: "API Base URL",
      }),
    );
  });

  it("retries when verification fails", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai", "model"],
      text: ["http://localhost:11434/v1", "", "bad-model", "good-model", "custom", ""],
    });
    stubFetchSequence([{ ok: false, status: 400 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.text).toHaveBeenCalledTimes(6);
    expect(prompter.select).toHaveBeenCalledTimes(3);
  });

  it("detects openai compatibility when unknown", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "unknown"],
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter);

    expectOpenAiCompatResult({ prompter, result, selectCalls: 2, textCalls: 5 });
  });

  it("uses expanded max_tokens for openai verification probes", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: ["https://example.com/v1", "test-key", "detected-model", "custom", "alias"],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    const firstCall = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(firstCall?.body).toBeDefined();
    expect(JSON.parse(firstCall?.body ?? "{}")).toMatchObject({ max_tokens: 1 });
  });

  it("uses azure responses-specific headers and body for openai verification probes", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: [
        "https://my-resource.openai.azure.com",
        "azure-test-key",
        "gpt-4.1",
        "custom",
        "alias",
      ],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    const { url, init, body } = getFirstFetchVerificationCall(fetchMock);

    expect(url).toBe("https://my-resource.openai.azure.com/openai/v1/responses");
    expect(init?.headers?.["api-key"]).toBe("azure-test-key");
    expect(init?.headers?.Authorization).toBeUndefined();
    expect(init?.body).toBeDefined();
    expect(body).toEqual({
      input: "Hi",
      max_output_tokens: 16,
      model: "gpt-4.1",
      stream: false,
    });
  });

  it("uses Azure Foundry chat-completions probes for services.ai URLs", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: [
        "https://my-resource.services.ai.azure.com",
        "azure-test-key",
        "deepseek-v3-0324",
        "custom",
        "alias",
      ],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    await runPromptCustomApi(prompter);

    const { url, init, body } = getFirstFetchVerificationCall(fetchMock);

    expect(url).toBe(
      "https://my-resource.services.ai.azure.com/openai/deployments/deepseek-v3-0324/chat/completions?api-version=2024-10-21",
    );
    expect(init?.headers?.["api-key"]).toBe("azure-test-key");
    expect(init?.headers?.Authorization).toBeUndefined();
    expect(body).toEqual({
      max_tokens: 1,
      messages: [{ content: "Hi", role: "user" }],
      model: "deepseek-v3-0324",
      stream: false,
    });
  });

  it("uses expanded max_tokens for anthropic verification probes", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "unknown"],
      text: ["https://example.com", "test-key", "detected-model", "custom", "alias"],
    });
    const fetchMock = stubFetchSequence([{ ok: false, status: 404 }, { ok: true }]);

    await runPromptCustomApi(prompter);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1]?.[1] as { body?: string } | undefined;
    expect(secondCall?.body).toBeDefined();
    expect(JSON.parse(secondCall?.body ?? "{}")).toMatchObject({ max_tokens: 1 });
  });

  it("re-prompts base url when unknown detection fails", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "unknown", "baseUrl", "plaintext"],
      text: [
        "https://bad.example.com/v1",
        "bad-key",
        "bad-model",
        "https://ok.example.com/v1",
        "ok-key",
        "custom",
        "",
      ],
    });
    stubFetchSequence([{ ok: false, status: 404 }, { ok: false, status: 404 }, { ok: true }]);
    await runPromptCustomApi(prompter);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("did not respond"),
      "Endpoint detection",
    );
  });

  it("renames provider id when baseUrl differs", async () => {
    const prompter = createTestPrompter({
      select: ["plaintext", "openai"],
      text: ["http://localhost:11434/v1", "", "llama3", "custom", ""],
    });
    stubFetchSequence([{ ok: true }]);
    const result = await runPromptCustomApi(prompter, {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "http://old.example.com/v1",
            models: [
              {
                contextWindow: 1,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "old-model",
                input: ["text"],
                maxTokens: 1,
                name: "Old",
                reasoning: false,
              },
            ],
          },
        },
      },
    });

    expect(result.providerId).toBe("custom-2");
    expect(result.config.models?.providers?.custom).toBeDefined();
    expect(result.config.models?.providers?.["custom-2"]).toBeDefined();
  });

  it("aborts verification after timeout", async () => {
    vi.useFakeTimers();
    const prompter = createTestPrompter({
      select: ["plaintext", "openai", "model"],
      text: ["http://localhost:11434/v1", "", "slow-model", "fast-model", "custom", ""],
    });

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
          }),
      )
      .mockResolvedValueOnce({ json: async () => ({}), ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const promise = runPromptCustomApi(prompter);

    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(prompter.text).toHaveBeenCalledTimes(6);
  });

  it("stores env SecretRef for custom provider when selected", async () => {
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "test-env-key");
    const prompter = createTestPrompter({
      select: ["ref", "env", "openai"],
      text: ["https://example.com/v1", "CUSTOM_PROVIDER_API_KEY", "detected-model", "custom", ""],
    });
    const fetchMock = stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter);

    expect(result.config.models?.providers?.custom?.apiKey).toEqual({
      id: "CUSTOM_PROVIDER_API_KEY",
      provider: "default",
      source: "env",
    });
    const firstCall = fetchMock.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(firstCall?.headers?.Authorization).toBe("Bearer test-env-key");
  });

  it("re-prompts source after provider ref preflight fails and succeeds with env ref", async () => {
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "test-env-key");
    const prompter = createTestPrompter({
      select: ["ref", "provider", "filemain", "env", "openai"],
      text: [
        "https://example.com/v1",
        "/providers/custom/apiKey",
        "CUSTOM_PROVIDER_API_KEY",
        "detected-model",
        "custom",
        "",
      ],
    });
    stubFetchSequence([{ ok: true }]);

    const result = await runPromptCustomApi(prompter, {
      secrets: {
        providers: {
          filemain: {
            mode: "json",
            path: "/tmp/openclaw-missing-provider.json",
            source: "file",
          },
        },
      },
    });

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
    expect(result.config.models?.providers?.custom?.apiKey).toEqual({
      id: "CUSTOM_PROVIDER_API_KEY",
      provider: "default",
      source: "env",
    });
  });
});

describe("applyCustomApiConfig", () => {
  it.each([
    {
      existingContextWindow: undefined,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      name: "uses hard-min context window for newly added custom models",
    },
    {
      existingContextWindow: 4096,
      expectedContextWindow: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      name: "upgrades existing custom model context window when below hard minimum",
    },
    {
      existingContextWindow: 131_072,
      expectedContextWindow: 131_072,
      name: "preserves existing custom model context window when already above minimum",
    },
  ])("$name", ({ existingContextWindow, expectedContextWindow }) => {
    const result = applyCustomModelConfigWithContextWindow(existingContextWindow);
    const model = result.config.models?.providers?.custom?.models?.find(
      (entry) => entry.id === "foo-large",
    );
    expect(model?.contextWindow).toBe(expectedContextWindow);
  });

  it.each([
    {
      expectedMessage: 'Custom provider compatibility must be "openai" or "anthropic".',
      name: "invalid compatibility values at runtime",
      params: {
        baseUrl: "https://llm.example.com/v1",
        compatibility: "invalid" as unknown as "openai",
        config: {},
        modelId: "foo-large",
      },
    },
    {
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
      name: "explicit provider ids that normalize to empty",
      params: {
        baseUrl: "https://llm.example.com/v1",
        compatibility: "openai" as const,
        config: {},
        modelId: "foo-large",
        providerId: "!!!",
      },
    },
  ])("rejects $name", ({ params, expectedMessage }) => {
    expect(() => applyCustomApiConfig(params)).toThrow(expectedMessage);
  });

  it("produces azure-specific config for Azure OpenAI URLs with reasoning model", () => {
    const result = applyCustomApiConfig({
      apiKey: "abcd1234",
      baseUrl: "https://user123-resource.openai.azure.com",
      compatibility: "openai",
      config: {},
      modelId: "o4-mini",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://user123-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "abcd1234" });

    const model = provider?.models?.find((m) => m.id === "o4-mini");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.reasoning).toBe(true);
    expect(model?.compat).toEqual({ supportsStore: false });

    const modelRef = `${providerId}/${result.modelId}`;
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("medium");
  });

  it("keeps selected compatibility for Azure AI Foundry URLs", () => {
    const result = applyCustomApiConfig({
      apiKey: "key123",
      baseUrl: "https://my-resource.services.ai.azure.com",
      compatibility: "openai",
      config: {},
      modelId: "gpt-4.1",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.services.ai.azure.com/openai/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "key123" });

    const model = provider?.models?.find((m) => m.id === "gpt-4.1");
    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.compat).toEqual({ supportsStore: false });

    const modelRef = `${providerId}/gpt-4.1`;
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBeUndefined();
  });

  it("strips pre-existing deployment path from Azure URL in stored config", () => {
    const result = applyCustomApiConfig({
      apiKey: "key456",
      baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
      compatibility: "openai",
      config: {},
      modelId: "gpt-4",
    });
    const providerId = result.providerId!;
    const provider = result.config.models?.providers?.[providerId];

    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it("re-onboard updates existing Azure provider instead of creating a duplicate", () => {
    const oldProviderId = "custom-my-resource-openai-azure-com";
    const result = applyCustomApiConfig({
      apiKey: "key789",
      baseUrl: "https://my-resource.openai.azure.com",
      compatibility: "openai",
      config: {
        models: {
          providers: {
            [oldProviderId]: {
              api: "openai-completions",
              baseUrl: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
              models: [
                {
                  id: "gpt-4",
                  name: "gpt-4",
                  contextWindow: 1,
                  maxTokens: 1,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: false,
                },
              ],
            },
          },
        },
      },
      modelId: "gpt-4",
    });

    expect(result.providerId).toBe(oldProviderId);
    expect(result.providerIdRenamedFrom).toBeUndefined();
    const provider = result.config.models?.providers?.[oldProviderId];
    expect(provider?.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
    expect(provider?.api).toBe("azure-openai-responses");
    expect(provider?.authHeader).toBe(false);
    expect(provider?.headers).toEqual({ "api-key": "key789" });
  });

  it("does not add azure fields for non-azure URLs", () => {
    const result = applyCustomApiConfig({
      apiKey: "key123",
      baseUrl: "https://llm.example.com/v1",
      compatibility: "openai",
      config: {},
      modelId: "foo-large",
      providerId: "custom",
    });
    const provider = result.config.models?.providers?.custom;

    expect(provider?.api).toBe("openai-completions");
    expect(provider?.authHeader).toBeUndefined();
    expect(provider?.headers).toBeUndefined();
    expect(provider?.models?.[0]?.reasoning).toBe(false);
    expect(provider?.models?.[0]?.input).toEqual(["text"]);
    expect(provider?.models?.[0]?.compat).toBeUndefined();
    expect(
      result.config.agents?.defaults?.models?.["custom/foo-large"]?.params?.thinking,
    ).toBeUndefined();
  });

  it("re-onboard preserves user-customized fields for non-azure models", () => {
    const result = applyCustomApiConfig({
      apiKey: "key",
      baseUrl: "https://llm.example.com/v1",
      compatibility: "openai",
      config: {
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://llm.example.com/v1",
              models: [
                {
                  id: "foo-large",
                  name: "My Custom Model",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
      } as OpenClawConfig,
      modelId: "foo-large",
      providerId: "custom",
    });
    const model = result.config.models?.providers?.custom?.models?.find(
      (m) => m.id === "foo-large",
    );
    expect(model?.name).toBe("My Custom Model");
    expect(model?.reasoning).toBe(true);
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.cost).toEqual({ cacheRead: 0, cacheWrite: 0, input: 1, output: 2 });
    expect(model?.maxTokens).toBe(16_384);
    expect(model?.contextWindow).toBe(131_072);
  });

  it("preserves existing per-model thinking when already set for azure reasoning model", () => {
    const providerId = "custom-my-resource-openai-azure-com";
    const modelRef = `${providerId}/o3-mini`;
    const result = applyCustomApiConfig({
      apiKey: "key",
      baseUrl: "https://my-resource.openai.azure.com",
      compatibility: "openai",
      config: {
        agents: {
          defaults: {
            models: {
              [modelRef]: { params: { thinking: "high" } },
            },
          },
        },
      } as OpenClawConfig,
      modelId: "o3-mini",
    });
    expect(result.config.agents?.defaults?.models?.[modelRef]?.params?.thinking).toBe("high");
  });
});

describe("parseNonInteractiveCustomApiFlags", () => {
  it("parses required flags and defaults compatibility to openai", () => {
    const result = parseNonInteractiveCustomApiFlags({
      apiKey: " custom-test-key ",
      baseUrl: " https://llm.example.com/v1 ",
      modelId: " foo-large ",
      providerId: " my-custom ",
    });

    expect(result).toEqual({
      baseUrl: "https://llm.example.com/v1",
      modelId: "foo-large",
      compatibility: "openai",
      apiKey: "custom-test-key", // Pragma: allowlist secret
      providerId: "my-custom",
    });
  });

  it.each([
    {
      expectedMessage: 'Auth choice "custom-api-key" requires a base URL and model ID.',
      flags: { baseUrl: "https://llm.example.com/v1" },
      name: "missing required flags",
    },
    {
      expectedMessage: 'Invalid --custom-compatibility (use "openai" or "anthropic").',
      flags: {
        baseUrl: "https://llm.example.com/v1",
        compatibility: "xmlrpc",
        modelId: "foo-large",
      },
      name: "invalid compatibility values",
    },
    {
      expectedMessage: "Custom provider ID must include letters, numbers, or hyphens.",
      flags: {
        baseUrl: "https://llm.example.com/v1",
        modelId: "foo-large",
        providerId: "!!!",
      },
      name: "invalid explicit provider ids",
    },
  ])("rejects $name", ({ flags, expectedMessage }) => {
    expect(() => parseNonInteractiveCustomApiFlags(flags)).toThrow(expectedMessage);
  });
});
