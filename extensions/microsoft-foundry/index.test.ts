import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import { getAccessTokenResultAsync } from "./cli.js";
import plugin from "./index.js";
import { buildFoundryConnectionTest, isValidTenantIdentifier } from "./onboard.js";
import { resetFoundryRuntimeAuthCaches } from "./runtime.js";
import {
  buildFoundryAuthResult,
  normalizeFoundryEndpoint,
  requiresFoundryMaxCompletionTokens,
  supportsFoundryImageInput,
  usesFoundryResponsesByDefault,
} from "./shared.js";

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() =>
  vi.fn(() => ({
    profiles: {},
  })),
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return {
    ...actual,
    ensureAuthProfileStore: ensureAuthProfileStoreMock,
  };
});

function registerProvider() {
  const registerProviderMock = vi.fn();
  plugin.register(
    createTestPluginApi({
      config: {},
      id: "microsoft-foundry",
      name: "Microsoft Foundry",
      registerProvider: registerProviderMock,
      runtime: {} as never,
      source: "test",
    }),
  );
  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return registerProviderMock.mock.calls[0]?.[0];
}

const defaultFoundryBaseUrl = "https://example.services.ai.azure.com/openai/v1";
const defaultFoundryProviderId = "microsoft-foundry";
const defaultFoundryModelId = "gpt-5.4";
const defaultFoundryProfileId = "microsoft-foundry:entra";
const defaultFoundryAgentDir = "/tmp/test-agent";
const defaultAzureCliLoginError = "Please run 'az login' to setup account.";

function buildFoundryModel(
  overrides: Partial<{
    provider: string;
    id: string;
    name: string;
    api: "openai-responses" | "openai-completions";
    baseUrl: string;
    input: ("text" | "image")[];
  }> = {},
) {
  return {
    api: "openai-responses" as const,
    baseUrl: defaultFoundryBaseUrl,
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id: defaultFoundryModelId,
    input: ["text" as const],
    maxTokens: 16_384,
    name: defaultFoundryModelId,
    provider: defaultFoundryProviderId,
    reasoning: false,
    ...overrides,
  };
}

