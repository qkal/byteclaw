import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

function createFetchFixture(payload: unknown): typeof fetch {
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
}

describe("scanOpenRouterModels", () => {
  it("lists free models without probing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          context_length: 16_384,
          created_at: 1_700_000_000,
          id: "acme/free-by-pricing",
          max_completion_tokens: 1024,
          modality: "text",
          name: "Free By Pricing",
          pricing: { completion: "0", image: "0", prompt: "0", request: "0" },
          supported_parameters: ["tools", "tool_choice", "temperature"],
        },
        {
          context_length: 8192,
          id: "acme/free-by-suffix:free",
          modality: "text",
          name: "Free By Suffix",
          pricing: { completion: "0", prompt: "0" },
          supported_parameters: [],
        },
        {
          context_length: 4096,
          id: "acme/paid",
          modality: "text",
          name: "Paid",
          pricing: { completion: "0.000002", prompt: "0.000001" },
          supported_parameters: ["tools"],
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    const [byPricing] = results;
    expect(byPricing).toBeTruthy();
    if (!byPricing) {
      throw new Error("Expected pricing-based model result.");
    }
    expect(byPricing.supportsToolsMeta).toBe(true);
    expect(byPricing.supportedParametersCount).toBe(3);
    expect(byPricing.isFree).toBe(true);
    expect(byPricing.tool.skipped).toBe(true);
    expect(byPricing.image.skipped).toBe(true);
  });

  it("requires an API key when probing", async () => {
    const fetchImpl = createFetchFixture({ data: [] });
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(
        scanOpenRouterModels({
          apiKey: "",
          fetchImpl,
          probe: true,
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    });
  });

  it("matches provider filters across canonical provider aliases", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          context_length: 128_000,
          id: "z.ai/glm-5",
          modality: "text",
          name: "GLM-5",
          pricing: { completion: "0", prompt: "0" },
          supported_parameters: [],
        },
        {
          context_length: 128_000,
          id: "openai/gpt-5",
          modality: "text",
          name: "GPT-5",
          pricing: { completion: "0", prompt: "0" },
          supported_parameters: [],
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
      providerFilter: "z-ai",
    });

    expect(results.map((entry) => entry.id)).toEqual(["z.ai/glm-5"]);
  });
});
