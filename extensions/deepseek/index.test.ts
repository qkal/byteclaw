import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import deepseekPlugin from "./index.js";

describe("deepseek provider plugin", () => {
  it("registers DeepSeek with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolved = resolveProviderPluginChoice({
      choice: "deepseek-api-key",
      providers: [provider],
    });

    expect(provider.id).toBe("deepseek");
    expect(provider.label).toBe("DeepSeek");
    expect(provider.envVars).toEqual(["DEEPSEEK_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("deepseek");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static DeepSeek model catalog", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.deepseek.com");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              deepseek: {
                models: [
                  {
                    contextWindow: 65_536,
                    id: "deepseek-chat",
                    input: ["text"],
                    name: "DeepSeek Chat",
                    reasoning: false,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        contextWindow: 65_536,
        id: "deepseek-chat",
        input: ["text"],
        name: "DeepSeek Chat",
        provider: "deepseek",
        reasoning: false,
      },
    ]);
  });
});
