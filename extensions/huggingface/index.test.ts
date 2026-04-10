import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const buildHuggingfaceProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    api: "openai-completions",
    baseUrl: "https://router.huggingface.co/v1",
    models: [],
  })),
);

vi.mock("./provider-catalog.js", () => ({
  buildHuggingfaceProvider: buildHuggingfaceProviderMock,
}));

vi.mock("./onboard.js", () => ({
  HUGGINGFACE_DEFAULT_MODEL_REF: "huggingface/deepseek-ai/DeepSeek-R1",
  applyHuggingfaceConfig: vi.fn((cfg) => cfg),
}));

import plugin from "./index.js";

function registerProvider() {
  return registerProviderWithPluginConfig({});
}

function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn();

  plugin.register(
    createTestPluginApi({
      config: {},
      id: "huggingface",
      name: "Hugging Face",
      pluginConfig,
      registerProvider: registerProviderMock,
      runtime: {} as never,
      source: "test",
    }),
  );

  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

describe("huggingface plugin", () => {
  it("skips catalog discovery when plugin discovery is disabled", async () => {
    const provider = registerProvider();

    const result = await provider.catalog.run({
      config: {
        plugins: {
          entries: {
            huggingface: {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      resolveProviderApiKey: () => ({
        apiKey: "hf_test_token",
        discoveryApiKey: "hf_test_token",
      }),
    } as never);

    expect(result).toBeNull();
    expect(buildHuggingfaceProviderMock).not.toHaveBeenCalled();
  });
});
