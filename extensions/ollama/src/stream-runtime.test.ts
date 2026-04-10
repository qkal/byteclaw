import { describe, expect, it, vi } from "vitest";
import {
  buildAssistantMessage,
  buildOllamaChatRequest,
  convertToOllamaMessages,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  parseNdjsonStream,
  resolveOllamaBaseUrlForRun,
} from "./stream.js";

describe("buildOllamaChatRequest", () => {
  it("omits tools when none are provided", () => {
    expect(
      buildOllamaChatRequest({
        messages: [{ content: "hello", role: "user" }],
        modelId: "qwen3.5:9b",
        options: { num_ctx: 65_536 },
      }),
    ).toEqual({
      messages: [{ content: "hello", role: "user" }],
      model: "qwen3.5:9b",
      options: { num_ctx: 65_536 },
      stream: true,
    });
  });
});

describe("convertToOllamaMessages", () => {
  it("converts user text messages", () => {
    const messages = [{ content: "hello", role: "user" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "hello", role: "user" }]);
  });

  it("converts user messages with content parts", () => {
    const messages = [
      {
        content: [
          { text: "describe this", type: "text" },
          { data: "base64data", type: "image" },
        ],
        role: "user",
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "describe this", images: ["base64data"], role: "user" }]);
  });

  it("prepends system message when provided", () => {
    const messages = [{ content: "hello", role: "user" }];
    const result = convertToOllamaMessages(messages, "You are helpful.");
    expect(result[0]).toEqual({ content: "You are helpful.", role: "system" });
    expect(result[1]).toEqual({ content: "hello", role: "user" });
  });

  it("converts assistant messages with toolCall content blocks", () => {
    const messages = [
      {
        content: [
          { text: "Let me check.", type: "text" },
          { arguments: { command: "ls" }, id: "call_1", name: "bash", type: "toolCall" },
        ],
        role: "assistant",
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me check.");
    expect(result[0].tool_calls).toEqual([
      { function: { arguments: { command: "ls" }, name: "bash" } },
    ]);
  });

  it("deserializes string arguments back to objects for Ollama (round-trip fix)", () => {
    // When tool calls round-trip through OpenAI-format storage, arguments
    // Are serialized as a JSON string.  Ollama expects an object.
    const messages = [
      {
        content: [
          {
            arguments: '{"file_path":"/tmp/test.txt"}',
            id: "call_2",
            name: "Read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      { function: { arguments: { file_path: "/tmp/test.txt" }, name: "Read" } },
    ]);
  });

  it("handles tool_use blocks with string input (Anthropic format round-trip)", () => {
    const messages = [
      {
        content: [
          { id: "toolu_1", input: '{"command":"echo hello"}', name: "exec", type: "tool_use" },
        ],
        role: "assistant",
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      { function: { arguments: { command: "echo hello" }, name: "exec" } },
    ]);
  });

  it("preserves unsafe integers as strings when replay args are deserialized", () => {
    const messages = [
      {
        content: [
          {
            arguments: '{"path":9223372036854775807,"nested":{"thread":1234567890123456789}}',
            id: "call_3",
            name: "read",
            type: "toolCall",
          },
        ],
        role: "assistant",
      },
    ];
    const result = convertToOllamaMessages(messages);
    expect(result[0].tool_calls).toEqual([
      {
        function: {
          arguments: {
            nested: { thread: "1234567890123456789" },
            path: "9223372036854775807",
          },
          name: "read",
        },
      },
    ]);
  });
  it("converts tool result messages with 'tool' role", () => {
    const messages = [{ content: "file1.txt\nfile2.txt", role: "tool" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "file1.txt\nfile2.txt", role: "tool" }]);
  });

  it("converts SDK 'toolResult' role to Ollama 'tool' role", () => {
    const messages = [{ content: "command output here", role: "toolResult" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "command output here", role: "tool" }]);
  });

  it("includes tool_name from SDK toolResult messages", () => {
    const messages = [{ content: "file contents here", role: "toolResult", toolName: "read" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "file contents here", role: "tool", tool_name: "read" }]);
  });

  it("omits tool_name when not provided in toolResult", () => {
    const messages = [{ content: "output", role: "toolResult" }];
    const result = convertToOllamaMessages(messages);
    expect(result).toEqual([{ content: "output", role: "tool" }]);
    expect(result[0]).not.toHaveProperty("tool_name");
  });

  it("handles empty messages array", () => {
    const result = convertToOllamaMessages([]);
    expect(result).toEqual([]);
  });
});

