import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverBedrockModels,
  mergeImplicitBedrockProvider,
  resetBedrockDiscoveryCacheForTest,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

const baseActiveAnthropicSummary = {
  inputModalities: ["TEXT"],
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelLifecycle: { status: "ACTIVE" },
  modelName: "Claude 3.7 Sonnet",
  outputModalities: ["TEXT"],
  providerName: "anthropic",
  responseStreamingSupported: true,
};

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  sendMock
    .mockResolvedValueOnce({
      modelSummaries: [{ ...baseActiveAnthropicSummary, ...overrides }],
    })
    // ListInferenceProfiles response (empty — no inference profiles in basic tests).
    .mockResolvedValueOnce({ inferenceProfileSummaries: [] });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
    resetBedrockDiscoveryCacheForTest();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            inputModalities: ["TEXT", "IMAGE"],
            modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Claude 3.7 Sonnet",
            outputModalities: ["TEXT"],
            providerName: "anthropic",
            responseStreamingSupported: true,
          },
          {
            inputModalities: ["TEXT"],
            modelId: "anthropic.claude-3-haiku-20240307-v1:0",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Claude 3 Haiku",
            outputModalities: ["TEXT"],
            providerName: "anthropic",
            responseStreamingSupported: false,
          },
          {
            inputModalities: ["TEXT"],
            modelId: "meta.llama3-8b-instruct-v1:0",
            modelLifecycle: { status: "INACTIVE" },
            modelName: "Llama 3 8B",
            outputModalities: ["TEXT"],
            providerName: "meta",
            responseStreamingSupported: true,
          },
          {
            inputModalities: ["TEXT"],
            modelId: "amazon.titan-embed-text-v1",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Titan Embed",
            outputModalities: ["EMBEDDING"],
            providerName: "amazon",
            responseStreamingSupported: true,
          },
        ],
      })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    const models = await discoverBedrockModels({ clientFactory, region: "us-east-1" });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      contextWindow: 32_000,
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      input: ["text", "image"],
      maxTokens: 4096,
      name: "Claude 3.7 Sonnet",
      reasoning: false,
    });
  });

  it("applies provider filter", async () => {
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      clientFactory,
      config: { providerFilter: ["amazon"] },
      region: "us-east-1",
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      clientFactory,
      config: { defaultContextWindow: 64_000, defaultMaxTokens: 8192 },
      region: "us-east-1",
    });
    expect(models[0]).toMatchObject({ contextWindow: 64_000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    mockSingleActiveSummary();

    await discoverBedrockModels({ clientFactory, region: "us-east-1" });
    await discoverBedrockModels({ clientFactory, region: "us-east-1" });
    // 2 calls on first discovery (ListFoundationModels + ListInferenceProfiles), 0 on cached second.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval is 0", async () => {
    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    await discoverBedrockModels({
      clientFactory,
      config: { refreshInterval: 0 },
      region: "us-east-1",
    });
    await discoverBedrockModels({
      clientFactory,
      config: { refreshInterval: 0 },
      region: "us-east-1",
    });
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles) × 2 runs.
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("resolves the Bedrock config apiKey from AWS auth env vars", () => {
    expect(
      resolveBedrockConfigApiKey({
        AWS_BEARER_TOKEN_BEDROCK: "bearer", // Pragma: allowlist secret
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");

    // When no AWS env vars are present (e.g. instance role), no marker should be injected.
    // The aws-sdk credential chain handles auth at request time. (#49891)
    expect(resolveBedrockConfigApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();

    // When AWS_PROFILE is explicitly set, it should return the marker.
    expect(resolveBedrockConfigApiKey({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv)).toBe(
      "AWS_PROFILE",
    );
  });

  it("discovers inference profiles and inherits foundation model capabilities", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            inputModalities: ["TEXT", "IMAGE"],
            modelId: "anthropic.claude-sonnet-4-6",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Claude Sonnet 4.6",
            outputModalities: ["TEXT"],
            providerName: "anthropic",
            responseStreamingSupported: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileArn:
              "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-6",
            inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "US Anthropic Claude Sonnet 4.6",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
              {
                modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
          {
            inferenceProfileArn:
              "arn:aws:bedrock:eu-west-1::inference-profile/eu.anthropic.claude-sonnet-4-6",
            inferenceProfileId: "eu.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "EU Anthropic Claude Sonnet 4.6",
            models: [
              {
                modelArn: "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
          {
            inferenceProfileArn:
              "arn:aws:bedrock:us-east-1::inference-profile/global.anthropic.claude-sonnet-4-6",
            inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "Global Anthropic Claude Sonnet 4.6",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
          // Inactive profile should be filtered out.
          {
            inferenceProfileId: "ap.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "AP Claude Sonnet 4.6",
            models: [],
            status: "LEGACY",
            type: "SYSTEM_DEFINED",
          },
        ],
      });

    const models = await discoverBedrockModels({ clientFactory, region: "us-east-1" });

    // Foundation model + 3 active inference profiles = 4 models.
    expect(models).toHaveLength(4);

    // Global profiles should be sorted first (recommended for most users).
    expect(models[0]?.id).toBe("global.anthropic.claude-sonnet-4-6");

    const foundationModel = models.find((m) => m.id === "anthropic.claude-sonnet-4-6");
    const usProfile = models.find((m) => m.id === "us.anthropic.claude-sonnet-4-6");
    const euProfile = models.find((m) => m.id === "eu.anthropic.claude-sonnet-4-6");
    const globalProfile = models.find((m) => m.id === "global.anthropic.claude-sonnet-4-6");

    // Foundation model has image input.
    expect(foundationModel).toMatchObject({ input: ["text", "image"] });

    // Inference profiles inherit image input from the foundation model.
    expect(usProfile).toMatchObject({
      contextWindow: 32_000,
      input: ["text", "image"],
      maxTokens: 4096,
      name: "US Anthropic Claude Sonnet 4.6",
    });
    expect(euProfile).toMatchObject({ input: ["text", "image"] });
    expect(globalProfile).toMatchObject({ input: ["text", "image"] });

    // Inactive profile should not be present.
    expect(models.find((m) => m.id === "ap.anthropic.claude-sonnet-4-6")).toBeUndefined();
  });

  it("gracefully handles ListInferenceProfiles permission errors", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [baseActiveAnthropicSummary],
      })
      // Simulate AccessDeniedException for ListInferenceProfiles.
      .mockRejectedValueOnce(new Error("AccessDeniedException"));

    const models = await discoverBedrockModels({ clientFactory, region: "us-east-1" });
    // Foundation model should still be discovered despite profile discovery failure.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-3-7-sonnet-20250219-v1:0");
  });

  it("keeps matching inference profiles when provider filters are enabled", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            inputModalities: ["TEXT", "IMAGE"],
            modelId: "anthropic.claude-sonnet-4-6",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Claude Sonnet 4.6",
            outputModalities: ["TEXT"],
            providerName: "anthropic",
            responseStreamingSupported: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "Global Anthropic Claude Sonnet 4.6",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
          },
        ],
      });

    const models = await discoverBedrockModels({
      clientFactory,
      config: { providerFilter: ["anthropic"] },
      region: "us-east-1",
    });

    expect(models.map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
    ]);
  });

  it("prefers backing model ARNs for application profiles with region-like ids", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            inputModalities: ["TEXT", "IMAGE"],
            modelId: "anthropic.claude-sonnet-4-6",
            modelLifecycle: { status: "ACTIVE" },
            modelName: "Claude Sonnet 4.6",
            outputModalities: ["TEXT"],
            providerName: "anthropic",
            responseStreamingSupported: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.my-prod-profile",
            inferenceProfileName: "Prod Claude Profile",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
            status: "ACTIVE",
            type: "APPLICATION",
          },
        ],
      });

    const models = await discoverBedrockModels({ clientFactory, region: "us-east-1" });
    const profile = models.find((model) => model.id === "us.my-prod-profile");

    expect(profile).toMatchObject({
      contextWindow: 32_000,
      id: "us.my-prod-profile",
      input: ["text", "image"],
      maxTokens: 4096,
    });
  });

  it("merges implicit Bedrock models into explicit provider overrides", () => {
    expect(
      mergeImplicitBedrockProvider({
        existing: {
          baseUrl: "https://override.example.com",
          headers: { "x-test-header": "1" },
          models: [],
        },
        implicit: {
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          models: [
            {
              contextWindow: 1,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "amazon.nova-micro-v1:0",
              input: ["text"],
              maxTokens: 1,
              name: "Nova",
              reasoning: false,
            },
          ],
        },
      }).models?.map((model) => model.id),
    ).toEqual(["amazon.nova-micro-v1:0"]);
  });

  it("prefers plugin-owned discovery config and still honors legacy fallback", async () => {
    mockSingleActiveSummary();

    const pluginEnabled = await resolveImplicitBedrockProvider({
      clientFactory,
      config: {
        models: {
          bedrockDiscovery: {
            enabled: false,
            region: "us-west-2",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      pluginConfig: {
        discovery: {
          enabled: true,
          region: "us-east-1",
        },
      },
    });

    expect(pluginEnabled?.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles).
    expect(sendMock).toHaveBeenCalledTimes(2);

    mockSingleActiveSummary();

    const legacyEnabled = await resolveImplicitBedrockProvider({
      clientFactory,
      config: {
        models: {
          bedrockDiscovery: {
            enabled: true,
            region: "us-west-2",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(legacyEnabled?.baseUrl).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
    expect(sendMock).toHaveBeenCalledTimes(4);
  });
});
