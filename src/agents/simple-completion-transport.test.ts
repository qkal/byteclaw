import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const createAnthropicVertexStreamFnForModel = vi.fn();
const ensureCustomApiRegistered = vi.fn();
const resolveProviderStreamFn = vi.fn();
const buildTransportAwareSimpleStreamFn = vi.fn();
const prepareTransportAwareSimpleModel = vi.fn();

vi.mock("./anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel,
}));

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

vi.mock("./provider-transport-stream.js", () => ({
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderStreamFn,
  };
});

let prepareModelForSimpleCompletion: typeof import("./simple-completion-transport.js").prepareModelForSimpleCompletion;

describe("prepareModelForSimpleCompletion", () => {
  beforeAll(async () => {
    ({ prepareModelForSimpleCompletion } = await import("./simple-completion-transport.js"));
  });

  beforeEach(() => {
    createAnthropicVertexStreamFnForModel.mockReset();
    ensureCustomApiRegistered.mockReset();
    resolveProviderStreamFn.mockReset();
    buildTransportAwareSimpleStreamFn.mockReset();
    prepareTransportAwareSimpleModel.mockReset();
    createAnthropicVertexStreamFnForModel.mockReturnValue("vertex-stream");
    resolveProviderStreamFn.mockReturnValue("ollama-stream");
    buildTransportAwareSimpleStreamFn.mockReturnValue(undefined);
    prepareTransportAwareSimpleModel.mockImplementation((model) => model);
  });

  it("registers the configured Ollama transport and keeps the original api", () => {
    const model: Model<"ollama"> = {
      api: "ollama",
      baseUrl: "http://localhost:11434",
      contextWindow: 8192,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      headers: {},
      id: "llama3",
      input: ["text"],
      maxTokens: 4096,
      name: "Llama 3",
      provider: "ollama",
      reasoning: false,
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://remote-ollama:11434",
            models: [],
          },
        },
      },
    };

    const result = prepareModelForSimpleCompletion({
      cfg,
      model,
    });

    expect(resolveProviderStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        context: expect.objectContaining({
          model,
          modelId: "llama3",
          provider: "ollama",
        }),
        provider: "ollama",
      }),
    );
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith("ollama", "ollama-stream");
    expect(result).toBe(model);
  });

  it("uses a custom api alias for Anthropic Vertex simple completions", () => {
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      baseUrl: "https://us-central1-aiplatform.googleapis.com",
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "claude-sonnet",
      input: ["text"],
      maxTokens: 8192,
      name: "Claude Sonnet",
      provider: "anthropic-vertex",
      reasoning: true,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);

    const result = prepareModelForSimpleCompletion({ model });

    expect(createAnthropicVertexStreamFnForModel).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
      "vertex-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-anthropic-vertex-simple:https%3A%2F%2Fus-central1-aiplatform.googleapis.com",
    });
  });

  it("uses a transport-aware custom api alias when llm request transport overrides are present", () => {
    const model: Model<"openai-responses"> = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "gpt-5",
      input: ["text"],
      maxTokens: 8192,
      name: "GPT-5",
      provider: "openai",
      reasoning: true,
    };

    resolveProviderStreamFn.mockReturnValueOnce(undefined);
    buildTransportAwareSimpleStreamFn.mockReturnValueOnce("transport-stream");
    prepareTransportAwareSimpleModel.mockReturnValueOnce({
      ...model,
      api: "openclaw-openai-responses-transport",
    });

    const result = prepareModelForSimpleCompletion({ model });

    expect(prepareTransportAwareSimpleModel).toHaveBeenCalledWith(model);
    expect(buildTransportAwareSimpleStreamFn).toHaveBeenCalledWith(model);
    expect(ensureCustomApiRegistered).toHaveBeenCalledWith(
      "openclaw-openai-responses-transport",
      "transport-stream",
    );
    expect(result).toEqual({
      ...model,
      api: "openclaw-openai-responses-transport",
    });
  });
});
