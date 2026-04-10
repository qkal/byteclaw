import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExistingProviderConfig } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let mergeProviderModels: typeof import("./models-config.merge.js").mergeProviderModels;
let mergeProviders: typeof import("./models-config.merge.js").mergeProviders;
let mergeWithExistingProviderSecrets: typeof import("./models-config.merge.js").mergeWithExistingProviderSecrets;

async function loadMergeModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  ({ NON_ENV_SECRETREF_MARKER } = await import("./model-auth-markers.js"));
  ({ mergeProviderModels, mergeProviders, mergeWithExistingProviderSecrets } =
    await import("./models-config.merge.js"));
}

beforeAll(loadMergeModules);

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
});

describe("models-config merge helpers", () => {
  const preservedApiKey = "AGENT_KEY"; // Pragma: allowlist secret
  const configApiKey = "CONFIG_KEY"; // Pragma: allowlist secret
  const createModel = (
    overrides: Partial<NonNullable<ProviderConfig["models"]>[number]> = {},
  ): NonNullable<ProviderConfig["models"]>[number] => ({
    contextWindow: 8192,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: "config-model",
    input: ["text"],
    maxTokens: 2048,
    name: "Config model",
    reasoning: false,
    ...overrides,
  });

  function createConfigProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      api: "openai-responses",
      apiKey: configApiKey,
      baseUrl: "https://config.example/v1",
      models: [createModel()],
      ...overrides,
    } as ProviderConfig;
  }

  function createExistingProvider(
    overrides: Partial<ExistingProviderConfig> = {},
  ): ExistingProviderConfig {
    return {
      api: "openai-responses",
      apiKey: preservedApiKey,
      baseUrl: "https://agent.example/v1",
      models: [createModel({ id: "agent-model", name: "Agent model" })],
      ...overrides,
    } as ExistingProviderConfig;
  }

  it("refreshes implicit model metadata while preserving explicit reasoning overrides", async () => {
    const merged = mergeProviderModels(
      {
        api: "openai-responses",
        models: [
          {
            contextWindow: 1_000_000,
            id: "gpt-5.4",
            input: ["text"],
            maxTokens: 100_000,
            name: "GPT-5.4",
            reasoning: true,
          },
        ],
      } as ProviderConfig,
      {
        api: "openai-responses",
        models: [
          {
            contextWindow: 2_000_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 123, output: 456 },
            id: "gpt-5.4",
            input: ["image"],
            maxTokens: 200_000,
            name: "GPT-5.4",
            reasoning: false,
          },
        ],
      } as ProviderConfig,
    );

    expect(merged.models).toEqual([
      expect.objectContaining({
        contextWindow: 2_000_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 123, output: 456 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 200_000,
        reasoning: false,
      }),
    ]);
  });

  it("merges explicit providers onto trimmed keys", async () => {
    const merged = mergeProviders({
      explicit: {
        " custom ": {
          api: "openai-responses",
          models: [] as ProviderConfig["models"],
        } as ProviderConfig,
      },
    });

    expect(merged).toEqual({
      custom: expect.objectContaining({ api: "openai-responses" }),
    });
  });

  it("keeps existing providers alongside newly configured providers in merge mode", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        existing: {
          baseUrl: "http://localhost:1234/v1",
          apiKey: "EXISTING_KEY", // Pragma: allowlist secret
          api: "openai-completions",
          models: [{ id: "existing-model", input: ["text"], name: "Existing" }],
        } as ExistingProviderConfig,
      },
      explicitBaseUrlProviders: new Set<string>(["custom-proxy"]),
      nextProviders: {
        "custom-proxy": {
          api: "openai-completions",
          baseUrl: "http://localhost:4000/v1",
          models: [],
        } as ProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.existing?.baseUrl).toBe("http://localhost:1234/v1");
    expect(merged["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
  });

  it("preserves non-empty existing apiKey while explicit baseUrl wins", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: createExistingProvider(),
      },
      explicitBaseUrlProviders: new Set<string>(["custom"]),
      nextProviders: {
        custom: createConfigProvider(),
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("preserves existing apiKey after explicit provider key normalization", async () => {
    const normalized = mergeProviders({
      explicit: {
        " custom ": createConfigProvider(),
      },
    });
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: createExistingProvider(),
      },
      explicitBaseUrlProviders: new Set<string>(["custom"]),
      nextProviders: normalized,
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("preserves implicit provider headers when explicit config adds extra headers", async () => {
    const merged = mergeProviderModels(
      {
        api: "anthropic-messages",
        baseUrl: "https://api.example.com",
        headers: { "User-Agent": "claude-code/0.1.0" },
        models: [
          {
            id: "kimi-code",
            input: ["text", "image"],
            name: "Kimi Code",
            reasoning: true,
          },
        ],
      } as unknown as ProviderConfig,
      {
        api: "anthropic-messages",
        baseUrl: "https://api.example.com",
        headers: { "X-Kimi-Tenant": "tenant-a" },
        models: [
          {
            id: "kimi-code",
            input: ["text", "image"],
            name: "Kimi Code",
            reasoning: true,
          },
        ],
      } as unknown as ProviderConfig,
    );

    expect(merged.headers).toEqual({
      "User-Agent": "claude-code/0.1.0",
      "X-Kimi-Tenant": "tenant-a",
    });
  });

  it("replaces stale baseUrl when model api surface changes", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: {
          apiKey: preservedApiKey,
          baseUrl: "https://agent.example/v1",
          models: [{ id: "model", api: "openai-completions" }],
        } as ExistingProviderConfig,
      },
      explicitBaseUrlProviders: new Set<string>(),
      nextProviders: {
        custom: {
          baseUrl: "https://config.example/v1",
          models: [{ api: "openai-responses", id: "model" }],
        } as ProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom).toEqual(
      expect.objectContaining({
        apiKey: preservedApiKey,
        baseUrl: "https://config.example/v1",
      }),
    );
  });

  it("replaces stale baseUrl when only model-level apis change", async () => {
    const nextProvider = createConfigProvider();
    delete (nextProvider as { api?: string }).api;
    nextProvider.models = [createModel({ api: "openai-responses" })];
    const existingProvider = createExistingProvider({
      models: [createModel({ api: "openai-completions", id: "agent-model", name: "Agent model" })],
    });
    delete (existingProvider as { api?: string }).api;
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: existingProvider,
      },
      explicitBaseUrlProviders: new Set<string>(["custom"]),
      nextProviders: {
        custom: nextProvider,
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe(preservedApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("does not preserve stale plaintext apiKey when next entry is a marker", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: {
          apiKey: preservedApiKey,
          models: [createModel({ api: "openai-responses", id: "model" })],
        } as ExistingProviderConfig,
      },
      explicitBaseUrlProviders: new Set<string>(),
      nextProviders: {
        custom: {
          apiKey: "GOOGLE_API_KEY", // Pragma: allowlist secret
          models: [createModel({ api: "openai-responses", id: "model" })],
        } as ProviderConfig,
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe("GOOGLE_API_KEY"); // Pragma: allowlist secret
  });

  it("does not preserve a stale non-env marker when config returns to plaintext", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: createExistingProvider({
          apiKey: NON_ENV_SECRETREF_MARKER,
        }),
      },
      explicitBaseUrlProviders: new Set<string>(["custom"]),
      nextProviders: {
        custom: createConfigProvider({ apiKey: "ALLCAPS_SAMPLE" }), // Pragma: allowlist secret
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe("ALLCAPS_SAMPLE"); // Pragma: allowlist secret
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });

  it("uses config apiKey/baseUrl when existing values are empty", async () => {
    const merged = mergeWithExistingProviderSecrets({
      existingProviders: {
        custom: createExistingProvider({
          apiKey: "",
          baseUrl: "",
        }),
      },
      explicitBaseUrlProviders: new Set<string>(["custom"]),
      nextProviders: {
        custom: createConfigProvider(),
      },
      secretRefManagedProviders: new Set<string>(),
    });

    expect(merged.custom?.apiKey).toBe(configApiKey);
    expect(merged.custom?.baseUrl).toBe("https://config.example/v1");
  });
});
