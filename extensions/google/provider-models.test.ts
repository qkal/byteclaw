import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

function createTemplateModel(
  provider: string,
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    api: provider === "google-gemini-cli" ? "google-gemini-cli" : "google-generative-ai",
    baseUrl:
      provider === "google-gemini-cli"
        ? "https://cloudcode-pa.googleapis.com"
        : "https://generativelanguage.googleapis.com/v1beta",
    contextWindow: 200_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text", "image"],
    maxTokens: 64_000,
    name: id,
    provider,
    reasoning: false,
    ...overrides,
  } as ProviderRuntimeModel;
}

function createContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
    provider: params.provider,
  };
}

describe("resolveGoogleGeminiForwardCompatModel", () => {
  it("resolves stable gemini 2.5 flash-lite from direct google templates for Gemini CLI when available", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-2.5-flash-lite",
        models: [createTemplateModel("google", "gemini-2.5-flash-lite")],
        provider: "google-gemini-cli",
      }),
      providerId: "google-gemini-cli",
    });

    expect(model).toMatchObject({
      api: "google-generative-ai",
      id: "gemini-2.5-flash-lite",
      provider: "google-gemini-cli",
      reasoning: false,
    });
  });

  it("resolves stable gemini 2.5 flash-lite from Gemini CLI templates when direct google templates are unavailable", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-2.5-flash-lite",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", {
            contextWindow: 1_048_576,
            api: "google-gemini-cli",
            baseUrl: "https://cloudcode-pa.googleapis.com",
          }),
        ],
        provider: "google-gemini-cli",
      }),
      providerId: "google-gemini-cli",
    });

    expect(model).toMatchObject({
      api: "google-gemini-cli",
      contextWindow: 1_048_576,
      id: "gemini-2.5-flash-lite",
      provider: "google-gemini-cli",
      reasoning: false,
    });
  });

  it("resolves gemini 3.1 pro for google aliases via an alternate template provider", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-3.1-pro-preview",
        models: [createTemplateModel("google-gemini-cli", "gemini-3-pro-preview")],
        provider: "google-vertex",
      }),
      providerId: "google-vertex",
    });

    expect(model).toMatchObject({
      api: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
      provider: "google-vertex",
      reasoning: false,
    });
  });

  it("keeps Gemini CLI 3.1 clones sourced from CLI templates when both catalogs exist", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-3.1-pro-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-pro-preview", {
            api: "google-gemini-cli",
            baseUrl: "https://cloudcode-pa.googleapis.com",
            contextWindow: 1_048_576,
          }),
          createTemplateModel("google", "gemini-3-pro-preview", {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            contextWindow: 200_000,
          }),
        ],
        provider: "google-gemini-cli",
      }),
      providerId: "google-gemini-cli",
    });

    expect(model).toMatchObject({
      api: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      contextWindow: 1_048_576,
      id: "gemini-3.1-pro-preview",
      provider: "google-gemini-cli",
    });
  });

  it("preserves template reasoning metadata instead of forcing it on forward-compat clones", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-3.1-flash-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-flash-preview", {
            reasoning: true,
          }),
        ],
        provider: "google",
      }),
      providerId: "google",
    });

    expect(model).toMatchObject({
      api: "google-gemini-cli",
      id: "gemini-3.1-flash-preview",
      provider: "google",
      reasoning: true,
    });
  });

  it("resolves gemini 3.1 flash from direct google templates", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-3.1-flash-preview",
        models: [
          createTemplateModel("google", "gemini-3-flash-preview", {
            reasoning: false,
          }),
        ],
        provider: "google",
      }),
      providerId: "google",
    });

    expect(model).toMatchObject({
      api: "google-generative-ai",
      id: "gemini-3.1-flash-preview",
      provider: "google",
      reasoning: false,
    });
  });

  it("prefers the flash-lite template before the broader flash prefix", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemini-3.1-flash-lite-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-flash-preview", {
            contextWindow: 128_000,
          }),
          createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", {
            contextWindow: 1_048_576,
          }),
        ],
        provider: "google-vertex",
      }),
      providerId: "google-vertex",
    });

    expect(model).toMatchObject({
      contextWindow: 1_048_576,
      id: "gemini-3.1-flash-lite-preview",
      provider: "google-vertex",
      reasoning: false,
    });
  });

  it("treats gemini 2.5 ids as modern google models", () => {
    expect(isModernGoogleModel("gemini-2.5-pro")).toBe(true);
    expect(isModernGoogleModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isModernGoogleModel("gemini-1.5-pro")).toBe(false);
  });

  it("treats gemma models as modern google models", () => {
    expect(isModernGoogleModel("gemma-4-26b-a4b-it")).toBe(true);
    expect(isModernGoogleModel("gemma-3-4b-it")).toBe(true);
  });

  it("resolves Gemma 4 models with reasoning enabled regardless of template", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemma-4-26b-a4b-it",
        models: [createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false })],
        provider: "google",
      }),
      providerId: "google",
    });

    expect(model).toMatchObject({
      id: "gemma-4-26b-a4b-it",
      provider: "google",
      reasoning: true,
    });
  });

  it("preserves template reasoning for non-Gemma 4 gemma models", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      ctx: createContext({
        modelId: "gemma-3-4b-it",
        models: [createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false })],
        provider: "google",
      }),
      providerId: "google",
    });

    expect(model).toMatchObject({
      id: "gemma-3-4b-it",
      provider: "google",
      reasoning: false,
    });
  });
});