describe("buildAssistantMessage", () => {
  const modelInfo = { api: "ollama", id: "qwen3:32b", provider: "ollama" };

  it("builds text-only response", () => {
    const response = {
      created_at: "2026-01-01T00:00:00Z",
      done: true,
      eval_count: 5,
      message: { content: "Hello!", role: "assistant" as const },
      model: "qwen3:32b",
      prompt_eval_count: 10,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.role).toBe("assistant");
    expect(result.content).toEqual([{ text: "Hello!", type: "text" }]);
    expect(result.stopReason).toBe("stop");
    expect(result.usage.input).toBe(10);
    expect(result.usage.output).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
  });

  it("keeps thinking-only output when content is empty", () => {
    const response = {
      created_at: "2026-01-01T00:00:00Z",
      done: true,
      message: {
        content: "",
        role: "assistant" as const,
        thinking: "Thinking output",
      },
      model: "qwen3:32b",
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ thinking: "Thinking output", type: "thinking" }]);
  });

  it("keeps reasoning-only output when content and thinking are empty", () => {
    const response = {
      created_at: "2026-01-01T00:00:00Z",
      done: true,
      message: {
        content: "",
        reasoning: "Reasoning output",
        role: "assistant" as const,
      },
      model: "qwen3:32b",
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ thinking: "Reasoning output", type: "thinking" }]);
  });

  it("builds response with tool calls", () => {
    const response = {
      created_at: "2026-01-01T00:00:00Z",
      done: true,
      eval_count: 10,
      message: {
        content: "",
        role: "assistant" as const,
        tool_calls: [{ function: { arguments: { command: "ls -la" }, name: "bash" } }],
      },
      model: "qwen3:32b",
      prompt_eval_count: 20,
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.length).toBe(1); // ToolCall only (empty content is skipped)
    expect(result.content[0].type).toBe("toolCall");
    const toolCall = result.content[0] as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    expect(toolCall.name).toBe("bash");
    expect(toolCall.arguments).toEqual({ command: "ls -la" });
    expect(toolCall.id).toMatch(/^ollama_call_[0-9a-f-]{36}$/);
  });

  it("sets all costs to zero for local models", () => {
    const response = {
      created_at: "2026-01-01T00:00:00Z",
      done: true,
      message: { content: "ok", role: "assistant" as const },
      model: "qwen3:32b",
    };
    const result = buildAssistantMessage(response, modelInfo);
    expect(result.usage.cost).toEqual({
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0,
    });
  });
});

