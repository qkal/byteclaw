import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneFirstTemplateModel, matchesExactOrPrefix } from "./provider-model-helpers.js";
import type { ProviderResolveDynamicModelContext, ProviderRuntimeModel } from "./types.js";

function createContext(models: ProviderRuntimeModel[]): ProviderResolveDynamicModelContext {
  return {
    modelId: "next-model",
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          models.find((model) => model.provider === providerId && model.id === modelId) ?? null
        );
      },
    } as ModelRegistry,
    provider: "test-provider",
  };
}

function createTemplateModel(
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    api: "openai-completions",
    id,
    name: id,
    provider: "test-provider",
    ...overrides,
  } as ProviderRuntimeModel;
}

function expectClonedTemplateModel(
  params: Parameters<typeof cloneFirstTemplateModel>[0],
  expected: Record<string, unknown> | undefined,
) {
  const model = cloneFirstTemplateModel(params);
  if (expected == null) {
    expect(model).toBeUndefined();
    return;
  }
  expect(model).toMatchObject(expected);
}

function expectPrefixMatch(params: {
  id: string;
  candidates: readonly string[];
  expected: boolean;
}) {
  expect(matchesExactOrPrefix(params.id, params.candidates)).toBe(params.expected);
}

function expectPrefixMatchCase(params: {
  id: string;
  candidates: readonly string[];
  expected: boolean;
}) {
  expectPrefixMatch(params);
}

describe("cloneFirstTemplateModel", () => {
  it.each([
    {
      expected: {
        api: "openai-completions",
        id: "next-model",
        name: "next-model",
        provider: "test-provider",
        reasoning: true,
      },
      name: "clones the first matching template and applies patches",
      params: {
        ctx: createContext([createTemplateModel("template-a", { name: "Template A" })]),
        modelId: " next-model ",
        patch: { reasoning: true },
        providerId: "test-provider",
        templateIds: ["missing", "template-a", "template-b"],
      },
    },
    {
      expected: undefined,
      name: "returns undefined when no template exists",
      params: {
        ctx: createContext([]),
        modelId: "next-model",
        providerId: "test-provider",
        templateIds: ["missing"],
      },
    },
  ] as const)("$name", ({ params, expected }) => {
    expectClonedTemplateModel(params, expected);
  });
});

describe("matchesExactOrPrefix", () => {
  it.each([
    {
      candidates: ["minimax-m2.7"],
      expected: true,
      id: "MiniMax-M2.7",
    },
    {
      candidates: ["MiniMax-M2.7"],
      expected: true,
      id: "minimax-m2.7-highspeed",
    },
    {
      candidates: ["minimax-m2.7"],
      expected: false,
      id: "glm-5",
    },
  ] as const)("matches $id against prefixes", expectPrefixMatchCase);
});
