import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  applyLocalNoAuthHeaderOverrideMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
  resolveModelMock: vi.fn(),
  setRuntimeApiKeyMock: vi.fn(),
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModel: hoisted.resolveModelMock,
}));

vi.mock("./model-auth.js", () => ({
  applyLocalNoAuthHeaderOverride: hoisted.applyLocalNoAuthHeaderOverrideMock,
  getApiKeyForModel: hoisted.getApiKeyForModelMock,
}));

vi.mock("./github-copilot-token.js", () => ({
  resolveCopilotApiToken: hoisted.resolveCopilotApiTokenMock,
}));

let prepareSimpleCompletionModel: typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModel;

beforeAll(async () => {
  ({ prepareSimpleCompletionModel } = await import("./simple-completion-runtime.js"));
});

beforeEach(() => {
  hoisted.resolveModelMock.mockReset();
  hoisted.getApiKeyForModelMock.mockReset();
  hoisted.applyLocalNoAuthHeaderOverrideMock.mockReset();
  hoisted.setRuntimeApiKeyMock.mockReset();
  hoisted.resolveCopilotApiTokenMock.mockReset();

  hoisted.applyLocalNoAuthHeaderOverrideMock.mockImplementation((model: unknown) => model);

  hoisted.resolveModelMock.mockReturnValue({
    authStorage: {
      setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
    },
    model: {
      id: "claude-opus-4-6",
      provider: "anthropic",
    },
    modelRegistry: {},
  });
  hoisted.getApiKeyForModelMock.mockResolvedValue({
    apiKey: "sk-test",
    mode: "api-key",
    source: "env:TEST_API_KEY",
  });
  hoisted.resolveCopilotApiTokenMock.mockResolvedValue({
    baseUrl: "https://api.individual.githubcopilot.com",
    expiresAt: Date.now() + 60_000,
    source: "cache:/tmp/copilot-token.json",
    token: "copilot-runtime-token",
  });
});

describe("prepareSimpleCompletionModel", () => {
  it("resolves model auth and sets runtime api key", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: " sk-test ",
      mode: "api-key",
      source: "env:TEST_API_KEY",
    });

    const result = await prepareSimpleCompletionModel({
      agentDir: "/tmp/openclaw-agent",
      cfg: undefined,
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toEqual(
      expect.objectContaining({
        auth: expect.objectContaining({
          mode: "api-key",
          source: "env:TEST_API_KEY",
        }),
        model: expect.objectContaining({
          id: "claude-opus-4-6",
          provider: "anthropic",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith("anthropic", "sk-test");
  });

  it("returns error when model resolution fails", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      error: "Unknown model: anthropic/missing-model",
      modelRegistry: {},
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "missing-model",
      provider: "anthropic",
    });

    expect(result).toEqual({
      error: "Unknown model: anthropic/missing-model",
    });
    expect(hoisted.getApiKeyForModelMock).not.toHaveBeenCalled();
  });

  it("returns error when api key is missing and mode is not allowlisted", async () => {
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      mode: "api-key",
      source: "models.providers.anthropic",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toEqual({
      auth: {
        mode: "api-key",
        source: "models.providers.anthropic",
      },
      error: 'No API key resolved for provider "anthropic" (auth mode: api-key).',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("continues without api key when auth mode is allowlisted", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      model: {
        id: "anthropic.claude-sonnet-4-6",
        provider: "amazon-bedrock",
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });

    const result = await prepareSimpleCompletionModel({
      allowMissingApiKeyModes: ["aws-sdk"],
      cfg: undefined,
      modelId: "anthropic.claude-sonnet-4-6",
      provider: "amazon-bedrock",
    });

    expect(result).toEqual(
      expect.objectContaining({
        auth: {
          mode: "aws-sdk",
          source: "aws-sdk default chain",
        },
        model: expect.objectContaining({
          id: "anthropic.claude-sonnet-4-6",
          provider: "amazon-bedrock",
        }),
      }),
    );
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("exchanges github token when provider is github-copilot", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      model: {
        id: "gpt-4.1",
        provider: "github-copilot",
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      mode: "token",
      source: "profile:github-copilot:default",
    });

    await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "gpt-4.1",
      provider: "github-copilot",
    });

    expect(hoisted.resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "ghu_test",
    });
    expect(hoisted.setRuntimeApiKeyMock).toHaveBeenCalledWith(
      "github-copilot",
      "copilot-runtime-token",
    );
  });

  it("returns exchanged copilot token in auth.apiKey for github-copilot provider", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      model: {
        id: "gpt-4.1",
        provider: "github-copilot",
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_original_github_token",
      mode: "token",
      source: "profile:github-copilot:default",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "gpt-4.1",
      provider: "github-copilot",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }

    // The returned auth.apiKey should be the exchanged runtime token,
    // Not the original GitHub token
    expect(result.auth.apiKey).toBe("copilot-runtime-token");
    expect(result.auth.apiKey).not.toBe("ghu_original_github_token");
  });

  it("applies exchanged copilot baseUrl to returned model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      model: {
        id: "gpt-4.1",
        provider: "github-copilot",
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "ghu_test",
      mode: "token",
      source: "profile:github-copilot:default",
    });
    hoisted.resolveCopilotApiTokenMock.mockResolvedValueOnce({
      baseUrl: "https://api.copilot.enterprise.example",
      expiresAt: Date.now() + 60_000,
      source: "cache:/tmp/copilot-token.json",
      token: "copilot-runtime-token",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "gpt-4.1",
      provider: "github-copilot",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) {
      return;
    }
    expect(result.model).toEqual(
      expect.objectContaining({
        baseUrl: "https://api.copilot.enterprise.example",
      }),
    );
  });

  it("returns error when getApiKeyForModel throws", async () => {
    hoisted.getApiKeyForModelMock.mockRejectedValueOnce(new Error("Profile not found: copilot"));

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toEqual({
      error: 'Auth lookup failed for provider "anthropic": Profile not found: copilot',
    });
    expect(hoisted.setRuntimeApiKeyMock).not.toHaveBeenCalled();
  });

  it("applies local no-auth header override before returning model", async () => {
    hoisted.resolveModelMock.mockReturnValueOnce({
      authStorage: {
        setRuntimeApiKey: hoisted.setRuntimeApiKeyMock,
      },
      model: {
        api: "openai-completions",
        id: "chat-local",
        provider: "local-openai",
      },
      modelRegistry: {},
    });
    hoisted.getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "custom-local",
      mode: "api-key",
      source: "models.providers.local-openai (synthetic local key)",
    });
    hoisted.applyLocalNoAuthHeaderOverrideMock.mockReturnValueOnce({
      api: "openai-completions",
      headers: { Authorization: null },
      id: "chat-local",
      provider: "local-openai",
    });

    const result = await prepareSimpleCompletionModel({
      cfg: undefined,
      modelId: "chat-local",
      provider: "local-openai",
    });

    expect(hoisted.applyLocalNoAuthHeaderOverrideMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "chat-local",
        provider: "local-openai",
      }),
      expect.objectContaining({
        apiKey: "custom-local",
        mode: "api-key",
        source: "models.providers.local-openai (synthetic local key)",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: null }),
        }),
      }),
    );
  });
});
