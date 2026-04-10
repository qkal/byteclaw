import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

const promptAndConfigureOllamaMock = vi.hoisted(() =>
  vi.fn(async () => ({
    config: {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    },
  })),
);
const ensureOllamaModelPulledMock = vi.hoisted(() => vi.fn(async () => {}));
const buildOllamaProviderMock = vi.hoisted(() => vi.fn());
const createConfiguredOllamaStreamFnMock = vi.hoisted(() =>
  vi.fn((_params: { model: unknown; providerBaseUrl?: string }) => ({}) as never),
);

vi.mock("./api.js", () => ({
  buildOllamaProvider: buildOllamaProviderMock,
  configureOllamaNonInteractive: vi.fn(),
  ensureOllamaModelPulled: ensureOllamaModelPulledMock,
  promptAndConfigureOllama: promptAndConfigureOllamaMock,
}));

vi.mock("./src/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/stream.js")>();
  return {
    ...actual,
    createConfiguredOllamaStreamFn: createConfiguredOllamaStreamFnMock,
  };
});

beforeEach(() => {
  promptAndConfigureOllamaMock.mockClear();
  ensureOllamaModelPulledMock.mockClear();
  buildOllamaProviderMock.mockReset();
  createConfiguredOllamaStreamFnMock.mockClear();
});

function registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      config: {},
      id: "ollama",
      name: "Ollama",
      pluginConfig,
      registerProvider: registerProviderMock,
      runtime: {} as never,
      source: "test",
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("ollama plugin", () => {
  it("does not preselect a default model during provider auth setup", async () => {
    const provider = registerProvider();

    const result = await provider.auth[0].run({
      config: {},
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
      prompter: {} as never,
    });

    expect(promptAndConfigureOllamaMock).toHaveBeenCalledWith({
      cfg: {},
      isRemote: false,
      openUrl: expect.any(Function),
      prompter: {},
    });
    expect(result.configPatch).toEqual({
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    });
    expect(result.defaultModel).toBeUndefined();
  });

  it("pulls the model the user actually selected", async () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    };
    const prompter = {} as never;

    await provider.onModelSelected?.({
      config,
      model: "ollama/gemma4",
      prompter,
    });

    expect(ensureOllamaModelPulledMock).toHaveBeenCalledWith({
      config,
      model: "ollama/gemma4",
      prompter,
    });
  });

  it("skips ambient discovery when plugin discovery is disabled", async () => {
    const provider = registerProviderWithPluginConfig({ discovery: { enabled: false } });

    const result = await provider.discovery.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "", discoveryApiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).not.toHaveBeenCalled();
  });

  it("keeps empty default-ish provider stubs quiet", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://127.0.0.1:11434", {
      quiet: true,
    });
  });

  it("treats non-default baseUrl as explicit discovery config", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      api: "ollama",
      baseUrl: "http://remote-ollama:11434",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://remote-ollama:11434",
              models: [],
            },
          },
        },
      },
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "" }),
    } as never);

    expect(result).toBeNull();
    expect(buildOllamaProviderMock).toHaveBeenCalledWith("http://remote-ollama:11434", {
      quiet: false,
    });
  });

  it("keeps stored ollama-local marker auth on the quiet ambient path", async () => {
    const provider = registerProvider();
    buildOllamaProviderMock.mockResolvedValueOnce({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [],
    });

    const result = await provider.discovery.run({
      config: {},
      env: { NODE_ENV: "development" },
      resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
    } as never);

    expect(result).toMatchObject({
      provider: {
        api: "ollama",
        apiKey: "ollama-local",
        baseUrl: "http://127.0.0.1:11434",
        models: [],
      },
    });
    expect(buildOllamaProviderMock).toHaveBeenCalledWith(undefined, {
      quiet: true,
    });
  });

  it("does not mint synthetic auth for empty default-ish provider stubs", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: [],
      },
    });

    expect(auth).toBeUndefined();
  });

  it("mints synthetic auth for non-default explicit ollama config", () => {
    const provider = registerProvider();

    const auth = provider.resolveSyntheticAuth?.({
      providerConfig: {
        api: "ollama",
        baseUrl: "http://remote-ollama:11434",
        models: [],
      },
    });

    expect(auth).toEqual({
      apiKey: "ollama-local",
      mode: "api-key",
      source: "models.providers.ollama (synthetic local key)",
    });
  });

  it("wraps OpenAI-compatible payloads with num_ctx for Ollama compat routes", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [],
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        contextWindow: 202_752,
        id: "qwen3:32b",
        provider: "ollama",
      },
      modelId: "qwen3:32b",
      provider: "ollama",
      streamFn: baseStreamFn,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.({} as never, {} as never, {});
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202_752);
  });

  it("owns replay policy for OpenAI-compatible Ollama routes only", () => {
    const provider = registerProvider();

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "qwen3:32b",
        provider: "ollama",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-responses",
        modelId: "qwen3:32b",
        provider: "ollama",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "ollama",
        modelId: "qwen3.5:9b",
        provider: "ollama",
      } as never),
    ).toBeUndefined();
  });

  it("routes createStreamFn to the correct provider baseUrl for ollama2", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { baseUrl: undefined, id: "llama3.2", provider: "ollama2" };

    provider.createStreamFn?.({ config, model, provider: "ollama2" } as never);

    expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerBaseUrl: "http://127.0.0.1:11435" }),
    );
  });

  it("uses ollama provider baseUrl when provider is ollama (backward compat)", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
          ollama2: {
            api: "ollama",
            baseUrl: "http://127.0.0.1:11435",
            models: [],
          },
        },
      },
    };
    const model = { baseUrl: undefined, id: "llama3.2", provider: "ollama" };

    provider.createStreamFn?.({ config, model, provider: "ollama" } as never);

    expect(createConfiguredOllamaStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerBaseUrl: "http://127.0.0.1:11434" }),
    );
  });

  it("wraps native Ollama payloads with top-level think=false when thinking is off", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65_536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      model: {
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
        id: "qwen3.5:9b",
        provider: "ollama",
      },
      modelId: "qwen3.5:9b",
      provider: "ollama",
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        id: "qwen3.5:9b",
        provider: "ollama",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(false);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("wraps native Ollama payloads with top-level think=true when thinking is enabled", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65_536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      model: {
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
        id: "qwen3.5:9b",
        provider: "ollama",
      },
      modelId: "qwen3.5:9b",
      provider: "ollama",
      streamFn: baseStreamFn,
      thinkingLevel: "low",
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        id: "qwen3.5:9b",
        provider: "ollama",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBe(true);
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.think).toBeUndefined();
  });

  it("does not set think param when thinkingLevel is undefined", () => {
    const provider = registerProvider();
    let payloadSeen: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = {
        messages: [],
        options: { num_ctx: 65_536 },
        stream: true,
      };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });

    const wrapped = provider.wrapStreamFn?.({
      config: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      model: {
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 131_072,
        id: "qwen3.5:9b",
        provider: "ollama",
      },
      modelId: "qwen3.5:9b",
      provider: "ollama",
      streamFn: baseStreamFn,
      thinkingLevel: undefined,
    });

    expect(typeof wrapped).toBe("function");
    void wrapped?.(
      {
        api: "ollama",
        id: "qwen3.5:9b",
        provider: "ollama",
      } as never,
      {} as never,
      {},
    );
    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(payloadSeen?.think).toBeUndefined();
  });
});
