import type { Api, Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../auth-profiles.js";

const mocks = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
  };
});

vi.mock("../../model-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js");
  return {
    ...actual,
    getApiKeyForModel: mocks.getApiKeyForModel,
  };
});

import { createEmbeddedRunAuthController } from "./auth-controller.js";

function createTestModel(): Model<Api> {
  return {
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    contextWindow: 8000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    headers: {
      Authorization: "Bearer stale-token",
    },
    id: "test-model",
    input: ["text"],
    maxTokens: 4000,
    name: "test-model",
    provider: "custom-openai",
    reasoning: false,
  } as Model<Api>;
}

describe("createEmbeddedRunAuthController", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModel.mockReset();
  });

  it("applies runtime request overrides on the first auth exchange", async () => {
    let runtimeModel = createTestModel();
    let effectiveModel = createTestModel();
    let runtimeAuthState: {
      sourceApiKey: string;
      authMode: string;
      profileId?: string;
      expiresAt?: number;
    } | null = null;
    let apiKeyInfo: unknown = null;
    let lastProfileId: string | undefined;
    const setRuntimeApiKey = vi.fn();

    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "source-api-key",
      mode: "api-key",
      profileId: "default",
      source: "env",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "runtime-api-key",
      baseUrl: "https://runtime.example.com/v1",
      request: {
        auth: {
          headerName: "api-key",
          mode: "header",
          value: "runtime-header-token",
        },
      },
    });

    const controller = createEmbeddedRunAuthController({
      agentDir: "/tmp/agent",
      allowTransientCooldownProbe: false,
      attemptedThinking: new Set(),
      authStorage: { setRuntimeApiKey },
      authStore: {
        profiles: {},
        version: 1,
      } as AuthProfileStore,
      config: undefined,
      fallbackConfigured: false,
      getApiKeyInfo: () => apiKeyInfo as never,
      getEffectiveModel: () => effectiveModel,
      getLastProfileId: () => lastProfileId,
      getModelId: () => "test-model",
      getProfileIndex: () => 0,
      getProvider: () => "custom-openai",
      getRuntimeAuthRefreshCancelled: () => false,
      getRuntimeAuthState: () => runtimeAuthState as never,
      getRuntimeModel: () => runtimeModel,
      initialThinkLevel: "medium",
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
      profileCandidates: ["default"],
      setApiKeyInfo: (next) => {
        apiKeyInfo = next;
      },
      setEffectiveModel: (next) => {
        effectiveModel = next;
      },
      setLastProfileId: (next) => {
        lastProfileId = next;
      },
      setProfileIndex: () => undefined,
      setRuntimeAuthRefreshCancelled: () => undefined,
      setRuntimeAuthState: (next) => {
        runtimeAuthState = next;
      },
      setRuntimeModel: (next) => {
        runtimeModel = next;
      },
      setThinkLevel: () => undefined,
      workspaceDir: "/tmp/workspace",
    });

    await controller.initializeAuthProfile();

    expect(runtimeModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(runtimeModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(effectiveModel.baseUrl).toBe("https://runtime.example.com/v1");
    expect(effectiveModel.headers).toEqual({
      "api-key": "runtime-header-token",
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("custom-openai", "runtime-api-key");
    expect(runtimeAuthState).toMatchObject({
      authMode: "api-key",
      profileId: "default",
      sourceApiKey: "source-api-key",
    });
  });

  it("rejects privileged runtime transport overrides on the first auth exchange", async () => {
    let runtimeModel = createTestModel();

    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "source-api-key",
      mode: "api-key",
      profileId: "default",
      source: "env",
    });
    mocks.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "runtime-api-key",
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    });

    const controller = createEmbeddedRunAuthController({
      agentDir: "/tmp/agent",
      allowTransientCooldownProbe: false,
      attemptedThinking: new Set(),
      authStorage: { setRuntimeApiKey: vi.fn() },
      authStore: {
        profiles: {},
        version: 1,
      } as AuthProfileStore,
      config: undefined,
      fallbackConfigured: false,
      getApiKeyInfo: () => null as never,
      getEffectiveModel: () => runtimeModel,
      getLastProfileId: () => undefined,
      getModelId: () => "test-model",
      getProfileIndex: () => 0,
      getProvider: () => "custom-openai",
      getRuntimeAuthRefreshCancelled: () => false,
      getRuntimeAuthState: () => null,
      getRuntimeModel: () => runtimeModel,
      initialThinkLevel: "medium",
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
      profileCandidates: ["default"],
      setApiKeyInfo: () => undefined,
      setEffectiveModel: () => undefined,
      setLastProfileId: () => undefined,
      setProfileIndex: () => undefined,
      setRuntimeAuthRefreshCancelled: () => undefined,
      setRuntimeAuthState: () => undefined,
      setRuntimeModel: (next) => {
        runtimeModel = next;
      },
      setThinkLevel: () => undefined,
      workspaceDir: "/tmp/workspace",
    });

    await expect(controller.initializeAuthProfile()).rejects.toThrow(
      /runtime auth request overrides do not allow proxy or tls/i,
    );
  });
});
