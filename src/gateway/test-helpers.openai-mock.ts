interface OpenAIResponsesParams {
  input?: unknown[];
}

type OpenAIResponseStreamEvent =
  | { type: "response.output_item.added"; item: Record<string, unknown> }
  | { type: "response.function_call_arguments.delta"; delta: string }
  | { type: "response.output_item.done"; item: Record<string, unknown> }
  | {
      type: "response.completed";
      response: {
        status: "completed";
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    };

function extractLastUserText(input: unknown[]): string {
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as Record<string, unknown> | undefined;
    if (!item || item.role !== "user") {
      continue;
    }
    const { content } = item;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (c): c is { type: "input_text"; text: string } =>
            Boolean(c) &&
            typeof c === "object" &&
            (c as { type?: unknown }).type === "input_text" &&
            typeof (c as { text?: unknown }).text === "string",
        )
        .map((c) => c.text)
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function extractToolOutput(input: unknown[]): string {
  for (const itemRaw of input) {
    const item = itemRaw as Record<string, unknown> | undefined;
    if (!item || item.type !== "function_call_output") {
      continue;
    }
    return typeof item.output === "string" ? item.output : "";
  }
  return "";
}

async function* fakeOpenAIResponsesStream(
  params: OpenAIResponsesParams,
): AsyncGenerator<OpenAIResponseStreamEvent> {
  const input = Array.isArray(params.input) ? params.input : [];
  const toolOutput = extractToolOutput(input);

  if (!toolOutput) {
    const prompt = extractLastUserText(input);
    const quoted = /"([^"]+)"/.exec(prompt)?.[1];
    const toolPath = quoted ?? "package.json";
    const argsJson = JSON.stringify({ path: toolPath });

    yield {
      item: {
        arguments: "",
        call_id: "call_test_1",
        id: "fc_test_1",
        name: "read",
        type: "function_call",
      },
      type: "response.output_item.added",
    };
    yield { delta: argsJson, type: "response.function_call_arguments.delta" };
    yield {
      item: {
        arguments: argsJson,
        call_id: "call_test_1",
        id: "fc_test_1",
        name: "read",
        type: "function_call",
      },
      type: "response.output_item.done",
    };
    yield {
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
      type: "response.completed",
    };
    return;
  }

  const nonceA = /nonceA=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const nonceB = /nonceB=([^\s]+)/.exec(toolOutput)?.[1] ?? "";
  const reply = `${nonceA} ${nonceB}`.trim();

  yield {
    item: {
      content: [],
      id: "msg_test_1",
      role: "assistant",
      status: "in_progress",
      type: "message",
    },
    type: "response.output_item.added",
  };
  yield {
    item: {
      content: [{ annotations: [], text: reply, type: "output_text" }],
      id: "msg_test_1",
      role: "assistant",
      status: "completed",
      type: "message",
    },
    type: "response.output_item.done",
  };
  yield {
    response: {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
    type: "response.completed",
  };
}

function decodeBodyText(body: unknown): string {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body)).toString("utf8");
  }
  return "";
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

export function buildOpenAIResponsesTextSse(text: string): Response {
  return buildSseResponse([
    {
      item: {
        content: [],
        id: "msg_test_1",
        role: "assistant",
        status: "in_progress",
        type: "message",
      },
      type: "response.output_item.added",
    },
    {
      item: {
        content: [{ annotations: [], text, type: "output_text" }],
        id: "msg_test_1",
        role: "assistant",
        status: "completed",
        type: "message",
      },
      type: "response.output_item.done",
    },
    {
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
      type: "response.completed",
    },
  ]);
}

async function buildOpenAIResponsesSse(params: OpenAIResponsesParams): Promise<Response> {
  const events: OpenAIResponseStreamEvent[] = [];
  for await (const event of fakeOpenAIResponsesStream(params)) {
    events.push(event);
  }
  return buildSseResponse(events);
}

export function installOpenAiResponsesMock(params?: { baseUrl?: string }) {
  const originalFetch = globalThis.fetch;
  const baseUrl = params?.baseUrl ?? "https://api.openai.com/v1";
  const responsesUrl = `${baseUrl}/responses`;
  const isResponsesRequest = (url: string) =>
    url === responsesUrl ||
    url.startsWith(`${responsesUrl}/`) ||
    url.startsWith(`${responsesUrl}?`);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (isResponsesRequest(url)) {
      const bodyText =
        typeof (init as { body?: unknown } | undefined)?.body !== "undefined"
          ? decodeBodyText((init as { body?: unknown }).body)
          : input instanceof Request
            ? await input.clone().text()
            : "";

      const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const inputItems = Array.isArray(parsed.input) ? parsed.input : [];
      return await buildOpenAIResponsesSse({ input: inputItems });
    }
    if (url.startsWith(baseUrl)) {
      throw new Error(`unexpected OpenAI request in mock test: ${url}`);
    }

    if (!originalFetch) {
      throw new Error(`fetch is not available (url=${url})`);
    }
    return await originalFetch(input, init);
  };
  (globalThis as unknown as { fetch: unknown }).fetch = fetchImpl;
  return {
    baseUrl,
    restore: () => {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    },
  };
}
