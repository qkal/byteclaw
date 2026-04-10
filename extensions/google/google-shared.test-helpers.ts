import type { Model } from "@mariozechner/pi-ai";
import { expect } from "vitest";

function makeZeroUsageSnapshot() {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0,
    },
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
};

type ConvertedTools = readonly {
  functionDeclarations?: readonly {
    parametersJsonSchema?: unknown;
    parameters?: unknown;
  }[];
}[];

export const getFirstToolParameters = (converted: ConvertedTools): Record<string, unknown> => {
  const functionDeclaration = asRecord(converted?.[0]?.functionDeclarations?.[0]);
  return asRecord(functionDeclaration.parametersJsonSchema ?? functionDeclaration.parameters);
};

export const makeModel = (id: string): Model<"google-generative-ai"> =>
  ({
    api: "google-generative-ai",
    baseUrl: "https://example.invalid",
    contextWindow: 1,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 1,
    name: id,
    provider: "google",
    reasoning: false,
  }) as Model<"google-generative-ai">;

export const makeGeminiCliModel = (id: string): Model<"google-gemini-cli"> =>
  ({
    api: "google-gemini-cli",
    baseUrl: "https://example.invalid",
    contextWindow: 1,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 1,
    name: id,
    provider: "google-gemini-cli",
    reasoning: false,
  }) as Model<"google-gemini-cli">;

export function makeGoogleAssistantMessage(model: string, content: unknown) {
  return {
    api: "google-generative-ai",
    content,
    model,
    provider: "google",
    role: "assistant",
    stopReason: "stop",
    timestamp: 0,
    usage: makeZeroUsageSnapshot(),
  };
}

export function makeGeminiCliAssistantMessage(model: string, content: unknown) {
  return {
    api: "google-gemini-cli",
    content,
    model,
    provider: "google-gemini-cli",
    role: "assistant",
    stopReason: "stop",
    timestamp: 0,
    usage: makeZeroUsageSnapshot(),
  };
}

export function expectConvertedRoles(contents: { role?: string }[], expectedRoles: string[]) {
  expect(contents).toHaveLength(expectedRoles.length);
  for (const [index, role] of expectedRoles.entries()) {
    expect(contents[index]?.role).toBe(role);
  }
}
