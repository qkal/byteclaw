import { describe, expect, it } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import { buildAssistantMessageFromResponse } from "./openai-ws-message-conversion.js";

describe("openai ws message conversion", () => {
  it("preserves cached token usage from responses usage details", () => {
    const response: ResponseObject = {
      created_at: Date.now(),
      id: "resp_123",
      model: "gpt-5",
      object: "response",
      output: [
        {
          content: [{ type: "output_text", text: "hello" }],
          id: "msg_123",
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      status: "completed",
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 30,
        total_tokens: 250,
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    });

    expect(message.usage).toMatchObject({
      cacheRead: 100,
      cacheWrite: 0,
      input: 20,
      output: 30,
      totalTokens: 250,
    });
  });

  it("derives cache-inclusive total tokens when responses total is missing", () => {
    const response: ResponseObject = {
      created_at: Date.now(),
      id: "resp_124",
      model: "gpt-5",
      object: "response",
      output: [
        {
          content: [{ type: "output_text", text: "hello" }],
          id: "msg_124",
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      status: "completed",
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens: 30,
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      id: "gpt-5",
      provider: "openai",
    });

    expect(message.usage).toMatchObject({
      cacheRead: 100,
      cacheWrite: 0,
      input: 20,
      output: 30,
      totalTokens: 150,
    });
  });
});
