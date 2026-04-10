import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../plugins/manifest-registry.js");
vi.unmock("../plugins/provider-runtime.js");
vi.unmock("../plugins/provider-runtime.runtime.js");
vi.unmock("../secrets/provider-env-vars.js");

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [{ resetProviderRuntimeHookCacheForTest }, { resetPluginLoaderTestStateForTest }] =
    await Promise.all([
      import("../plugins/provider-runtime.js"),
      import("../plugins/loader.test-fixtures.js"),
    ]);
  resetPluginLoaderTestStateForTest();
  resetProviderRuntimeHookCacheForTest();
  return import("./models-config.providers.secrets.js");
}

beforeEach(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [{ resetProviderRuntimeHookCacheForTest }, { resetPluginLoaderTestStateForTest }] =
    await Promise.all([
      import("../plugins/provider-runtime.js"),
      import("../plugins/loader.test-fixtures.js"),
    ]);
  resetPluginLoaderTestStateForTest();
  resetProviderRuntimeHookCacheForTest();
});

describe("models-config", () => {
  it("fills missing provider.apiKey from env var name when models exist", async () => {
    const { resolveMissingProviderApiKey } = await loadSecretsModule();
    const provider = resolveMissingProviderApiKey({
      env: { MINIMAX_API_KEY: "sk-minimax-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
      provider: {
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        models: [
          {
            contextWindow: 200000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "MiniMax-M2.7",
            input: ["text"],
            maxTokens: 8192,
            name: "MiniMax M2.7",
            reasoning: false,
          },
        ],
      },
      providerKey: "minimax",
    });

    expect(provider.apiKey).toBe("MINIMAX_API_KEY"); // Pragma: allowlist secret
  });
});
