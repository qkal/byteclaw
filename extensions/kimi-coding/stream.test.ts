import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createKimiToolCallMarkupWrapper, wrapKimiProviderStream } from "./stream.js";

interface FakeStream {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

const KIMI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MULTI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_call_begin|> functions.write:1 <|tool_call_argument_begin|> {"file_path":"./out.txt","content":"done"} <|tool_call_end|> <|tool_calls_section_end|>';

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial = {
      content: [{ text: KIMI_TOOL_TEXT, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const message = {
      content: [{ text: KIMI_TOOL_TEXT, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const finalMessage = {
      content: [
        { thinking: "Need to read the file first.", type: "thinking" },
        { text: KIMI_TOOL_TEXT, type: "text" },
      ],
      role: "assistant",
      stopReason: "stop",
    };

    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [{ message, partial, type: "message_end" }],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", id: "k2p5", provider: "kimi" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = (await stream.result()) as {
      content: unknown[];
      stopReason: string;
    };

    expect(events).toEqual([
      {
        message: {
          content: [
            {
              arguments: { file_path: "./package.json" },
              id: "functions.read:0",
              name: "functions.read",
              type: "toolCall",
            },
          ],
          role: "assistant",
          stopReason: "toolUse",
        },
        partial: {
          content: [
            {
              arguments: { file_path: "./package.json" },
              id: "functions.read:0",
              name: "functions.read",
              type: "toolCall",
            },
          ],
          role: "assistant",
          stopReason: "toolUse",
        },
        type: "message_end",
      },
    ]);
    expect(result).toEqual({
      content: [
        { thinking: "Need to read the file first.", type: "thinking" },
        {
          arguments: { file_path: "./package.json" },
          id: "functions.read:0",
          name: "functions.read",
          type: "toolCall",
        },
      ],
      role: "assistant",
      stopReason: "toolUse",
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = {
      content: [{ text: "normal response", type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", id: "k2p5", provider: "kimi" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("supports async stream functions", async () => {
    const finalMessage = {
      content: [{ text: KIMI_TOOL_TEXT, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = (await wrapped(
      { api: "anthropic-messages", id: "k2p5", provider: "kimi" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    )) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      content: [
        {
          arguments: { file_path: "./package.json" },
          id: "functions.read:0",
          name: "functions.read",
          type: "toolCall",
        },
      ],
      role: "assistant",
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = {
      content: [{ text: KIMI_MULTI_TOOL_TEXT, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = createKimiToolCallMarkupWrapper(baseStreamFn);
    const stream = wrapped(
      { api: "anthropic-messages", id: "k2p5", provider: "kimi" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      content: [
        {
          arguments: { file_path: "./package.json" },
          id: "functions.read:0",
          name: "functions.read",
          type: "toolCall",
        },
        {
          arguments: { content: "done", file_path: "./out.txt" },
          id: "functions.write:1",
          name: "functions.write",
          type: "toolCall",
        },
      ],
      role: "assistant",
      stopReason: "toolUse",
    });
  });

  it("adapts provider stream context without changing wrapper behavior", async () => {
    const finalMessage = {
      content: [{ text: KIMI_TOOL_TEXT, type: "text" }],
      role: "assistant",
      stopReason: "stop",
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }) as ReturnType<StreamFn>;

    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    const stream = wrapped(
      { api: "anthropic-messages", id: "k2p5", provider: "kimi" } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    ) as FakeStream;

    await expect(stream.result()).resolves.toEqual({
      content: [
        {
          arguments: { file_path: "./package.json" },
          id: "functions.read:0",
          name: "functions.read",
          type: "toolCall",
        },
      ],
      role: "assistant",
      stopReason: "toolUse",
    });
  });
});
