import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyProviderConfigWithDefaultModel,
  applyProviderConfigWithDefaultModelPreset,
  applyProviderConfigWithDefaultModels,
  applyProviderConfigWithModelCatalog,
  applyProviderConfigWithModelCatalogPreset,
  withAgentModelAliases,
} from "../plugin-sdk/provider-onboard.js";

function makeModel(id: string): ModelDefinitionConfig {
  return {
    contextWindow: 4096,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 1024,
    name: id,
    reasoning: false,
  };
}

describe("onboard auth provider config merges", () => {
  const agentModels: Record<string, AgentModelEntryConfig> = {
    "custom/model-a": {},
  };

  it("appends missing default models to existing provider models", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            apiKey: "  test-key  ",
            baseUrl: "https://old.example.com/v1",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithDefaultModels(cfg, {
      agentModels,
      api: "openai-completions",
      baseUrl: "https://new.example.com/v1",
      defaultModelId: "model-b",
      defaultModels: [makeModel("model-b")],
      providerId: "custom",
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.models?.providers?.custom?.apiKey).toBe("test-key");
    expect(next.agents?.defaults?.models).toEqual(agentModels);
  });

  it("merges model catalogs without duplicating existing model ids", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.com/v1",
            models: [makeModel("model-a")],
          },
        },
      },
    };

    const next = applyProviderConfigWithModelCatalog(cfg, {
      agentModels,
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      catalogModels: [makeModel("model-a"), makeModel("model-c")],
      providerId: "custom",
    });

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual([
      "model-a",
      "model-c",
    ]);
  });

  it("supports single default model convenience wrapper", () => {
    const next = applyProviderConfigWithDefaultModel(
      {},
      {
        agentModels,
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
        providerId: "custom",
      },
    );

    expect(next.models?.providers?.custom?.models?.map((m) => m.id)).toEqual(["model-z"]);
  });

  it("preserves explicit aliases when adding provider alias presets", () => {
    expect(
      withAgentModelAliases(
        {
          "custom/model-a": { alias: "Pinned" },
        },
        [{ alias: "Preset", modelRef: "custom/model-a" }, "custom/model-b"],
      ),
    ).toEqual({
      "custom/model-a": { alias: "Pinned" },
      "custom/model-b": {},
    });
  });

  it("applies default-model presets with alias and primary model", () => {
    const next = applyProviderConfigWithDefaultModelPreset(
      {
        agents: {
          defaults: {
            models: {
              "custom/model-z": { alias: "Pinned" },
            },
          },
        },
      },
      {
        aliases: [{ alias: "Preset", modelRef: "custom/model-z" }],
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        defaultModel: makeModel("model-z"),
        primaryModelRef: "custom/model-z",
        providerId: "custom",
      },
    );

    expect(next.agents?.defaults?.models?.["custom/model-z"]).toEqual({ alias: "Pinned" });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-z" });
  });

  it("applies catalog presets with alias and merged catalog models", () => {
    const next = applyProviderConfigWithModelCatalogPreset(
      {
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://example.com/v1",
              models: [makeModel("model-a")],
            },
          },
        },
      },
      {
        aliases: [{ alias: "Catalog Alias", modelRef: "custom/model-b" }],
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        catalogModels: [makeModel("model-a"), makeModel("model-b")],
        primaryModelRef: "custom/model-b",
        providerId: "custom",
      },
    );

    expect(next.models?.providers?.custom?.models?.map((model) => model.id)).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(next.agents?.defaults?.models?.["custom/model-b"]).toEqual({
      alias: "Catalog Alias",
    });
    expect(next.agents?.defaults?.model).toEqual({ primary: "custom/model-b" });
  });
});
