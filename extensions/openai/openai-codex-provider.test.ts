import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

let buildOpenAICodexProviderPlugin: typeof import("./openai-codex-provider.js").buildOpenAICodexProviderPlugin;

describe("openai codex provider", () => {
  beforeAll(async () => {
    ({ buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
  });

  it("falls back to the cached credential when accountId extraction fails", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      access: "cached-access-token",
      expires: Date.now() - 60_000,
      provider: "openai-codex",
      refresh: "refresh-token",
      type: "oauth" as const,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(
      new Error("Failed to extract accountId from token"),
    );

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual(credential);
  });

  it("rethrows unrelated refresh failures", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      access: "cached-access-token",
      expires: Date.now() - 60_000,
      provider: "openai-codex",
      refresh: "refresh-token",
      type: "oauth" as const,
    };
    refreshOpenAICodexTokenMock.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow("invalid_grant");
  });

  it("merges refreshed oauth credentials", async () => {
    const provider = buildOpenAICodexProviderPlugin();
    const credential = {
      access: "cached-access-token",
      displayName: "User",
      email: "user@example.com",
      expires: Date.now() - 60_000,
      provider: "openai-codex",
      refresh: "refresh-token",
      type: "oauth" as const,
    };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "next-access",
      expires: Date.now() + 60_000,
      refresh: "next-refresh",
    });

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "next-access",
      expires: expect.any(Number),
      refresh: "next-refresh",
    });
  });

  it("returns deprecated-profile doctor guidance for legacy Codex CLI ids", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.buildAuthDoctorHint?.({
        config: undefined,
        profileId: "openai-codex:codex-cli",
        provider: "openai-codex",
        store: { profiles: {}, version: 1 },
      }),
    ).toBe(
      "Deprecated profile. Run `openclaw models auth login --provider openai-codex` or `openclaw configure`.",
    );
  });

  it("owns native reasoning output mode for Codex responses", () => {
    const provider = buildOpenAICodexProviderPlugin();

    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "openai-codex-responses",
        modelId: "gpt-5.4",
        provider: "openai-codex",
      } as never),
    ).toBe("native");
  });

  it("resolves gpt-5.4 with native contextWindow plus default contextTokens cap", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      modelId: "gpt-5.4",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.3-codex") {
            return {
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              contextWindow: 272_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "gpt-5.3-codex",
              input: ["text", "image"] as const,
              maxTokens: 128_000,
              name: "gpt-5.3-codex",
              provider: "openai-codex",
              reasoning: true,
            };
          }
          return undefined;
        },
      } as never,
      provider: "openai-codex",
    });

    expect(model).toMatchObject({
      contextTokens: 272_000,
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      maxTokens: 128_000,
    });
  });

  it("resolves gpt-5.4-mini from codex templates with codex-sized limits", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const model = provider.resolveDynamicModel?.({
      modelId: "gpt-5.4-mini",
      modelRegistry: {
        find: (providerId: string, modelId: string) => {
          if (providerId === "openai-codex" && modelId === "gpt-5.1-codex-mini") {
            return {
              api: "openai-codex-responses",
              baseUrl: "https://chatgpt.com/backend-api",
              contextWindow: 272_000,
              cost: { cacheRead: 0.025, cacheWrite: 0, input: 0.25, output: 2 },
              id: "gpt-5.1-codex-mini",
              input: ["text", "image"],
              maxTokens: 128_000,
              name: "gpt-5.1-codex-mini",
              provider: "openai-codex",
              reasoning: true,
            };
          }
          return null;
        },
      } as never,
      provider: "openai-codex",
    } as never);

    expect(model).toMatchObject({
      contextWindow: 272_000,
      cost: { cacheRead: 0.075, cacheWrite: 0, input: 0.75, output: 4.5 },
      id: "gpt-5.4-mini",
      maxTokens: 128_000,
    });
    expect(model).not.toHaveProperty("contextTokens");
  });

  it("augments catalog with gpt-5.4 native contextWindow and runtime cap", () => {
    const provider = buildOpenAICodexProviderPlugin();

    const entries = provider.augmentModelCatalog?.({
      entries: [
        {
          contextWindow: 272_000,
          id: "gpt-5.3-codex",
          input: ["text", "image"],
          name: "gpt-5.3-codex",
          provider: "openai-codex",
          reasoning: true,
        },
      ],
      env: process.env,
    } as never);

    expect(entries).toContainEqual(
      expect.objectContaining({
        contextTokens: 272_000,
        contextWindow: 1_050_000,
        id: "gpt-5.4",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        contextWindow: 272_000,
        id: "gpt-5.4-mini",
      }),
    );
  });
});
