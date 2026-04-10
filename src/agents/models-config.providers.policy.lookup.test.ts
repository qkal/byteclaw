import { describe, expect, it } from "vitest";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";

describe("resolveProviderPluginLookupKey", () => {
  it("routes Google Generative AI custom providers to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-paid", {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [],
      }),
    ).toBe("google");
  });

  it("routes model-level Google Generative AI providers to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("custom-google", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [
          {
            api: "google-generative-ai",
            contextWindow: 1_048_576,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
            id: "gemini-3-pro",
            input: ["text", "image"],
            maxTokens: 65_536,
            name: "Gemini 3 Pro",
            reasoning: true,
          },
        ],
      }),
    ).toBe("google");
  });

  it("routes google-antigravity to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-antigravity", {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        models: [],
      }),
    ).toBe("google");
  });

  it("routes google-vertex to the google policy artifact", () => {
    expect(
      resolveProviderPluginLookupKey("google-vertex", {
        baseUrl: "https://aiplatform.googleapis.com",
        models: [],
      }),
    ).toBe("google");
  });
});
