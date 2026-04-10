import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
} from "./proxy-stream-wrappers.js";

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: { headers?: Record<string, string> }[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({
        headers: options?.headers,
      });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      id: "openrouter/auto",
      provider: "openrouter",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-Custom": "1",
          "X-OpenRouter-Categories": "cli-agent",
          "X-OpenRouter-Title": "OpenClaw",
        },
      },
    ]);
  });

  it("injects cache_control markers for declared OpenRouter Anthropic models on the default route", () => {
    const payload = {
      messages: [{ content: "system prompt", role: "system" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { cache_control: { type: "ephemeral" }, text: "system prompt", type: "text" },
    ]);
  });

  it("does not inject cache_control markers for declared OpenRouter providers on custom proxy URLs", () => {
    const payload = {
      messages: [{ content: "system prompt", role: "system" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it("injects cache_control markers for native OpenRouter hosts behind custom provider ids", () => {
    const payload = {
      messages: [{ content: "system prompt", role: "system" }],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        id: "anthropic/claude-sonnet-4.6",
        provider: "custom-openrouter",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payload.messages[0]?.content).toEqual([
      { cache_control: { type: "ephemeral" }, text: "system prompt", type: "text" },
    ]);
  });
});
