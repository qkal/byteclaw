import { expect } from "vitest";

export function buildForwardCompatTemplate(params: {
  id: string;
  name: string;
  provider: string;
  api: "anthropic-messages" | "google-gemini-cli" | "openai-completions" | "openai-responses";
  baseUrl: string;
  reasoning?: boolean;
  input?: readonly ["text"] | readonly ["text", "image"];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
}) {
  return {
    api: params.api,
    baseUrl: params.baseUrl,
    contextWindow: params.contextWindow ?? 200_000,
    cost: params.cost ?? { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
    id: params.id,
    input: params.input ?? (["text", "image"] as const),
    maxTokens: params.maxTokens ?? 64_000,
    name: params.name,
    provider: params.provider,
    reasoning: params.reasoning ?? true,
  };
}

export function expectResolvedForwardCompatFallbackResult(params: {
  result: {
    error?: string;
    model?: unknown;
  };
  expectedModel: Record<string, unknown>;
}) {
  expect(params.result.error).toBeUndefined();
  expect(params.result.model).toMatchObject(params.expectedModel);
}

export function expectResolvedForwardCompatFallbackWithRegistryResult(params: {
  result: unknown;
  expectedModel: Record<string, unknown>;
}) {
  expect(params.result).toMatchObject(params.expectedModel);
}

export function expectUnknownModelErrorResult(
  result: {
    error?: string;
    model?: unknown;
  },
  provider: string,
  id: string,
) {
  expect(result.model).toBeUndefined();
  expect(result.error).toBe(`Unknown model: ${provider}/${id}`);
}
