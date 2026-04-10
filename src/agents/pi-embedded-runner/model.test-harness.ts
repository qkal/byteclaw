import { vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.js";

type DiscoverModelsMock = typeof import("../pi-model-discovery.js").discoverModels;

export const makeModel = (id: string): ModelDefinitionConfig => ({
  contextWindow: 1,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ["text"],
  maxTokens: 1,
  name: id,
  reasoning: false,
});

export const OPENAI_CODEX_TEMPLATE_MODEL = {
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextTokens: 272_000,
  contextWindow: 1_050_000,
  cost: { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 },
  id: "gpt-5.3-codex",
  input: ["text", "image"] as const,
  maxTokens: 128_000,
  name: "GPT-5.3 Codex",
  provider: "openai-codex",
  reasoning: true,
};

function mockTemplateModel(
  discoverModelsMock: DiscoverModelsMock,
  provider: string,
  modelId: string,
  templateModel: unknown,
): void {
  mockDiscoveredModel(discoverModelsMock, {
    modelId,
    provider,
    templateModel,
  });
}

export function mockOpenAICodexTemplateModel(discoverModelsMock: DiscoverModelsMock): void {
  mockTemplateModel(
    discoverModelsMock,
    "openai-codex",
    OPENAI_CODEX_TEMPLATE_MODEL.id,
    OPENAI_CODEX_TEMPLATE_MODEL,
  );
}

export function buildOpenAICodexForwardCompatExpectation(
  id: string = "gpt-5.3-codex",
): Partial<ModelDefinitionConfig> & {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
} {
  const isGpt54 = id === "gpt-5.4";
  const isGpt54Mini = id === "gpt-5.4-mini";
  const isSpark = id === "gpt-5.3-codex-spark";
  return {
    provider: "openai-codex",
    id,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: isSpark ? ["text"] : ["text", "image"],
    cost: isSpark
      ? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
      : isGpt54
        ? { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 }
        : isGpt54Mini
          ? { cacheRead: 0.075, cacheWrite: 0, input: 0.75, output: 4.5 }
          : OPENAI_CODEX_TEMPLATE_MODEL.cost,
    contextWindow: isGpt54 ? 1_050_000 : isSpark ? 128_000 : 272_000,
    ...(isGpt54 ? { contextTokens: 272_000 } : {}),
    maxTokens: 128_000,
  };
}

export const GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL = {
  api: "google-gemini-cli",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gemini-3-pro-preview",
  input: ["text", "image"] as const,
  maxTokens: 64_000,
  name: "Gemini 3 Pro Preview (Cloud Code Assist)",
  provider: "google-gemini-cli",
  reasoning: true,
};

export const GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL = {
  api: "google-gemini-cli",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gemini-3-flash-preview",
  input: ["text", "image"] as const,
  maxTokens: 64_000,
  name: "Gemini 3 Flash Preview (Cloud Code Assist)",
  provider: "google-gemini-cli",
  reasoning: false,
};

export function mockGoogleGeminiCliProTemplateModel(discoverModelsMock: DiscoverModelsMock): void {
  mockTemplateModel(
    discoverModelsMock,
    "google-gemini-cli",
    "gemini-3-pro-preview",
    GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL,
  );
}

export function mockGoogleGeminiCliFlashTemplateModel(
  discoverModelsMock: DiscoverModelsMock,
): void {
  mockTemplateModel(
    discoverModelsMock,
    "google-gemini-cli",
    "gemini-3-flash-preview",
    GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
  );
}

export function resetMockDiscoverModels(discoverModelsMock: DiscoverModelsMock): void {
  vi.mocked(discoverModelsMock).mockReturnValue({
    find: vi.fn(() => null),
  } as unknown as ReturnType<DiscoverModelsMock>);
}

export function mockDiscoveredModel(
  discoverModelsMock: DiscoverModelsMock,
  params: {
    provider: string;
    modelId: string;
    templateModel: unknown;
  },
): void {
  vi.mocked(discoverModelsMock).mockReturnValue({
    find: vi.fn((provider: string, modelId: string) => {
      if (provider === params.provider && modelId === params.modelId) {
        return params.templateModel;
      }
      return null;
    }),
  } as unknown as ReturnType<DiscoverModelsMock>);
}
