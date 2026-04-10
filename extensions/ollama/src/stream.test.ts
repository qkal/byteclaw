import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssistantMessage, createOllamaStreamFn } from "./stream.js";

function makeOllamaResponse(params: {
  content?: string;
  thinking?: string;
  reasoning?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}) {
  return {
    created_at: new Date().toISOString(),
    done: true,
    eval_count: 50,
    message: {
      content: params.content ?? "",
      role: "assistant" as const,
      ...(params.thinking != null ? { thinking: params.thinking } : {}),
      ...(params.reasoning != null ? { reasoning: params.reasoning } : {}),
      ...(params.tool_calls ? { tool_calls: params.tool_calls } : {}),
    },
    model: "qwen3.5",
    prompt_eval_count: 100,
  };
}

const MODEL_INFO = { api: "ollama", id: "qwen3.5", provider: "ollama" };

describe("buildAssistantMessage", () => {
  it("includes thinking block when response has thinking field", () => {
    const response = makeOllamaResponse({
      content: "The answer is 42",
      thinking: "Let me think about this",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ thinking: "Let me think about this", type: "thinking" });
    expect(msg.content[1]).toEqual({ text: "The answer is 42", type: "text" });
  });

  it("includes thinking block when response has reasoning field", () => {
    const response = makeOllamaResponse({
      content: "Result is 7",
      reasoning: "Step by step analysis",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ thinking: "Step by step analysis", type: "thinking" });
    expect(msg.content[1]).toEqual({ text: "Result is 7", type: "text" });
  });

  it("prefers thinking over reasoning when both are present", () => {
    const response = makeOllamaResponse({
      content: "Answer",
      reasoning: "From reasoning field",
      thinking: "From thinking field",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content[0]).toEqual({ thinking: "From thinking field", type: "thinking" });
  });

  it("omits thinking block when no thinking or reasoning field", () => {
    const response = makeOllamaResponse({
      content: "Just text",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ text: "Just text", type: "text" });
  });

  it("omits thinking block when thinking field is empty", () => {
    const response = makeOllamaResponse({
      content: "Just text",
      thinking: "",
    });
    const msg = buildAssistantMessage(response, MODEL_INFO);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ text: "Just text", type: "text" });
  });
});

describe("createOllamaStreamFn thinking events", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeNdjsonBody(chunks: Record<string, unknown>[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const lines = chunks.map((c) => JSON.stringify(c) + "\n").join("");
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });
  }

  it("emits thinking_start, thinking_delta, and thinking_end events for thinking content", async () => {
    const thinkingChunks = [
      {
        created_at: "2026-01-01T00:00:00Z",
        done: false,
        message: { content: "", role: "assistant", thinking: "Step 1" },
        model: "qwen3.5",
      },
      {
        created_at: "2026-01-01T00:00:01Z",
        done: false,
        message: { content: "", role: "assistant", thinking: " and step 2" },
        model: "qwen3.5",
      },
      {
        created_at: "2026-01-01T00:00:02Z",
        done: false,
        message: { content: "The answer", role: "assistant", thinking: "" },
        model: "qwen3.5",
      },
      {
        created_at: "2026-01-01T00:00:03Z",
        done: true,
        done_reason: "stop",
        eval_count: 5,
        message: { content: "", role: "assistant" },
        model: "qwen3.5",
        prompt_eval_count: 10,
      },
    ];

    const body = makeNdjsonBody(thinkingChunks);
    const fetchMock = vi.fn().mockResolvedValue({
      body,
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", contextWindow: 65_536, id: "qwen3.5", provider: "ollama" } as never,
      { messages: [{ content: "test", role: "user" }] } as never,
      {},
    );

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of stream as AsyncIterable<{ type: string; [key: string]: unknown }>) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    // Thinking_start comes before text_start
    const thinkingStartIndex = eventTypes.indexOf("thinking_start");
    const textStartIndex = eventTypes.indexOf("text_start");
    expect(thinkingStartIndex).toBeLessThan(textStartIndex);

    // Thinking_end comes before text_start
    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    expect(thinkingEndIndex).toBeLessThan(textStartIndex);

    // Thinking deltas have correct content
    const thinkingDeltas = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingDeltas).toHaveLength(2);
    expect(thinkingDeltas[0].delta).toBe("Step 1");
    expect(thinkingDeltas[1].delta).toBe(" and step 2");

    // Content index: thinking at 0, text at 1
    const thinkingStart = events.find((e) => e.type === "thinking_start");
    expect(thinkingStart?.contentIndex).toBe(0);
    const textStart = events.find((e) => e.type === "text_start");
    expect(textStart?.contentIndex).toBe(1);

    // Final message has thinking block
    const done = events.find((e) => e.type === "done") as { message?: { content: unknown[] } };
    const content = done?.message?.content ?? [];
    expect(content[0]).toMatchObject({ thinking: "Step 1 and step 2", type: "thinking" });
    expect(content[1]).toMatchObject({ text: "The answer", type: "text" });
  });

  it("streams without thinking events when no thinking content is present", async () => {
    const chunks = [
      {
        created_at: "2026-01-01T00:00:00Z",
        done: false,
        message: { content: "Hello", role: "assistant" },
        model: "qwen3.5",
      },
      {
        created_at: "2026-01-01T00:00:01Z",
        done: true,
        done_reason: "stop",
        eval_count: 5,
        message: { content: "", role: "assistant" },
        model: "qwen3.5",
        prompt_eval_count: 10,
      },
    ];

    const body = makeNdjsonBody(chunks);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ body, ok: true }));

    const streamFn = createOllamaStreamFn("http://localhost:11434");
    const stream = streamFn(
      { api: "ollama", contextWindow: 65_536, id: "qwen3.5", provider: "ollama" } as never,
      { messages: [{ content: "test", role: "user" }] } as never,
      {},
    );

    const events: { type: string }[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      events.push(event);
    }

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain("thinking_start");
    expect(eventTypes).not.toContain("thinking_delta");
    expect(eventTypes).not.toContain("thinking_end");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("done");

    // Text content index should be 0 (no thinking block)
    const textStart = events.find((e) => e.type === "text_start") as { contentIndex?: number };
    expect(textStart?.contentIndex).toBe(0);
  });
});
