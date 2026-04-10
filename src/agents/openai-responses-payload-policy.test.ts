import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";

describe("openai responses payload policy", () => {
  it("forces store for native OpenAI responses payloads but keeps disable mode for transport defaults", () => {
    const model = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "gpt-5.4",
      input: ["text"],
      maxTokens: 8192,
      name: "GPT-5.4",
      provider: "openai",
      reasoning: true,
    } satisfies Model<"openai-responses">;

    expect(
      resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "provider-policy" }),
    ).toMatchObject({
      allowsServiceTier: true,
      explicitStore: true,
    });
    expect(resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" })).toMatchObject({
      allowsServiceTier: true,
      explicitStore: false,
    });
  });

  it("strips store and prompt cache for proxy-like responses routes when requested", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
        provider: "openai",
      },
      {
        enablePromptCacheStripping: true,
        storeMode: "provider-policy",
      },
    );
    const payload = {
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      store: false,
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(payload, policy);

    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps disabled reasoning payloads on native OpenAI responses routes", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          provider: "openai",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      reasoning: {
        effort: "none",
      },
      store: false,
    });
  });

  it("strips disabled reasoning payloads for proxy-like OpenAI responses routes", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          provider: "openai",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).not.toHaveProperty("reasoning");
  });
});
