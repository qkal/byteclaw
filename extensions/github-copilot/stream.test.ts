import { buildCopilotDynamicHeaders } from "openclaw/plugin-sdk/provider-stream-shared";
import { describe, expect, it, vi } from "vitest";
import { wrapCopilotAnthropicStream, wrapCopilotProviderStream } from "./stream.js";

describe("wrapCopilotAnthropicStream", () => {
  it("adds Copilot headers and Anthropic cache markers for Claude payloads", async () => {
    const payloads: {
      messages: Record<string, unknown>[];
    }[] = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { content: "system prompt", role: "system" },
          {
            content: [{ cache_control: { type: "ephemeral" }, text: "draft", type: "thinking" }],
            role: "assistant",
          },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = wrapCopilotAnthropicStream(baseStreamFn);
    const messages = [
      {
        content: [
          { text: "look", type: "text" },
          { image: "data:image/png;base64,abc", type: "image" },
        ],
        role: "user",
      },
    ] as Parameters<typeof buildCopilotDynamicHeaders>[0]["messages"];
    const context = { messages };
    const expectedCopilotHeaders = buildCopilotDynamicHeaders({
      hasImages: true,
      messages,
    });

    wrapped(
      {
        api: "anthropic-messages",
        id: "claude-sonnet-4.6",
        provider: "github-copilot",
      } as never,
      context as never,
      {
        headers: { "X-Test": "1" },
      },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(baseStreamFn.mock.calls[0]?.[2]).toMatchObject({
      headers: {
        ...expectedCopilotHeaders,
        "X-Test": "1",
      },
    });
    expect(payloads[0]?.messages).toEqual([
      {
        content: [{ cache_control: { type: "ephemeral" }, text: "system prompt", type: "text" }],
        role: "system",
      },
      {
        content: [{ text: "draft", type: "thinking" }],
        role: "assistant",
      },
    ]);
  });

  it("leaves non-Anthropic Copilot models untouched", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = wrapCopilotAnthropicStream(baseStreamFn);
    const options = { headers: { Existing: "1" } };

    wrapped(
      {
        api: "openai-responses",
        id: "gpt-4.1",
        provider: "github-copilot",
      } as never,
      { messages: [{ content: "hi", role: "user" }] } as never,
      options as never,
    );

    expect(baseStreamFn).toHaveBeenCalledWith(expect.anything(), expect.anything(), options);
  });

  it("adapts provider stream context without changing wrapper behavior", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);

    const wrapped = wrapCopilotProviderStream({
      streamFn: baseStreamFn,
    } as never);

    wrapped(
      {
        api: "openai-responses",
        id: "gpt-4.1",
        provider: "github-copilot",
      } as never,
      { messages: [{ content: "hi", role: "user" }] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
  });
});
