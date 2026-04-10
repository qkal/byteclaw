import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { clearActiveRuntimeWebToolsMetadata } from "../../secrets/runtime-web-tools-state.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearActiveRuntimeWebToolsMetadata();
});

describe("web tools defaults", () => {
  it("enables web_fetch by default (non-sandbox)", () => {
    const tool = createWebFetchTool({ config: {}, sandboxed: false });
    expect(tool?.name).toBe("web_fetch");
  });

  it("disables web_fetch when explicitly disabled", () => {
    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { enabled: false } } } },
      sandboxed: false,
    });
    expect(tool).toBeNull();
  });

  it("uses runtime-only web_search providers when runtime metadata is present", async () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "custom-search",
      pluginName: "Custom Search",
      provider: {
        autoDetectOrder: 1,
        createTool: () => ({
          description: "custom runtime tool",
          execute: async () => ({ ok: true }),
          parameters: {},
        }),
        credentialPath: "tools.web.search.custom.apiKey",
        envVars: ["CUSTOM_SEARCH_API_KEY"],
        getCredentialValue: () => "configured",
        hint: "Custom runtime provider",
        id: "custom",
        label: "Custom Search",
        placeholder: "custom-...",
        setCredentialValue: () => {},
        signupUrl: "https://example.com/signup",
      },
      source: "test",
    });
    setActivePluginRegistry(registry);

    const tool = createWebSearchTool({
      runtimeWebSearch: {
        diagnostics: [],
        providerConfigured: "custom",
        providerSource: "configured",
        selectedProvider: "custom",
        selectedProviderKeySource: "config",
      },
      sandboxed: true,
    });

    const result = await tool?.execute?.("call-runtime-provider", {});

    expect(tool?.description).toBe("custom runtime tool");
    expect(result?.details).toMatchObject({ ok: true });
  });
});
