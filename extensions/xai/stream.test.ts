import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createXaiFastModeWrapper,
  createXaiToolPayloadCompatibilityWrapper,
  wrapXaiProviderStream,
} from "./stream.js";

interface ToolPayload {
  function?: Record<string, unknown>;
}
type XaiTestPayload = Record<string, unknown> & {
  tools?: { type?: string; function?: Record<string, unknown> }[];
  input?: unknown[];
};
type XaiStreamApi = Extract<Api, "openai-completions" | "openai-responses">;

function captureWrappedModelId(params: {
  modelId: string;
  fastMode: boolean;
  api?: XaiStreamApi;
}): string {
  let capturedModelId = "";
  const baseStreamFn: StreamFn = (model) => {
    capturedModelId = model.id;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createXaiFastModeWrapper(baseStreamFn, params.fastMode);
  void wrapped(
    {
      api: params.api ?? "openai-responses",
      id: params.modelId,
      provider: "xai",
    } as Model<Extract<Api, "openai-completions" | "openai-responses">>,
    { messages: [] } as Context,
    {},
  );

  return capturedModelId;
}

function runXaiToolPayloadWrapper(params: {
  payload: Record<string, unknown>;
  api?: XaiStreamApi;
  modelId?: string;
  input?: string[];
}) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(params.payload, {} as Model<XaiStreamApi>);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createXaiToolPayloadCompatibilityWrapper(baseStreamFn);
  const api = params.api ?? "openai-responses";

  void wrapped(
    {
      api,
      id:
        params.modelId ??
        (api === "openai-completions" ? "grok-4-1-fast-reasoning" : "grok-4-fast"),
      provider: "xai",
      ...(params.input ? { input: params.input } : {}),
    } as Model<XaiStreamApi>,
    { messages: [] } as Context,
    {},
  );
}

describe("xai stream wrappers", () => {
  it("rewrites supported Grok models to fast variants when fast mode is enabled", () => {
    expect(captureWrappedModelId({ fastMode: true, modelId: "grok-3" })).toBe("grok-3-fast");
    expect(
      captureWrappedModelId({
        api: "openai-completions",
        fastMode: true,
        modelId: "grok-3",
      }),
    ).toBe("grok-3-fast");
    expect(captureWrappedModelId({ fastMode: true, modelId: "grok-4" })).toBe("grok-4-fast");
    expect(
      captureWrappedModelId({
        api: "openai-responses",
        fastMode: true,
        modelId: "grok-3",
      }),
    ).toBe("grok-3-fast");
  });

  it("leaves unsupported or disabled models unchanged", () => {
    expect(captureWrappedModelId({ fastMode: true, modelId: "grok-3-fast" })).toBe("grok-3-fast");
    expect(captureWrappedModelId({ fastMode: false, modelId: "grok-3" })).toBe("grok-3");
  });

  it("composes the xai provider stream chain from extra params", () => {
    let capturedModelId = "";
    let capturedPayload: XaiTestPayload | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = String(model.id);
      const payload: XaiTestPayload = {
        reasoning: { effort: "high" },
        tools: [
          {
            function: {
              name: "write",
              parameters: { properties: {}, type: "object" },
              strict: true,
            },
            type: "function",
          },
        ],
      };
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {
        result: async () => ({}) as never,
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };

    const wrapped = wrapXaiProviderStream({
      extraParams: { fastMode: true },
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-responses",
        id: "grok-4",
        provider: "xai",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedModelId).toBe("grok-4-fast");
    expect(capturedPayload).toMatchObject({ tool_stream: true });
    expect(capturedPayload).not.toHaveProperty("reasoning");
    const payloadTools = capturedPayload?.tools as ToolPayload[] | undefined;
    expect(payloadTools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("strips unsupported strict and reasoning controls from tool payloads", () => {
    const payload = {
      reasoning: "high",
      reasoningEffort: "high",
      reasoning_effort: "high",
      tools: [
        {
          function: {
            name: "write",
            parameters: { properties: {}, type: "object" },
            strict: true,
          },
          type: "function",
        },
      ],
    };
    runXaiToolPayloadWrapper({ api: "openai-completions", payload });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });

  it("strips unsupported reasoning controls from xai payloads", () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: "high" },
      reasoningEffort: "high",
      reasoning_effort: "high",
    };
    runXaiToolPayloadWrapper({ payload });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("moves image-bearing tool results out of function_call_output payloads", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          call_id: "call_1",
          output: [
            { text: "Read image", type: "input_text" },
            {
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
              type: "input_image",
            },
          ],
          type: "function_call_output",
        },
      ],
    };
    runXaiToolPayloadWrapper({ input: ["text", "image"], payload });

    expect(payload.input).toEqual([
      {
        call_id: "call_1",
        output: "Read image",
        type: "function_call_output",
      },
      {
        content: [
          { text: "Attached image(s) from tool result:", type: "input_text" },
          {
            detail: "auto",
            image_url: "data:image/png;base64,QUJDRA==",
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ]);
  });

  it("replays source-based input_image parts from tool results", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          call_id: "call_1",
          output: [
            { text: "Read image", type: "input_text" },
            {
              source: {
                data: "QUJDRA==",
                media_type: "image/png",
                type: "base64",
              },
              type: "input_image",
            },
          ],
          type: "function_call_output",
        },
      ],
    };
    runXaiToolPayloadWrapper({ input: ["text", "image"], payload });

    expect(payload.input).toEqual([
      {
        call_id: "call_1",
        output: "Read image",
        type: "function_call_output",
      },
      {
        content: [
          { text: "Attached image(s) from tool result:", type: "input_text" },
          {
            source: {
              data: "QUJDRA==",
              media_type: "image/png",
              type: "base64",
            },
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ]);
  });

  it("keeps multiple tool outputs contiguous before replaying collected images", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          call_id: "call_1",
          output: [
            { text: "first", type: "input_text" },
            {
              detail: "auto",
              image_url: "data:image/png;base64,QUFBQQ==",
              type: "input_image",
            },
          ],
          type: "function_call_output",
        },
        {
          call_id: "call_2",
          output: [
            { text: "second", type: "input_text" },
            {
              detail: "auto",
              image_url: "data:image/png;base64,QkJCQg==",
              type: "input_image",
            },
          ],
          type: "function_call_output",
        },
      ],
    };
    runXaiToolPayloadWrapper({ input: ["text", "image"], payload });

    expect(payload.input).toEqual([
      {
        call_id: "call_1",
        output: "first",
        type: "function_call_output",
      },
      {
        call_id: "call_2",
        output: "second",
        type: "function_call_output",
      },
      {
        content: [
          { text: "Attached image(s) from tool result:", type: "input_text" },
          {
            detail: "auto",
            image_url: "data:image/png;base64,QUFBQQ==",
            type: "input_image",
          },
          {
            detail: "auto",
            image_url: "data:image/png;base64,QkJCQg==",
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ]);
  });

  it("drops image blocks and uses fallback text for models without image input", () => {
    const payload: Record<string, unknown> = {
      input: [
        {
          call_id: "call_1",
          output: [
            {
              detail: "auto",
              image_url: "data:image/png;base64,QUJDRA==",
              type: "input_image",
            },
          ],
          type: "function_call_output",
        },
      ],
    };
    runXaiToolPayloadWrapper({ input: ["text"], payload });

    expect(payload.input).toEqual([
      {
        call_id: "call_1",
        output: "(see attached image)",
        type: "function_call_output",
      },
    ]);
  });
});
