import { describe, expect, it } from "vitest";
import { isXaiModelHint, resolveXaiTransport, shouldContributeXaiCompat } from "./api.js";

describe("xai api helpers", () => {
  it("uses shared endpoint classification for native xAI transports", () => {
    expect(
      resolveXaiTransport({
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        provider: "custom-xai",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("keeps default-route xAI transport for the declared provider", () => {
    expect(
      resolveXaiTransport({
        api: "openai-completions",
        provider: "xai",
      }),
    ).toEqual({
      api: "openai-responses",
      baseUrl: undefined,
    });
  });

  it("contributes compat for native xAI hosts and model hints", () => {
    expect(
      shouldContributeXaiCompat({
        model: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
        modelId: "custom-model",
      }),
    ).toBe(true);
    expect(
      shouldContributeXaiCompat({
        model: {
          api: "openai-completions",
          baseUrl: "https://proxy.example.com/v1",
        },
        modelId: "x-ai/grok-4",
      }),
    ).toBe(true);
    expect(isXaiModelHint("x-ai/grok-4")).toBe(true);
  });
});
