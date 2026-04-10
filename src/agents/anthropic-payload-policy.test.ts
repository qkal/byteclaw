import { describe, expect, it } from "vitest";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "./anthropic-payload-policy.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";

interface TestPayload {
  messages: { role: string; content: unknown }[];
  service_tier?: string;
  system?: unknown;
}

describe("anthropic payload policy", () => {
  it("applies native Anthropic service tier and cache markers without widening cache scope", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
      provider: "anthropic",
      serviceTier: "standard_only",
    });
    const payload: TestPayload = {
      messages: [
        {
          content: [{ type: "text", text: "Working." }],
          role: "assistant",
        },
        {
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_result", tool_use_id: "tool_1", content: "done" },
          ],
          role: "user",
        },
      ],
      system: [
        { text: "Follow policy.", type: "text" },
        { text: "Use tools carefully.", type: "text" },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.service_tier).toBe("standard_only");
    expect(payload.system).toEqual([
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Follow policy.",
        type: "text",
      },
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Use tools carefully.",
        type: "text",
      },
    ]);
    expect(payload.messages[0]).toEqual({
      content: [{ text: "Working.", type: "text" }],
      role: "assistant",
    });
    expect(payload.messages[1]).toEqual({
      content: [
        { text: "Hello", type: "text" },
        {
          cache_control: { ttl: "1h", type: "ephemeral" },
          content: "done",
          tool_use_id: "tool_1",
          type: "tool_result",
        },
      ],
      role: "user",
    });
  });

  it("denies proxied Anthropic service tier and omits long-TTL upgrades for custom hosts", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://proxy.example.com/anthropic",
      cacheRetention: "long",
      enableCacheControl: true,
      provider: "anthropic",
      serviceTier: "auto",
    });
    const payload: TestPayload = {
      messages: [{ content: "Hello", role: "user" }],
      system: [{ text: "Follow policy.", type: "text" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload).not.toHaveProperty("service_tier");
    expect(payload.system).toEqual([
      {
        cache_control: { type: "ephemeral" },
        text: "Follow policy.",
        type: "text",
      },
    ]);
    expect(payload.messages[0]).toEqual({
      content: [{ cache_control: { type: "ephemeral" }, text: "Hello", type: "text" }],
      role: "user",
    });
  });

  it("splits cached stable system content from uncached dynamic content", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "long",
      enableCacheControl: true,
      provider: "anthropic",
    });
    const payload: TestPayload = {
      messages: [{ content: "Hello", role: "user" }],
      system: [
        {
          text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
          type: "text",
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Stable prefix",
        type: "text",
      },
      {
        text: "Dynamic lab suffix",
        type: "text",
      },
    ]);
  });

  it("applies 1h TTL for Vertex AI endpoints with long cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "long",
      enableCacheControl: true,
      provider: "anthropic-vertex",
    });
    const payload: TestPayload = {
      messages: [{ content: "Hello", role: "user" }],
      system: [
        { text: "Follow policy.", type: "text" },
        { text: "Use tools carefully.", type: "text" },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Follow policy.",
        type: "text",
      },
      {
        cache_control: { ttl: "1h", type: "ephemeral" },
        text: "Use tools carefully.",
        type: "text",
      },
    ]);
    expect(payload.messages[0]).toEqual({
      content: [{ cache_control: { ttl: "1h", type: "ephemeral" }, text: "Hello", type: "text" }],
      role: "user",
    });
  });

  it("applies 5m ephemeral cache for Vertex AI endpoints with short cache retention", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      cacheRetention: "short",
      enableCacheControl: true,
      provider: "anthropic-vertex",
    });
    const payload: TestPayload = {
      messages: [{ content: "Hello", role: "user" }],
      system: [{ text: "Follow policy.", type: "text" }],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        cache_control: { type: "ephemeral" },
        text: "Follow policy.",
        type: "text",
      },
    ]);
  });

  it("strips the boundary even when cache retention is disabled", () => {
    const policy = resolveAnthropicPayloadPolicy({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      cacheRetention: "none",
      enableCacheControl: true,
      provider: "anthropic",
    });
    const payload: TestPayload = {
      messages: [{ content: "Hello", role: "user" }],
      system: [
        {
          text: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic lab suffix`,
          type: "text",
        },
      ],
    };

    applyAnthropicPayloadPolicyToParams(payload, policy);

    expect(payload.system).toEqual([
      {
        text: "Stable prefix\nDynamic lab suffix",
        type: "text",
      },
    ]);
  });
});
