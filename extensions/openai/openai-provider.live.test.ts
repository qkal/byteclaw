import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const DEFAULT_LIVE_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.4-nano"] as const;
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

interface LiveModelCase {
  modelId: string;
  templateId: string;
  templateName: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function resolveLiveModelCase(modelId: string): LiveModelCase {
  switch (modelId) {
    case "gpt-5.4": {
      return {
        contextWindow: 400_000,
        cost: { cacheRead: 0.175, cacheWrite: 0, input: 1.75, output: 14 },
        maxTokens: 128_000,
        modelId,
        templateId: "gpt-5.2",
        templateName: "GPT-5.2",
      };
    }
    case "gpt-5.4-pro": {
      return {
        contextWindow: 400_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 21, output: 168 },
        maxTokens: 128_000,
        modelId,
        templateId: "gpt-5.2-pro",
        templateName: "GPT-5.2 Pro",
      };
    }
    case "gpt-5.4-mini": {
      return {
        contextWindow: 400_000,
        cost: { cacheRead: 0.025, cacheWrite: 0, input: 0.25, output: 2 },
        maxTokens: 128_000,
        modelId,
        templateId: "gpt-5-mini",
        templateName: "GPT-5 mini",
      };
    }
    case "gpt-5.4-nano": {
      return {
        contextWindow: 400_000,
        cost: { cacheRead: 0.005, cacheWrite: 0, input: 0.05, output: 0.4 },
        maxTokens: 128_000,
        modelId,
        templateId: "gpt-5-nano",
        templateName: "GPT-5 nano",
      };
    }
    default: {
      throw new Error(`Unsupported live OpenAI model: ${modelId}`);
    }
  }
}

function resolveLiveModelCases(raw?: string): LiveModelCase[] {
  const requested = raw
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const modelIds = requested?.length ? requested : [...DEFAULT_LIVE_MODEL_IDS];
  return [...new Set(modelIds)].map((modelId) => resolveLiveModelCase(modelId));
}

describeLive("buildOpenAIProvider live", () => {
  it.each(resolveLiveModelCases(process.env.OPENCLAW_LIVE_OPENAI_MODELS))(
    "resolves %s and completes through the OpenAI responses API",
    async (liveCase) => {
      const provider = buildOpenAIProvider();
      const registry = {
        find(providerId: string, id: string) {
          if (providerId !== "openai") {
            return null;
          }
          if (id === liveCase.templateId) {
            return {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              contextWindow: liveCase.contextWindow,
              cost: liveCase.cost,
              id: liveCase.templateId,
              input: ["text", "image"],
              maxTokens: liveCase.maxTokens,
              name: liveCase.templateName,
              provider: "openai",
              reasoning: true,
            };
          }
          return null;
        },
      };

      const resolved = provider.resolveDynamicModel?.({
        modelId: liveCase.modelId,
        modelRegistry: registry as never,
        provider: "openai",
      });
      if (!resolved) {
        throw new Error(`openai provider did not resolve ${liveCase.modelId}`);
      }

      const normalized = provider.normalizeResolvedModel?.({
        model: resolved,
        modelId: resolved.id,
        provider: "openai",
      });

      expect(normalized).toMatchObject({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: liveCase.modelId,
        provider: "openai",
      });

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY,
        baseURL: normalized?.baseUrl,
      });

      const response = await client.responses.create({
        input: "Reply with exactly OK.",
        max_output_tokens: 16,
        model: normalized?.id ?? liveCase.modelId,
      });

      expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
    },
    30_000,
  );
});
