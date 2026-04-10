import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const {
  anthropicCtorMock,
  anthropicMessagesStreamMock,
  buildGuardedModelFetchMock,
  guardedFetchMock,
} = vi.hoisted(() => ({
  anthropicCtorMock: vi.fn(),
  anthropicMessagesStreamMock: vi.fn(),
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicCtorMock,
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

function emptyEventStream(): AsyncIterable<Record<string, unknown>> {
  return (async function* () {})();
}

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    anthropicCtorMock.mockReset();
    anthropicMessagesStreamMock.mockReset();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    anthropicMessagesStreamMock.mockReturnValue(emptyEventStream());
    anthropicCtorMock.mockImplementation(function mockAnthropicClient() {
      return {
        messages: {
          stream: anthropicMessagesStreamMock,
        },
      };
    });
  });

  it("uses the guarded fetch transport for api-key Anthropic requests", async () => {
    const model = attachModelProviderRequestTransport(
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        headers: { "X-Provider": "anthropic" },
        id: "claude-sonnet-4-6",
        input: ["text"],
        maxTokens: 8192,
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        reasoning: true,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ content: "hello", role: "user" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          headers: { "X-Call": "1" },
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-ant-api",
        baseURL: "https://api.anthropic.com",
        defaultHeaders: expect.objectContaining({
          "X-Call": "1",
          "X-Provider": "anthropic",
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        }),
        fetch: guardedFetchMock,
      }),
    );
    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        stream: true,
      }),
      undefined,
    );
  });

  it("preserves Anthropic OAuth identity and tool-name remapping with transport overrides", async () => {
    anthropicMessagesStreamMock.mockReturnValueOnce(
      (async function* () {
        yield {
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
          type: "message_start",
        };
        yield {
          content_block: {
            id: "tool_1",
            input: { path: "/tmp/a" },
            name: "Read",
            type: "tool_use",
          },
          index: 0,
          type: "content_block_start",
        };
        yield {
          index: 0,
          type: "content_block_stop",
        };
        yield {
          delta: { stop_reason: "tool_use" },
          type: "message_delta",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })(),
    );
    const model = attachModelProviderRequestTransport(
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "claude-sonnet-4-6",
        input: ["text"],
        maxTokens: 8192,
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        reasoning: true,
      } satisfies Model<"anthropic-messages">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ content: "Read the file", role: "user" }],
          systemPrompt: "Follow policy.",
          tools: [
            {
              description: "Read a file",
              name: "read",
              parameters: {
                properties: {
                  path: { type: "string" },
                },
                required: ["path"],
                type: "object",
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-oat-example",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(anthropicCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: "sk-ant-oat-example",
        defaultHeaders: expect.objectContaining({
          "user-agent": expect.stringContaining("claude-cli/"),
          "x-app": "cli",
        }),
        fetch: guardedFetchMock,
      }),
    );
    const firstCallParams = anthropicMessagesStreamMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCallParams.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        }),
        expect.objectContaining({
          text: "Follow policy.",
        }),
      ]),
    );
    expect(firstCallParams.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Read" })]),
    );
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "read", type: "toolCall" })]),
    );
  });

  it("maps adaptive thinking effort for Claude 4.6 transport runs", async () => {
    const model = attachModelProviderRequestTransport(
      {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "claude-opus-4-6",
        input: ["text"],
        maxTokens: 8192,
        name: "Claude Opus 4.6",
        provider: "anthropic",
        reasoning: true,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "env-proxy",
        },
      },
    );
    const streamFn = createAnthropicMessagesTransportStreamFn();

    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ content: "Think deeply.", role: "user" }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: "sk-ant-api",
          reasoning: "xhigh",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(anthropicMessagesStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        output_config: { effort: "max" },
        thinking: { type: "adaptive" },
      }),
      undefined,
    );
  });
});
