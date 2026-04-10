import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelKey } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import type { normalizeProviderModelIdWithPlugin } from "../plugins/provider-runtime.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

const normalizeProviderModelIdWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof normalizeProviderModelIdWithPlugin>(({ context }) => context.modelId),
);

vi.mock("../plugins/provider-runtime.js", () => ({ normalizeProviderModelIdWithPlugin: normalizeProviderModelIdWithPluginMock }));

import {
  __resetGatewayModelPricingCacheForTest,
  collectConfiguredModelPricingRefs,
  getCachedGatewayModelPricing,
  refreshGatewayModelPricingCache,
} from "./model-pricing-cache.js";

describe("model-pricing-cache", () => {
  beforeEach(() => {
    __resetGatewayModelPricingCacheForTest();
  });

  afterEach(() => {
    __resetGatewayModelPricingCacheForTest();
  });

  it("collects configured model refs across defaults, aliases, overrides, and media tools", () => {
    const config = {
      agents: {
        defaults: {
          compaction: { model: "opus" },
          heartbeat: { model: "xai/grok-4" },
          imageModel: { primary: "google/gemini-3-pro" },
          model: { fallbacks: ["anthropic/claude-sonnet-4-6"], primary: "gpt" },
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
        list: [
          {
            heartbeat: { model: "anthropic/claude-opus-4-6" },
            id: "router",
            model: { primary: "openrouter/anthropic/claude-opus-4-6" },
            subagents: { model: { primary: "openrouter/auto" } },
          },
        ],
      },
      channels: {
        modelByChannel: {
          slack: {
            C123: "gpt",
          },
        },
      },
      hooks: {
        gmail: { model: "anthropic/claude-opus-4-6" },
        mappings: [{ model: "zai/glm-5" }],
      },
      messages: {
        tts: {
          summaryModel: "openai/gpt-5.4",
        },
      },
      tools: {
        media: {
          image: {
            models: [{ model: "grok-4", provider: "xai" }],
          },
          models: [{ model: "gemini-2.5-pro", provider: "google" }],
        },
        subagents: { model: { primary: "anthropic/claude-haiku-4-5" } },
      },
    } as unknown as OpenClawConfig;

    const refs = collectConfiguredModelPricingRefs(config).map((ref) =>
      modelKey(ref.provider, ref.model),
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3-pro-preview",
        "anthropic/claude-opus-4-6",
        "xai/grok-4",
        "openrouter/anthropic/claude-opus-4-6",
        "openrouter/auto",
        "zai/glm-5",
        "anthropic/claude-haiku-4-5",
        "google/gemini-2.5-pro",
      ]),
    );
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("collects manifest-owned web search plugin model refs without a hardcoded plugin list", () => {
    const refs = collectConfiguredModelPricingRefs({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                model: "tavily/search-preview",
              },
            },
          },
        },
      },
    } as OpenClawConfig).map((ref) => modelKey(ref.provider, ref.model));

    expect(refs).toContain("tavily/search-preview");
  });

  it("loads openrouter pricing and maps provider aliases, wrappers, and anthropic dotted ids", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
        list: [
          {
            id: "router",
            model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          },
        ],
      },
      tools: {
        subagents: { model: { primary: "zai/glm-5" } },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4.6",
                pricing: {
                  completion: "0.000025",
                  input_cache_read: "0.0000005",
                  input_cache_write: "0.00000625",
                  prompt: "0.000005",
                },
              },
              {
                id: "anthropic/claude-sonnet-4.6",
                pricing: {
                  completion: "0.000015",
                  input_cache_read: "0.0000003",
                  prompt: "0.000003",
                },
              },
              {
                id: "z-ai/glm-5",
                pricing: {
                  completion: "0.000004",
                  prompt: "0.000001",
                },
              },
            ],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
    );

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(
      getCachedGatewayModelPricing({ model: "claude-opus-4-6", provider: "anthropic" }),
    ).toEqual({
      cacheRead: 0.5,
      cacheWrite: 6.25,
      input: 5,
      output: 25,
    });
    expect(
      getCachedGatewayModelPricing({
        model: "anthropic/claude-sonnet-4-6",
        provider: "openrouter",
      }),
    ).toEqual({
      cacheRead: 0.3,
      cacheWrite: 0,
      input: 3,
      output: 15,
    });
    expect(getCachedGatewayModelPricing({ model: "glm-5", provider: "zai" })).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 1,
      output: 4,
    });
  });

  it("does not recurse forever for native openrouter auto refs", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/auto" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openrouter/auto",
                pricing: {
                  completion: "0.000002",
                  prompt: "0.000001",
                },
              },
            ],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
    );

    await expect(refreshGatewayModelPricingCache({ config, fetchImpl })).resolves.toBeUndefined();
    expect(
      getCachedGatewayModelPricing({ model: "openrouter/auto", provider: "openrouter" }),
    ).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 1,
      output: 2,
    });
  });
});