function buildFoundryConfig(params?: {
  profileIds?: string[];
  orderedProfileIds?: string[];
  models?: ReturnType<typeof buildFoundryModel>[];
}) {
  const profileIds = params?.profileIds ?? [];
  const orderedProfileIds = params?.orderedProfileIds;
  return {
    auth: {
      profiles: Object.fromEntries(
        profileIds.map((profileId) => [
          profileId,
          {
            mode: "api_key" as const,
            provider: defaultFoundryProviderId,
          },
        ]),
      ),
      ...(orderedProfileIds
        ? {
            order: {
              [defaultFoundryProviderId]: orderedProfileIds,
            },
          }
        : {}),
    },
    models: {
      providers: {
        [defaultFoundryProviderId]: {
          api: "openai-responses" as const,
          baseUrl: defaultFoundryBaseUrl,
          models: params?.models ?? [buildFoundryModel()],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function buildEntraProfileStore(
  overrides: Partial<{
    endpoint: string;
    modelId: string;
    modelName: string;
    tenantId: string;
  }> = {},
) {
  return {
    profiles: {
      [defaultFoundryProfileId]: {
        metadata: {
          authMethod: "entra-id",
          endpoint: "https://example.services.ai.azure.com",
          modelId: "custom-deployment",
          modelName: defaultFoundryModelId,
          tenantId: "tenant-id",
          ...overrides,
        },
        provider: defaultFoundryProviderId,
        type: "api_key",
      },
    },
  };
}

function buildFoundryRuntimeAuthContext(
  overrides: Partial<{
    provider: string;
    modelId: string;
    model: ReturnType<typeof buildFoundryModel>;
    apiKey: string;
    authMode: "api_key";
    profileId: string;
    agentDir: string;
  }> = {},
) {
  const modelId = overrides.modelId ?? "custom-deployment";
  return {
    agentDir: defaultFoundryAgentDir,
    apiKey: "__entra_id_dynamic__",
    authMode: "api_key" as const,
    env: process.env,
    model: buildFoundryModel({ id: modelId, ...("model" in overrides ? overrides.model : {}) }),
    modelId,
    profileId: defaultFoundryProfileId,
    provider: defaultFoundryProviderId,
    ...overrides,
  };
}

function mockAzureCliToken(params: { accessToken: string; expiresInMs: number; delayMs?: number }) {
  execFileMock.mockImplementationOnce(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const respond = () =>
        callback(
          null,
          JSON.stringify({
            accessToken: params.accessToken,
            expiresOn: new Date(Date.now() + params.expiresInMs).toISOString(),
          }),
          "",
        );
      if (params.delayMs) {
        setTimeout(respond, params.delayMs);
        return;
      }
      respond();
    },
  );
}

function mockAzureCliLoginFailure(delayMs?: number) {
  execFileMock.mockImplementationOnce(
    (
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const respond = () => {
        callback(new Error("az failed"), "", defaultAzureCliLoginError);
      };
      if (delayMs) {
        setTimeout(respond, delayMs);
        return;
      }
      respond();
    },
  );
}

describe("microsoft-foundry plugin", () => {
  beforeEach(() => {
    resetFoundryRuntimeAuthCaches();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ profiles: {} });
  });

  it("keeps the API key profile bound when multiple auth profiles exist without explicit order", async () => {
    const provider = registerProvider();
    const config = buildFoundryConfig({
      profileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });

    await provider.onModelSelected?.({
      agentDir: "/tmp/test-agent",
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toBeUndefined();
  });

  it("uses the active ordered API key profile when model selection rebinding is needed", async () => {
    const provider = registerProvider();
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:default": {
          metadata: { authMethod: "api-key" },
          provider: "microsoft-foundry",
          type: "api_key",
        },
      },
    });
    const config = buildFoundryConfig({
      orderedProfileIds: ["microsoft-foundry:default"],
      profileIds: ["microsoft-foundry:default"],
    });

    await provider.onModelSelected?.({
      agentDir: "/tmp/test-agent",
      config,
      model: "microsoft-foundry/gpt-5.4",
      prompter: {} as never,
    });

    expect(config.auth?.order?.["microsoft-foundry"]).toEqual(["microsoft-foundry:default"]);
  });

  it("preserves the model-derived base URL for Entra runtime auth refresh", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "test-token", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce(buildEntraProfileStore());

    const prepared = await provider.prepareRuntimeAuth?.(buildFoundryRuntimeAuthContext());

    expect(prepared?.baseUrl).toBe("https://example.services.ai.azure.com/openai/v1");
  });

  it("retries Entra token refresh after a failed attempt", async () => {
    const provider = registerProvider();
    mockAzureCliLoginFailure();
    mockAzureCliToken({ accessToken: "retry-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).rejects.toThrow(
      "Azure CLI is not logged in",
    );

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "retry-token",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent Entra token refreshes for the same profile", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "deduped-token", delayMs: 10, expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const [first, second] = await Promise.all([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(first?.apiKey).toBe("deduped-token");
    expect(second?.apiKey).toBe("deduped-token");
  });

  it("clears failed refresh state so later concurrent retries succeed", async () => {
    const provider = registerProvider();
    mockAzureCliLoginFailure(10);
    mockAzureCliToken({ accessToken: "recovered-token", delayMs: 10, expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    const failed = await Promise.allSettled([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [first, second] = await Promise.all([
      provider.prepareRuntimeAuth?.(runtimeContext),
      provider.prepareRuntimeAuth?.(runtimeContext),
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(first?.apiKey).toBe("recovered-token");
    expect(second?.apiKey).toBe("recovered-token");
  });

  it("refreshes again when a cached token is too close to expiry", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "soon-expiring-token", expiresInMs: 60_000 });
    mockAzureCliToken({ accessToken: "fresh-token", expiresInMs: 10 * 60_000 });
    ensureAuthProfileStoreMock.mockReturnValue(buildEntraProfileStore());

    const runtimeContext = buildFoundryRuntimeAuthContext();

    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "soon-expiring-token",
    });
    await expect(provider.prepareRuntimeAuth?.(runtimeContext)).resolves.toMatchObject({
      apiKey: "fresh-token",
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps other configured Foundry models when switching the selected model", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        order: {
          "microsoft-foundry": ["microsoft-foundry:default"],
        },
        profiles: {
          "microsoft-foundry:default": {
            mode: "api_key" as const,
            provider: "microsoft-foundry",
          },
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            api: "openai-responses",
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            models: [
              {
                contextWindow: 128_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "alias-one",
                input: ["text"],
                maxTokens: 16_384,
                name: "gpt-5.4",
                reasoning: false,
              },
              {
                contextWindow: 128_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "alias-two",
                input: ["text"],
                maxTokens: 16_384,
                name: "gpt-4o",
                reasoning: false,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      agentDir: "/tmp/test-agent",
      config,
      model: "microsoft-foundry/alias-one",
      prompter: {} as never,
    });

    expect(
      config.models?.providers?.["microsoft-foundry"]?.models.map((model) => model.id),
    ).toEqual(["alias-one", "alias-two"]);
    expect(config.models?.providers?.["microsoft-foundry"]?.models[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("accepts tenant domains as valid tenant identifiers", () => {
    expect(isValidTenantIdentifier("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantIdentifier("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isValidTenantIdentifier("not a tenant")).toBe(false);
  });

  it("defaults Azure OpenAI model families to the documented API surfaces", () => {
    expect(usesFoundryResponsesByDefault("gpt-5.4")).toBe(true);
    expect(usesFoundryResponsesByDefault("gpt-5.2-codex")).toBe(true);
    expect(usesFoundryResponsesByDefault("o4-mini")).toBe(true);
    expect(usesFoundryResponsesByDefault("MAI-DS-R1")).toBe(false);
    expect(requiresFoundryMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("o3")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-4o")).toBe(false);
    expect(supportsFoundryImageInput("gpt-5.4")).toBe(true);
    expect(supportsFoundryImageInput("gpt-4o")).toBe(true);
    expect(supportsFoundryImageInput("MAI-DS-R1")).toBe(false);
  });

  it("records GPT-family Foundry deployments as image-capable during auth setup", () => {
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: "__entra_id_dynamic__",
      authMethod: "entra-id",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      profileId: "microsoft-foundry:entra",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0]?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("normalizes stale resolved Foundry rows to provider-owned image capability metadata", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      model: buildFoundryModel({
        id: "deployment-gpt5",
        input: ["text"],
        name: "gpt-5.4",
      }),
      modelId: "deployment-gpt5",
      provider: "microsoft-foundry",
    });

    expect(normalized).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      compat: {
        maxTokensField: "max_completion_tokens",
        supportsStore: false,
      },
      input: ["text", "image"],
      name: "gpt-5.4",
    });
  });

  it("preserves explicit image capability for non-heuristic Foundry deployments", () => {
    const provider = registerProvider();

    const normalized = provider.normalizeResolvedModel?.({
      model: buildFoundryModel({
        id: "custom-vision-deployment",
        input: ["text", "image"],
        name: "internal alias",
      }),
      modelId: "custom-vision-deployment",
      provider: "microsoft-foundry",
    });

    expect(normalized).toMatchObject({
      input: ["text", "image"],
      name: "internal alias",
    });
  });

  it("writes Azure API key header overrides for API-key auth configs", () => {
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: "test-api-key",
      authMethod: "api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      profileId: "microsoft-foundry:default",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: "test-api-key",
      authHeader: false,
      headers: { "api-key": "test-api-key" },
    });
  });

  it("uses the minimum supported response token count for GPT-5 connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      api: "openai-responses",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      modelNameHint: "gpt-5.4",
    });

    expect(testRequest.url).toContain("/responses");
    expect(testRequest.body).toMatchObject({
      max_output_tokens: 16,
      model: "gpt-5.4",
    });
  });

  it("marks Foundry responses models to omit explicit store=false payloads", () => {
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: "__entra_id_dynamic__",
      authMethod: "entra-id",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.2-codex",
      modelNameHint: "gpt-5.2-codex",
      profileId: "microsoft-foundry:entra",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models[0]?.compat).toMatchObject({
      maxTokensField: "max_completion_tokens",
      supportsStore: false,
    });
  });

  it("keeps persisted response-mode routing for custom deployment aliases", async () => {
    const provider = registerProvider();
    const config: OpenClawConfig = {
      auth: {
        order: {
          "microsoft-foundry": ["microsoft-foundry:entra"],
        },
        profiles: {
          "microsoft-foundry:entra": {
            mode: "api_key" as const,
            provider: "microsoft-foundry",
          },
        },
      },
      models: {
        providers: {
          "microsoft-foundry": {
            api: "openai-responses",
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            models: [
              {
                api: "openai-responses",
                contextWindow: 128_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "prod-primary",
                input: ["text"],
                maxTokens: 16_384,
                name: "production alias",
                reasoning: false,
              },
            ],
          },
        },
      },
    };

    await provider.onModelSelected?.({
      agentDir: "/tmp/test-agent",
      config,
      model: "microsoft-foundry/prod-primary",
      prompter: {} as never,
    });

    expect(config.models?.providers?.["microsoft-foundry"]?.api).toBe("openai-responses");
    expect(config.models?.providers?.["microsoft-foundry"]?.baseUrl).toBe(
      "https://example.services.ai.azure.com/openai/v1",
    );
    expect(config.models?.providers?.["microsoft-foundry"]?.models[0]?.api).toBe(
      "openai-responses",
    );
  });

  it("normalizes pasted Azure chat completion request URLs to the resource endpoint", () => {
    expect(
      normalizeFoundryEndpoint(
        "https://example.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-12-01-preview",
      ),
    ).toBe("https://example.openai.azure.com");
  });

  it("preserves project-scoped endpoint prefixes when extracting the Foundry endpoint", async () => {
    const provider = registerProvider();
    mockAzureCliToken({ accessToken: "test-token", expiresInMs: 60_000 });
    ensureAuthProfileStoreMock.mockReturnValueOnce({ profiles: {} });

    const prepared = await provider.prepareRuntimeAuth?.(
      buildFoundryRuntimeAuthContext({
        model: buildFoundryModel({
          baseUrl: "https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses",
          id: "deployment-gpt5",
        }),
        modelId: "deployment-gpt5",
      }),
    );

    expect(prepared?.baseUrl).toBe(
      "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
    );
  });

  it("normalizes pasted Foundry responses request URLs to the resource endpoint", () => {
    expect(
      normalizeFoundryEndpoint(
        "https://example.services.ai.azure.com/openai/v1/responses?api-version=preview",
      ),
    ).toBe("https://example.services.ai.azure.com");
  });

  it("includes api-version for non GPT-5 chat completion connection tests", () => {
    const testRequest = buildFoundryConnectionTest({
      api: "openai-completions",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "FW-GLM-5",
      modelNameHint: "FW-GLM-5",
    });

    expect(testRequest.url).toContain("/chat/completions");
    expect(testRequest.body).toMatchObject({
      max_tokens: 1,
      model: "FW-GLM-5",
    });
  });

  it("returns actionable Azure CLI login errors", async () => {
    mockAzureCliLoginFailure();

    await expect(getAccessTokenResultAsync()).rejects.toThrow("Azure CLI is not logged in");
  });

  it("keeps Azure API key header overrides when API-key auth uses a secret ref", () => {
    const secretRef = {
      id: "AZURE_OPENAI_API_KEY",
      provider: "default",
      source: "env" as const,
    };
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: secretRef,
      authMethod: "api-key",
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-4o",
      profileId: "microsoft-foundry:default",
    });

    expect(result.configPatch?.models?.providers?.["microsoft-foundry"]).toMatchObject({
      apiKey: secretRef,
      authHeader: false,
      headers: { "api-key": secretRef },
    });
  });

  it("moves the selected Foundry auth profile to the front of auth.order", () => {
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: "__entra_id_dynamic__",
      authMethod: "entra-id",
      currentProviderProfileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
      endpoint: "https://example.services.ai.azure.com",
      modelId: "gpt-5.4",
      profileId: "microsoft-foundry:entra",
    });

    expect(result.configPatch?.auth?.order?.["microsoft-foundry"]).toEqual([
      "microsoft-foundry:entra",
      "microsoft-foundry:default",
    ]);
  });

  it("persists discovered deployments alongside the selected default model", () => {
    const result = buildFoundryAuthResult({
      api: "openai-responses",
      apiKey: "__entra_id_dynamic__",
      authMethod: "entra-id",
      deployments: [
        { api: "openai-responses", modelName: "gpt-5.4", name: "deployment-gpt5" },
        { api: "openai-responses", modelName: "gpt-4o", name: "deployment-gpt4o" },
      ],
      endpoint: "https://example.services.ai.azure.com",
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      profileId: "microsoft-foundry:entra",
    });

    const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
    expect(provider?.models.map((model) => model.id)).toEqual([
      "deployment-gpt5",
      "deployment-gpt4o",
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
  });
});