// Helper: build a ReadableStreamDefaultReader from NDJSON lines
function mockNdjsonReader(lines: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.join("\n") + "\n";
  let consumed = false;
  return {
    cancel: async () => {},
    closed: Promise.resolve(undefined),
    read: async () => {
      if (consumed) {
        return { done: true as const, value: undefined };
      }
      consumed = true;
      return { done: false as const, value: encoder.encode(payload) };
    },
    releaseLock: () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function expectDoneEventContent(lines: string[], expectedContent: unknown) {
  await withMockNdjsonFetch(lines, async () => {
    const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
    const events = await collectStreamEvents(stream);

    const doneEvent = events.at(-1);
    if (!doneEvent || doneEvent.type !== "done") {
      throw new Error("Expected done event");
    }

    expect(doneEvent.message.content).toEqual(expectedContent);
  });
}

describe("parseNdjsonStream", () => {
  it("parses text-only streaming chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":" world"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0].message.content).toBe("Hello");
    expect(chunks[1].message.content).toBe(" world");
    expect(chunks[2].done).toBe(true);
  });

  it("parses tool_calls from intermediate chunk (not final)", async () => {
    // Ollama sends tool_calls in done:false chunk, final done:true has no tool_calls
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
    ]);
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].done).toBe(false);
    expect(chunks[0].message.tool_calls).toHaveLength(1);
    expect(chunks[0].message.tool_calls![0].function.name).toBe("bash");
    expect(chunks[1].done).toBe(true);
    expect(chunks[1].message.tool_calls).toBeUndefined();
  });

  it("accumulates tool_calls across multiple intermediate chunks", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read","arguments":{"path":"/tmp/a"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
    ]);

    // Simulate the accumulation logic from createOllamaStreamFn
    const accumulatedToolCalls: {
      function: { name: string; arguments: Record<string, unknown> };
    }[] = [];
    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
      if (chunk.message?.tool_calls) {
        accumulatedToolCalls.push(...chunk.message.tool_calls);
      }
    }
    expect(accumulatedToolCalls).toHaveLength(2);
    expect(accumulatedToolCalls[0].function.name).toBe("read");
    expect(accumulatedToolCalls[1].function.name).toBe("bash");
    // Final done:true chunk has no tool_calls
    expect(chunks[2].message.tool_calls).toBeUndefined();
  });

  it("preserves unsafe integer tool arguments as exact strings", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"target":1234567890123456789,"nested":{"thread":9223372036854775807}}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { target?: unknown; nested?: { thread?: unknown } }
      | undefined;
    expect(args?.target).toBe("1234567890123456789");
    expect(args?.nested?.thread).toBe("9223372036854775807");
  });

  it("keeps safe integer tool arguments as numbers", async () => {
    const reader = mockNdjsonReader([
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"send","arguments":{"retries":3,"delayMs":2500}}}]},"done":false}',
    ]);

    const chunks = [];
    for await (const chunk of parseNdjsonStream(reader)) {
      chunks.push(chunk);
    }

    const args = chunks[0]?.message.tool_calls?.[0]?.function.arguments as
      | { retries?: unknown; delayMs?: unknown }
      | undefined;
    expect(args?.retries).toBe(3);
    expect(args?.delayMs).toBe(2500);
  });
});

