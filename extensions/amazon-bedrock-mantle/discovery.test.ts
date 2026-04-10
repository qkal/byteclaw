import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverMantleModels,
  generateBearerTokenFromIam,
  mergeImplicitMantleProvider,
  resetIamTokenCacheForTest,
  resetMantleDiscoveryCacheForTest,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
} from "./api.js";

const mocks = vi.hoisted(() => ({
  getTokenProvider: vi.fn(),
}));

vi.mock("@aws/bedrock-token-generator", () => ({
  getTokenProvider: mocks.getTokenProvider,
}));

describe("bedrock mantle discovery", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    mocks.getTokenProvider.mockReset();
    resetMantleDiscoveryCacheForTest();
    resetIamTokenCacheForTest();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Bearer token resolution
  // ---------------------------------------------------------------------------

  it("resolves bearer token from AWS_BEARER_TOKEN_BEDROCK", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-abc123", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("bedrock-api-key-abc123");
  });

  it("returns undefined when no bearer token env var is set", () => {
    expect(resolveMantleBearerToken({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("trims whitespace from bearer token", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "  my-token  ", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("my-token");
  });

  // ---------------------------------------------------------------------------
  // IAM token generation
  // ---------------------------------------------------------------------------

  it("generates token from IAM credentials when token generation succeeds", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-generated"); // Pragma: allowlist secret
    mocks.getTokenProvider.mockReturnValue(tokenProvider);

    const token = await generateBearerTokenFromIam({ region: "us-east-1" });

    expect(token).toBe("bedrock-api-key-generated");
    expect(mocks.getTokenProvider).toHaveBeenCalledWith({
      expiresInSeconds: 7200,
      region: "us-east-1",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("caches generated IAM tokens within TTL", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-cached"); // Pragma: allowlist secret
    mocks.getTokenProvider.mockReturnValue(tokenProvider);
    let now = 1000;

    const t1 = await generateBearerTokenFromIam({ now: () => now, region: "us-east-1" });
    now += 1_800_000; // 30 min — within 1hr cache TTL
    const t2 = await generateBearerTokenFromIam({ now: () => now, region: "us-east-1" });

    expect(t1).toEqual(t2);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an IAM token across regions", async () => {
    const tokenProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("bedrock-api-key-east") // Pragma: allowlist secret
      .mockResolvedValueOnce("bedrock-api-key-west"); // Pragma: allowlist secret
    mocks.getTokenProvider.mockReturnValue(tokenProvider);

    const east = await generateBearerTokenFromIam({ now: () => 1000, region: "us-east-1" });
    const west = await generateBearerTokenFromIam({ now: () => 2000, region: "us-west-2" });

    expect(east).toBe("bedrock-api-key-east");
    expect(west).toBe("bedrock-api-key-west");
    expect(mocks.getTokenProvider).toHaveBeenNthCalledWith(1, {
      expiresInSeconds: 7200,
      region: "us-east-1",
    });
    expect(mocks.getTokenProvider).toHaveBeenNthCalledWith(2, {
      expiresInSeconds: 7200,
      region: "us-west-2",
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when IAM token generation fails", async () => {
    mocks.getTokenProvider.mockImplementation(() => {
      throw new Error("no credentials");
    });

    await expect(generateBearerTokenFromIam({ region: "us-east-1" })).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------

  it("discovers models from Mantle /v1/models endpoint sorted by id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          { id: "openai.gpt-oss-120b", object: "model", owned_by: "openai" },
          { id: "anthropic.claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
          { id: "mistral.devstral-2-123b", object: "model", owned_by: "mistral" },
        ],
      }),
      ok: true,
    });

    const models = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      region: "us-east-1",
    });

    expect(models).toHaveLength(3);
    // Models should be sorted alphabetically by id
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-sonnet-4-6",
      input: ["text"],
      name: "anthropic.claude-sonnet-4-6",
      reasoning: false,
    });
    expect(models[1]).toMatchObject({
      id: "mistral.devstral-2-123b",
      reasoning: false,
    });
    expect(models[2]).toMatchObject({
      id: "openai.gpt-oss-120b",
      reasoning: true, // GPT-OSS 120B supports reasoning
    });

    // Verify correct endpoint and auth header
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("infers reasoning support from model IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          { id: "moonshotai.kimi-k2-thinking", object: "model" },
          { id: "openai.gpt-oss-120b", object: "model" },
          { id: "openai.gpt-oss-safeguard-120b", object: "model" },
          { id: "deepseek.v3.2", object: "model" },
          { id: "mistral.mistral-large-3-675b-instruct", object: "model" },
        ],
      }),
      ok: true,
    });

    const models = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      region: "us-east-1",
    });

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["moonshotai.kimi-k2-thinking"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-120b"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-safeguard-120b"]?.reasoning).toBe(true);
    expect(byId["deepseek.v3.2"]?.reasoning).toBe(false);
    expect(byId["mistral.mistral-large-3-675b-instruct"]?.reasoning).toBe(false);
  });

  it("returns empty array on permission error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    const models = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      region: "us-east-1",
    });

    expect(models).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const models = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      region: "us-east-1",
    });

    expect(models).toEqual([]);
  });

  it("filters out models with empty IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [
          { id: "anthropic.claude-sonnet-4-6", object: "model" },
          { id: "", object: "model" },
          { id: "  ", object: "model" },
        ],
      }),
      ok: true,
    });

    const models = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      region: "us-east-1",
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Discovery caching
  // ---------------------------------------------------------------------------

  it("returns cached models on subsequent calls within refresh interval", async () => {
    let now = 1_000_000;
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
      ok: true,
    });

    // First call — hits the network
    const first = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
      region: "us-east-1",
    });
    expect(first).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within refresh interval — uses cache
    now += 60_000; // 1 minute later
    const second = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
      region: "us-east-1",
    });
    expect(second).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch

    // Third call after refresh interval — re-fetches
    now += 3_600_000; // 1 hour later
    const third = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
      region: "us-east-1",
    });
    expect(third).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2); // Re-fetched
  });

  it("returns stale cache on fetch failure", async () => {
    let now = 1_000_000;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        json: async () => ({
          data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
        }),
        ok: true,
      })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // First call — succeeds
    await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
      region: "us-east-1",
    });

    // Second call after expiry — fails but returns stale cache
    now += 7_200_000;
    const stale = await discoverMantleModels({
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
      region: "us-east-1",
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Implicit provider resolution
  // ---------------------------------------------------------------------------

  it("resolves implicit provider when bearer token is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
      ok: true,
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // Pragma: allowlist secret
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.auth).toBe("api-key");
    expect(provider?.apiKey).toBe("env:AWS_BEARER_TOKEN_BEDROCK");
    expect(provider?.models).toHaveLength(1);
  });

  it("returns null when no auth is available", async () => {
    mocks.getTokenProvider.mockImplementation(() => {
      throw new Error("no credentials");
    });

    const provider = await resolveImplicitMantleProvider({
      env: {} as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("uses a generated IAM token when no explicit token is set", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-iam"); // Pragma: allowlist secret
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ id: "openai.gpt-oss-120b", object: "model" }],
      }),
      ok: true,
    });
    mocks.getTokenProvider.mockReturnValue(tokenProvider);

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_PROFILE: "default",
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider).not.toBeNull();
    expect(provider?.apiKey).toBe("bedrock-api-key-iam");
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer bedrock-api-key-iam",
        }),
      }),
    );
  });

  it("returns null for unsupported regions", async () => {
    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // Pragma: allowlist secret
        AWS_REGION: "af-south-1",
      } as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("defaults to us-east-1 when no region is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ data: [{ id: "openai.gpt-oss-120b", object: "model" }] }),
      ok: true,
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // Pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Provider merging
  // ---------------------------------------------------------------------------

  it("merges implicit models when existing provider has empty models", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://custom.example.com/v1",
        models: [],
      },
      implicit: {
        api: "openai-completions",
        apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
        auth: "api-key",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        models: [
          {
            contextWindow: 32000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "openai.gpt-oss-120b",
            input: ["text"],
            maxTokens: 4096,
            name: "GPT-OSS 120B",
            reasoning: true,
          },
        ],
      },
    });

    expect(result.baseUrl).toBe("https://custom.example.com/v1");
    expect(result.models?.map((m) => m.id)).toEqual(["openai.gpt-oss-120b"]);
  });

  it("preserves existing models over implicit ones", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        models: [
          {
            contextWindow: 64_000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "custom-model",
            input: ["text"],
            maxTokens: 8192,
            name: "My Custom Model",
            reasoning: false,
          },
        ],
      },
      implicit: {
        api: "openai-completions",
        auth: "api-key",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        models: [
          {
            contextWindow: 32000,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "openai.gpt-oss-120b",
            input: ["text"],
            maxTokens: 4096,
            name: "GPT-OSS 120B",
            reasoning: true,
          },
        ],
      },
    });

    expect(result.models?.map((m) => m.id)).toEqual(["custom-model"]);
  });
});
