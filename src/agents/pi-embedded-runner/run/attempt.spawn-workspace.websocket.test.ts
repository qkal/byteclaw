import { describe, expect, it } from "vitest";
import { shouldUseOpenAIWebSocketTransport } from "./attempt.thread-helpers.js";

describe("openai websocket transport selection", () => {
  it("accepts the direct OpenAI responses transport pair", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        modelApi: "openai-responses",
        provider: "openai",
      }),
    ).toBe(true);
  });

  it("rejects mismatched OpenAI websocket transport pairs", () => {
    expect(
      shouldUseOpenAIWebSocketTransport({
        modelApi: "openai-codex-responses",
        provider: "openai",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        modelApi: "openai-responses",
        provider: "openai-codex",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        modelApi: "openai-codex-responses",
        provider: "openai-codex",
      }),
    ).toBe(false);
    expect(
      shouldUseOpenAIWebSocketTransport({
        modelApi: "openai-responses",
        provider: "anthropic",
      }),
    ).toBe(false);
  });
});