async function withMockNdjsonFetch(
  lines: string[],
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => {
    const payload = lines.join("\n");
    return new Response(`${payload}\n`, {
      headers: { "Content-Type": "application/x-ndjson" },
      status: 200,
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createControlledNdjsonFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  pushLine: (line: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    close() {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.close();
    },
    fetchMock: vi.fn(async () => new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      })),
    pushLine(line: string) {
      if (!controller) {
        throw new Error("NDJSON controller not initialized");
      }
      controller.enqueue(encoder.encode(`${line}\n`));
    },
  };
}

async function createOllamaTestStream(params: {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  options?: {
    apiKey?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  };
}) {
  const streamFn = createOllamaStreamFn(params.baseUrl, params.defaultHeaders);
  return streamFn(
    {
      api: "ollama",
      contextWindow: 131_072,
      id: "qwen3:32b",
      provider: "custom-ollama",
    } as unknown as Parameters<typeof streamFn>[0],
    {
      messages: [{ content: "hello", role: "user" }],
    } as unknown as Parameters<typeof streamFn>[1],
    (params.options ?? {}) as unknown as Parameters<typeof streamFn>[2],
  );
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function nextEventWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs = 100,
): Promise<IteratorResult<T> | "timeout"> {
  return await Promise.race([
    iterator.next(),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
}

describe("createOllamaStreamFn streaming events", () => {
  it("emits start, text_start, text_delta, text_end, done for text responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Hello"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" world"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual([
          "start",
          "text_start",
          "text_delta",
          "text_delta",
          "text_end",
          "done",
        ]);

        // Text_delta events carry incremental deltas
        const deltas = events.filter((e) => e.type === "text_delta");
        expect(deltas[0]).toMatchObject({ contentIndex: 0, delta: "Hello" });
        expect(deltas[1]).toMatchObject({ contentIndex: 0, delta: " world" });

        // Text_end carries the full accumulated content
        const textEnd = events.find((e) => e.type === "text_end");
        expect(textEnd).toMatchObject({ content: "Hello world", contentIndex: 0 });

        // Start/text_start carry empty partials (before any content accumulates)
        const startEvent = events.find((e) => e.type === "start");
        expect(startEvent?.partial.content).toEqual([]);
        const textStartEvent = events.find((e) => e.type === "text_start");
        expect(textStartEvent?.partial.content).toEqual([]);

        // Text_delta partials accumulate content progressively
        expect(deltas[0].partial.content).toEqual([{ text: "Hello", type: "text" }]);
        expect(deltas[1].partial.content).toEqual([{ text: "Hello world", type: "text" }]);

        // Done event contains the final message
        const doneEvent = events.at(-1);
        expect(doneEvent?.type).toBe("done");
        if (doneEvent?.type === "done") {
          expect(doneEvent.message.content).toEqual([{ text: "Hello world", type: "text" }]);
        }
      },
    );
  });

  it("emits only done for tool-call-only responses (no text content)", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        // No text content means no start/text_start/text_delta/text_end events
        const types = events.map((e) => e.type);
        expect(types).toEqual(["done"]);
        const doneEvent = events[0];
        if (doneEvent.type === "done") {
          expect(doneEvent.reason).toBe("toolUse");
        }
      },
    );
  });

  it("emits text streaming events before done for mixed text + tool responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Let me check."},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
        const doneEvent = events.at(-1);
        if (doneEvent?.type === "done") {
          expect(doneEvent.reason).toBe("toolUse");
        }
      },
    );
  });

  it("emits text_end as soon as Ollama switches from text to tool calls", async () => {
    const originalFetch = globalThis.fetch;
    const controlledFetch = createControlledNdjsonFetch();
    globalThis.fetch = controlledFetch.fetchMock as unknown as typeof fetch;

    try {
      const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
      const iterator = stream[Symbol.asyncIterator]();

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"Let me check."},"done":false}',
      );

      const startEvent = await nextEventWithin(iterator);
      const textStartEvent = await nextEventWithin(iterator);
      const textDeltaEvent = await nextEventWithin(iterator);

      expect(startEvent).not.toBe("timeout");
      expect(textStartEvent).not.toBe("timeout");
      expect(textDeltaEvent).not.toBe("timeout");
      expect(startEvent).toMatchObject({ done: false, value: { type: "start" } });
      expect(textStartEvent).toMatchObject({ done: false, value: { type: "text_start" } });
      expect(textDeltaEvent).toMatchObject({
        done: false,
        value: { delta: "Let me check.", type: "text_delta" },
      });

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]},"done":false}',
      );

      const textEndEvent = await nextEventWithin(iterator);
      expect(textEndEvent).not.toBe("timeout");
      expect(textEndEvent).toMatchObject({
        done: false,
        value: {
          content: "Let me check.",
          contentIndex: 0,
          partial: {
            content: [{ text: "Let me check.", type: "text" }],
          },
          type: "text_end",
        },
      });

      controlledFetch.pushLine(
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}',
      );
      controlledFetch.close();

      const doneEvent = await nextEventWithin(iterator);
      expect(doneEvent).not.toBe("timeout");
      if (doneEvent !== "timeout" && doneEvent.done === false) {
        expect(doneEvent).toMatchObject({
          done: false,
          value: { reason: "toolUse", type: "done" },
        });

        const streamEnd = await nextEventWithin(iterator);
        expect(streamEnd).not.toBe("timeout");
        expect(streamEnd).toMatchObject({ done: true, value: undefined });
      } else {
        expect(doneEvent).toMatchObject({ done: true, value: undefined });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits error without text_end when stream fails mid-response", async () => {
    // Simulate a stream that sends one content chunk then ends without done:true.
    // The stream function throws "Ollama API stream ended without a final response".
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"partial"},"done":false}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        // Should have streaming events for the partial content, then error (no text_end).
        expect(types).toEqual(["start", "text_start", "text_delta", "error"]);
        const errorEvent = events.at(-1);
        expect(errorEvent?.type).toBe("error");
      },
    );
  });

  it("emits a single text_delta for single-chunk responses", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"one shot"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async () => {
        const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
        const events = await collectStreamEvents(stream);

        const types = events.map((e) => e.type);
        expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);

        const delta = events.find((e) => e.type === "text_delta");
        expect(delta).toMatchObject({ delta: "one shot" });
      },
    );
  });
});

