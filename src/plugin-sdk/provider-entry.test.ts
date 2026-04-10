import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import type { ProviderCatalogContext } from "../plugins/types.js";
import { defineSingleProviderPluginEntry } from "./provider-entry.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    contextWindow: 128_000,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    },
    id,
    input: ["text"],
    maxTokens: 8192,
    name,
    reasoning: false,
  };
}
function createCatalogContext(
  config: ProviderCatalogContext["config"] = {},
): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

async function captureProviderEntry(params: {
  entry: ReturnType<typeof defineSingleProviderPluginEntry>;
  config?: ProviderCatalogContext["config"];
}) {
  const captured = capturePluginRegistration(params.entry);
  const provider = captured.providers[0];
  const catalog = await provider?.catalog?.run(createCatalogContext(params.config));
  return { captured, catalog, provider };
}

describe("defineSingleProviderPluginEntry", () => {
  it("registers a single provider with default wizard metadata", async () => {
    const entry = defineSingleProviderPluginEntry({
      description: "Demo provider plugin",
      id: "demo",
      name: "Demo Provider",
      provider: {
        auth: [
          {
            defaultModel: "demo/default",
            envVar: "DEMO_API_KEY",
            flagName: "--demo-api-key",
            hint: "Shared key",
            label: "Demo API key",
            methodId: "api-key",
            optionKey: "demoApiKey",
            promptMessage: "Enter Demo API key",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.demo.test/v1",
            models: [createModel("default", "Default")],
          }),
        },
        docsPath: "/providers/demo",
        label: "Demo",
      },
    });

    const { captured, provider, catalog } = await captureProviderEntry({ entry });
    expect(captured.providers).toHaveLength(1);
    expect(provider).toMatchObject({
      docsPath: "/providers/demo",
      envVars: ["DEMO_API_KEY"],
      id: "demo",
      label: "Demo",
    });
    expect(provider?.auth).toHaveLength(1);
    expect(provider?.auth[0]).toMatchObject({
      hint: "Shared key",
      id: "api-key",
      label: "Demo API key",
    });
    expect(provider?.auth[0]?.wizard).toMatchObject({
      choiceId: "demo-api-key",
      choiceLabel: "Demo API key",
      groupHint: "Shared key",
      groupId: "demo",
      groupLabel: "Demo",
      methodId: "api-key",
    });

    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://api.demo.test/v1",
        models: [createModel("default", "Default")],
      },
    });
  });

  it("supports provider overrides, explicit env vars, and extra registration", async () => {
    const entry = defineSingleProviderPluginEntry({
      description: "Gateway provider plugin",
      id: "gateway-plugin",
      name: "Gateway Provider",
      provider: {
        aliases: ["gw"],
        auth: [
          {
            envVar: "GATEWAY_KEY",
            flagName: "--gateway-key",
            hint: "Primary key",
            label: "Gateway key",
            methodId: "api-key",
            optionKey: "gatewayKey",
            promptMessage: "Enter Gateway key",
            wizard: {
              groupId: "shared-gateway",
              groupLabel: "Shared Gateway",
            },
          },
        ],
        capabilities: {
          transcriptToolCallIdMode: "strict9",
        },
        catalog: {
          allowExplicitBaseUrl: true,
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://gateway.test/v1",
            models: [createModel("router", "Router")],
          }),
        },
        docsPath: "/providers/gateway",
        envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
        id: "gateway",
        label: "Gateway",
      },
      register(api) {
        api.registerWebSearchProvider({
          createTool: () => ({
            description: "search",
            parameters: {},
            execute: async () => ({}),
          }),
          credentialPath: "tools.web.search.gateway.apiKey",
          envVars: [],
          getCredentialValue: () => undefined,
          hint: "search",
          id: "gateway-search",
          label: "Gateway Search",
          placeholder: "",
          setCredentialValue() {},
          signupUrl: "https://example.com",
        });
      },
    });

    const { captured, provider, catalog } = await captureProviderEntry({
      config: {
        models: {
          providers: {
            gateway: {
              baseUrl: "https://override.test/v1",
              models: [createModel("router", "Router")],
            },
          },
        },
      },
      entry,
    });
    expect(captured.providers).toHaveLength(1);
    expect(captured.webSearchProviders).toHaveLength(1);

    expect(provider).toMatchObject({
      aliases: ["gw"],
      capabilities: {
        transcriptToolCallIdMode: "strict9",
      },
      envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
      id: "gateway",
      label: "Gateway",
    });
    expect(provider?.auth[0]?.wizard).toMatchObject({
      choiceId: "gateway-api-key",
      groupHint: "Primary key",
      groupId: "shared-gateway",
      groupLabel: "Shared Gateway",
    });

    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://override.test/v1",
        models: [createModel("router", "Router")],
      },
    });
  });
});
