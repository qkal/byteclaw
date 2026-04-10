import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

interface StreamPayload {
  messages: {
    role: string;
    content: unknown;
  }[];
}

function runOpenRouterPayload(payload: StreamPayload, modelId: string) {
  runExtraParamsCase({
    cfg: {
      plugins: {
        entries: {
          openrouter: {
            enabled: true,
          },
        },
      },
    },
    model: {
      api: "openai-completions",
      id: modelId,
      provider: "openrouter",
    } as Model<"openai-completions">,
    payload,
  });
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("injects cache_control into system message for OpenRouter Anthropic models", () => {
    const payload = {
      messages: [
        { content: "You are a helpful assistant.", role: "system" },
        { content: "Hello", role: "user" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { cache_control: { type: "ephemeral" }, text: "You are a helpful assistant.", type: "text" },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          content: [
            { text: "Part 1", type: "text" },
            { text: "Part 2", type: "text" },
          ],
          role: "system",
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Record<string, unknown>[];
    expect(content[0]).toEqual({ text: "Part 1", type: "text" });
    expect(content[1]).toEqual({
      cache_control: { type: "ephemeral" },
      text: "Part 2",
      type: "text",
    });
  });

  it("does not inject cache_control for OpenRouter non-Anthropic models", () => {
    const payload = {
      messages: [{ content: "You are a helpful assistant.", role: "system" }],
    };

    runOpenRouterPayload(payload, "google/gemini-3-pro");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ content: "Hello", role: "user" }],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toBe("Hello");
  });

  it("does not inject cache_control into thinking blocks", () => {
    const payload = {
      messages: [
        {
          content: [
            { text: "Part 1", type: "text" },
            { thinking: "internal", thinkingSignature: "sig_1", type: "thinking" },
          ],
          role: "system",
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { text: "Part 1", type: "text" },
      { thinking: "internal", thinkingSignature: "sig_1", type: "thinking" },
    ]);
  });

  it("removes pre-existing cache_control from assistant thinking blocks", () => {
    const payload = {
      messages: [
        {
          content: [
            {
              cache_control: { type: "ephemeral" },
              thinking: "internal",
              thinkingSignature: "sig_1",
              type: "thinking",
            },
            { text: "visible", type: "text" },
          ],
          role: "assistant",
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { thinking: "internal", thinkingSignature: "sig_1", type: "thinking" },
      { text: "visible", type: "text" },
    ]);
  });
});
