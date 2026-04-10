import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverAuthStorageMock = vi.fn<(agentDir?: string) => { mocked: true }>(() => ({
  mocked: true,
}));
const discoverModelsMock = vi.fn<
  (authStorage: unknown, agentDir: string) => { find: ReturnType<typeof vi.fn> }
>(() => ({ find: vi.fn(() => null) }));

let hookCacheCleared = false;
const clearProviderRuntimeHookCacheMock = vi.fn<() => void>(() => {
  hookCacheCleared = true;
});
const prepareProviderDynamicModelMock = vi.fn<(params: unknown) => Promise<void>>(async () => {});
const runProviderDynamicModelMock = vi.fn<(params: unknown) => unknown>(() =>
  hookCacheCleared
    ? {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        contextWindow: 1_050_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 128_000,
        name: "gpt-5.4",
        provider: "openai-codex",
        reasoning: true,
      }
    : undefined,
);

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: discoverAuthStorageMock,
  discoverModels: discoverModelsMock,
}));

describe("resolveModelAsync startup retry", () => {
  const runtimeHooks = {
    applyProviderResolvedModelCompatWithPlugins: () => undefined,
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    clearProviderRuntimeHookCache: clearProviderRuntimeHookCacheMock,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    prepareProviderDynamicModel: (params: unknown) => prepareProviderDynamicModelMock(params),
    runProviderDynamicModel: (params: unknown) => runProviderDynamicModelMock(params),
  };

  beforeEach(() => {
    hookCacheCleared = false;
    clearProviderRuntimeHookCacheMock.mockClear();
    prepareProviderDynamicModelMock.mockClear();
    runProviderDynamicModelMock.mockClear();
    discoverAuthStorageMock.mockClear();
    discoverModelsMock.mockClear();
  });

  it("retries once after clearing the provider-runtime hook cache", async () => {
    const { resolveModelAsync } = await import("./model.js");

    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      {},
      {
        retryTransientProviderRuntimeMiss: true,
        runtimeHooks,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-codex-responses",
      id: "gpt-5.4",
      provider: "openai-codex",
    });
    expect(clearProviderRuntimeHookCacheMock).toHaveBeenCalledTimes(1);
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(2);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(2);
  });

  it("does not clear the hook cache during steady-state misses", async () => {
    const { resolveModelAsync } = await import("./model.js");

    const result = await resolveModelAsync(
      "openai-codex",
      "gpt-5.4",
      "/tmp/agent",
      {},
      { runtimeHooks },
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai-codex/gpt-5.4");
    expect(clearProviderRuntimeHookCacheMock).not.toHaveBeenCalled();
    expect(prepareProviderDynamicModelMock).toHaveBeenCalledTimes(1);
    expect(runProviderDynamicModelMock).toHaveBeenCalledTimes(1);
  });
});
