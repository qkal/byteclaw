import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("google provider policy public artifact", () => {
  it("normalizes Google provider config without loading the full provider plugin", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          api: "google-generative-ai",
          apiKey: "GEMINI_API_KEY",
          baseUrl: "https://generativelanguage.googleapis.com",
          models: [
            {
              contextWindow: 1_048_576,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "gemini-3-pro",
              input: ["text", "image"],
              maxTokens: 65_536,
              name: "Gemini 3 Pro",
              reasoning: true,
            },
          ],
        },
      }),
    ).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: [{ id: "gemini-3-pro-preview" }],
    });
  });
});