describe("createOllamaStreamFn", () => {
  it("normalizes /v1 baseUrl and maps maxTokens + signal", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const {signal} = new AbortController();
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434/v1/",
          options: { maxTokens: 123, signal },
        });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://ollama-host:11434/api/chat");
        expect(requestInit.signal).toBe(signal);
        if (typeof requestInit.body !== "string") {
          throw new Error("Expected string request body");
        }

        const requestBody = JSON.parse(requestInit.body) as {
          options: { num_ctx?: number; num_predict?: number };
        };
        expect(requestBody.options.num_ctx).toBe(131_072);
        expect(requestBody.options.num_predict).toBe(123);
      },
    );
  });

  it("merges default headers and allows request headers to override them", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            "X-OLLAMA-KEY": "provider-secret",
            "X-Trace": "default",
          },
          options: {
            headers: {
              "X-Request-Only": "1",
              "X-Trace": "request",
            },
          },
        });

        const events = await collectStreamEvents(stream);
        expect(events.at(-1)?.type).toBe("done");

        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          "Content-Type": "application/json",
          "X-OLLAMA-KEY": "provider-secret",
          "X-Request-Only": "1",
          "X-Trace": "request",
        });
      },
    );
  });

  it("preserves an explicit Authorization header when apiKey is a local marker", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const stream = await createOllamaTestStream({
          baseUrl: "http://ollama-host:11434",
          defaultHeaders: {
            Authorization: "Bearer proxy-token",
          },
          options: {
            apiKey: "ollama-local", // Pragma: allowlist secret
            headers: {
              Authorization: "Bearer proxy-token",
            },
          },
        });

        await collectStreamEvents(stream);
        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });

  it("allows a real apiKey to override an explicit Authorization header", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createOllamaStreamFn("http://ollama-host:11434", {
          Authorization: "Bearer proxy-token",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              api: "ollama",
              contextWindow: 131_072,
              id: "qwen3:32b",
              provider: "custom-ollama",
            } as never,
            {
              messages: [{ content: "hello", role: "user" }],
            } as never,
            {
              apiKey: "real-token", // Pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer real-token",
        });
      },
    );
  });

  it("surfaces non-2xx HTTP response as status-prefixed error", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response("Service Unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const stream = await createOllamaTestStream({ baseUrl: "http://ollama-host:11434" });
      const events = await collectStreamEvents(stream);

      const errorEvent = events.find((e) => e.type === "error") as
        | { type: "error"; error: { errorMessage?: string } }
        | undefined;
      expect(errorEvent).toBeDefined();
      // The error message must start with the HTTP status code so that
      // ExtractLeadingHttpStatus can parse it for failover/retry logic.
      expect(errorEvent!.error.errorMessage).toMatch(/^503\b/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps thinking chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ thinking: "reasoned output", type: "thinking" }],
    );
  });

  it("keeps streamed content after earlier thinking chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","thinking":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [
        { thinking: "internal", type: "thinking" },
        { text: "final answer", type: "text" },
      ],
    );
  });

  it("keeps reasoning chunks when no final content is emitted", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"reasoned"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":" output"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [{ thinking: "reasoned output", type: "thinking" }],
    );
  });

  it("keeps streamed content after earlier reasoning chunks", async () => {
    await expectDoneEventContent(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"","reasoning":"internal"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"final"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":" answer"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":2}',
      ],
      [
        { thinking: "internal", type: "thinking" },
        { text: "final answer", type: "text" },
      ],
    );
  });
});

describe("resolveOllamaBaseUrlForRun", () => {
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

describe("createConfiguredOllamaStreamFn", () => {
  it("uses provider-level baseUrl when model baseUrl is absent", async () => {
    await withMockNdjsonFetch(
      [
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
        '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
      ],
      async (fetchMock) => {
        const streamFn = createConfiguredOllamaStreamFn({
          model: {
            headers: { Authorization: "Bearer proxy-token" },
          },
          providerBaseUrl: "http://provider-host:11434/v1",
        });
        const stream = await Promise.resolve(
          streamFn(
            {
              api: "ollama",
              contextWindow: 131_072,
              id: "qwen3:32b",
              provider: "custom-ollama",
            } as never,
            {
              messages: [{ content: "hello", role: "user" }],
            } as never,
            {
              apiKey: "ollama-local", // Pragma: allowlist secret
            } as never,
          ),
        );

        await collectStreamEvents(stream);
        const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://provider-host:11434/api/chat");
        expect(requestInit.headers).toMatchObject({
          Authorization: "Bearer proxy-token",
        });
      },
    );
  });
});
