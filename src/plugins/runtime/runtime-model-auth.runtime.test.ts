import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: hoisted.getApiKeyForModel,
  resolveApiKeyForProvider: hoisted.resolveApiKeyForProvider,
}));

vi.mock("../provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuth,
}));

let getRuntimeAuthForModel: typeof import("./runtime-model-auth.runtime.js").getRuntimeAuthForModel;

const MODEL = {
  api: "openai-responses",
  baseUrl: "https://api.githubcopilot.com",
  id: "github-copilot/gpt-4o",
  provider: "github-copilot",
};

describe("runtime-model-auth.runtime", () => {
  beforeAll(async () => {
    ({ getRuntimeAuthForModel } = await import("./runtime-model-auth.runtime.js"));
  });

  beforeEach(() => {
    hoisted.getApiKeyForModel.mockReset();
    hoisted.resolveApiKeyForProvider.mockReset();
    hoisted.prepareProviderRuntimeAuth.mockReset();
  });

  it("returns provider-prepared runtime auth when the provider transforms credentials", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "github-device-token",
      mode: "token",
      profileId: "github-copilot:github",
      source: "profile:github-copilot:github",
    });
    hoisted.prepareProviderRuntimeAuth.mockResolvedValue({
      apiKey: "copilot-bearer-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: 123,
    });

    await expect(
      getRuntimeAuthForModel({
        model: MODEL as never,
      }),
    ).resolves.toEqual({
      apiKey: "copilot-bearer-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      expiresAt: 123,
      mode: "token",
      profileId: "github-copilot:github",
      source: "profile:github-copilot:github",
    });
    expect(hoisted.prepareProviderRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          apiKey: "github-device-token",
          modelId: "github-copilot/gpt-4o",
          provider: "github-copilot",
        }),
        provider: "github-copilot",
      }),
    );
  });

  it("falls back to raw auth when the provider has no runtime auth hook", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      apiKey: "plain-api-key",
      mode: "api-key",
      source: "env:OPENAI_API_KEY",
    });
    hoisted.prepareProviderRuntimeAuth.mockResolvedValue(undefined);

    await expect(
      getRuntimeAuthForModel({
        model: {
          ...MODEL,
          id: "openai/gpt-5.4",
          provider: "openai",
        } as never,
      }),
    ).resolves.toEqual({
      apiKey: "plain-api-key",
      mode: "api-key",
      source: "env:OPENAI_API_KEY",
    });
  });

  it("skips provider preparation when raw auth does not expose an apiKey", async () => {
    hoisted.getApiKeyForModel.mockResolvedValue({
      mode: "aws-sdk",
      source: "env:AWS_PROFILE",
    });

    await expect(
      getRuntimeAuthForModel({
        model: {
          ...MODEL,
          id: "bedrock/claude-sonnet",
          provider: "bedrock",
        } as never,
      }),
    ).resolves.toEqual({
      mode: "aws-sdk",
      source: "env:AWS_PROFILE",
    });
    expect(hoisted.prepareProviderRuntimeAuth).not.toHaveBeenCalled();
  });
});
