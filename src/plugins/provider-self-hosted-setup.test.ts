import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureOpenAICompatibleSelfHostedProviderNonInteractive } from "./provider-self-hosted-setup.js";
import type { ProviderAuthMethodNonInteractiveContext } from "./types.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createContext(params: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}): ProviderAuthMethodNonInteractiveContext {
  const resolved = {
    key: params.apiKey ?? "self-hosted-test-key",
    source: "flag" as const,
  };
  return {
    agentDir: "/tmp/openclaw-self-hosted-test-agent",
    authChoice: params.providerId,
    baseConfig: { agents: { defaults: {} } },
    config: { agents: { defaults: {} } },
    opts: {
      customApiKey: params.apiKey,
      customBaseUrl: params.baseUrl,
      customModelId: params.modelId,
    },
    resolveApiKey: vi.fn<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>(
      async () => resolved,
    ),
    runtime: createRuntime() as never,
    toApiKeyCredential: vi.fn<ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]>(
      ({ provider, resolved: apiKeyResult }) => ({
        key: apiKeyResult.key,
        provider,
        type: "api_key",
      }),
    ),
  };
}

function readPrimaryModel(config: Awaited<ReturnType<typeof configureSelfHostedTestProvider>>) {
  const model = config?.agents?.defaults?.model;
  return model && typeof model === "object" ? model.primary : undefined;
}

async function configureSelfHostedTestProvider(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  envVar: string;
}) {
  return await configureOpenAICompatibleSelfHostedProviderNonInteractive({
    ctx: params.ctx,
    defaultApiKeyEnvVar: params.envVar,
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    modelPlaceholder: "Qwen/Qwen3-32B",
    providerId: params.providerId,
    providerLabel: params.providerLabel,
  });
}

describe("configureOpenAICompatibleSelfHostedProviderNonInteractive", () => {
  it.each([
    {
      apiKey: "vllm-test-key",
      baseUrl: "http://127.0.0.1:8100/v1/",
      envVar: "VLLM_API_KEY",
      modelId: "Qwen/Qwen3-8B",
      providerId: "vllm",
      providerLabel: "vLLM",
    },
    {
      apiKey: "sglang-test-key",
      baseUrl: "http://127.0.0.1:31000/v1",
      envVar: "SGLANG_API_KEY",
      modelId: "Qwen/Qwen3-32B",
      providerId: "sglang",
      providerLabel: "SGLang",
    },
  ])("configures $providerLabel config and auth profile", async (params) => {
    const ctx = createContext(params);

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      envVar: params.envVar,
      providerId: params.providerId,
      providerLabel: params.providerLabel,
    });

    const profileId = `${params.providerId}:default`;
    expect(cfg?.auth?.profiles?.[profileId]).toEqual({
      mode: "api_key",
      provider: params.providerId,
    });
    expect(cfg?.models?.providers?.[params.providerId]).toEqual({
      api: "openai-completions",
      apiKey: params.envVar,
      baseUrl: params.baseUrl.replace(/\/+$/, ""),
      models: [
        expect.objectContaining({
          id: params.modelId,
        }),
      ],
    });
    expect(readPrimaryModel(cfg)).toBe(`${params.providerId}/${params.modelId}`);
    expect(ctx.resolveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        envVar: params.envVar,
        flagName: "--custom-api-key",
      }),
    );
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
      agentDir: ctx.agentDir,
      credential: {
        key: params.apiKey,
        provider: params.providerId,
        type: "api_key",
      },
      profileId,
    });
  });

  it("exits without touching auth when custom model id is missing", async () => {
    const ctx = createContext({
      apiKey: "vllm-test-key",
      providerId: "vllm",
    });

    const cfg = await configureSelfHostedTestProvider({
      ctx,
      envVar: "VLLM_API_KEY",
      providerId: "vllm",
      providerLabel: "vLLM",
    });

    expect(cfg).toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing --custom-model-id for --auth-choice vllm."),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
    expect(ctx.resolveApiKey).not.toHaveBeenCalled();
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
  });
});
