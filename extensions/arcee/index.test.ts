import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../../src/secrets/provider-env-vars.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import arceePlugin from "./index.js";

describe("arcee provider plugin", () => {
  it("registers Arcee AI with direct and OpenRouter auth choices", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(provider.id).toBe("arcee");
    expect(provider.label).toBe("Arcee AI");
    expect(provider.envVars).toEqual(["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"]);
    expect(provider.auth).toHaveLength(2);

    const directChoice = resolveProviderPluginChoice({
      choice: "arceeai-api-key",
      providers: [provider],
    });
    expect(directChoice).not.toBeNull();
    expect(directChoice?.provider.id).toBe("arcee");
    expect(directChoice?.method.id).toBe("arcee-platform");

    const orChoice = resolveProviderPluginChoice({
      choice: "arceeai-openrouter",
      providers: [provider],
    });
    expect(orChoice).not.toBeNull();
    expect(orChoice?.provider.id).toBe("arcee");
    expect(orChoice?.method.id).toBe("openrouter");
  });

  it("stores the OpenRouter onboarding path under the OpenRouter auth profile", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const openRouterMethod = provider.auth?.find((method) => method.id === "openrouter");
    if (!openRouterMethod?.runNonInteractive) {
      throw new Error("expected OpenRouter non-interactive auth");
    }

    const config = await openRouterMethod.runNonInteractive({
      config: {},
      env: {},
      opts: {},
      resolveApiKey: async () => ({
        key: "sk-or-test",
        source: "profile",
      }),
      runtime: {
        error: () => {},
        exit: () => {},
        log: () => {},
      },
      toApiKeyCredential: () => null,
    } as never);

    expect(config?.auth?.profiles?.["openrouter:default"]).toMatchObject({
      mode: "api_key",
      provider: "openrouter",
    });
    expect(config?.models?.providers?.arcee).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(config?.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual([
      "arcee/trinity-mini",
      "arcee/trinity-large-preview",
      "arcee/trinity-large-thinking",
    ]);
  });

  it("keeps direct Arcee auth env candidates separate from OpenRouter", () => {
    const candidates = resolveProviderAuthEnvVarCandidates();

    expect(candidates.arcee).toEqual(["ARCEEAI_API_KEY"]);
    expect(candidates.openrouter).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("builds the direct Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
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
    expect(catalog.provider.baseUrl).toBe("https://api.arcee.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "trinity-mini",
      "trinity-large-preview",
      "trinity-large-thinking",
    ]);
  });

  it("builds the OpenRouter-backed Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "openrouter" ? { apiKey: "sk-or-test" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "sk-or-test",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "arcee/trinity-mini",
      "arcee/trinity-large-preview",
      "arcee/trinity-large-thinking",
    ]);
  });

  it("normalizes Arcee OpenRouter models to vendor-prefixed runtime ids", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(
      provider.normalizeResolvedModel?.({
        model: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          id: "trinity-large-thinking",
          name: "Trinity Large Thinking",
          provider: "arcee",
        },
        modelId: "arcee/trinity-large-thinking",
      } as never),
    ).toMatchObject({
      id: "arcee/trinity-large-thinking",
    });

    expect(
      provider.normalizeResolvedModel?.({
        model: {
          api: "openai-completions",
          baseUrl: "https://api.arcee.ai/api/v1",
          id: "trinity-large-thinking",
          name: "Trinity Large Thinking",
          provider: "arcee",
        },
        modelId: "arcee/trinity-large-thinking",
      } as never),
    ).toBeUndefined();
  });
});
