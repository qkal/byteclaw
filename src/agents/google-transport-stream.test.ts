import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let buildGoogleGenerativeAiParams: typeof import("./google-transport-stream.js").buildGoogleGenerativeAiParams;
let createGoogleGenerativeAiTransportStreamFn: typeof import("./google-transport-stream.js").createGoogleGenerativeAiTransportStreamFn;

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
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

describe("google transport stream", () => {
  beforeAll(async () => {
    ({ buildGoogleGenerativeAiParams, createGoogleGenerativeAiTransportStreamFn } =
      await import("./google-transport-stream.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
  });

  it("uses the guarded fetch transport and parses Gemini SSE output", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "draft", thought: true, thoughtSignature: "sig_1" },
                  { text: "answer" },
                  { functionCall: { args: { q: "hello" }, name: "lookup" } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          responseId: "resp_1",
          usageMetadata: {
            cachedContentTokenCount: 2,
            candidatesTokenCount: 5,
            promptTokenCount: 10,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        },
      ]),
    );

    const model = attachModelProviderRequestTransport(
      {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        headers: { "X-Provider": "google" },
        id: "gemini-3.1-pro-preview",
        input: ["text"],
        maxTokens: 8192,
        name: "Gemini 3.1 Pro Preview",
        provider: "google",
        reasoning: true,
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ content: "hello", role: "user", timestamp: 0 }],
          systemPrompt: "Follow policy.",
          tools: [
            {
              description: "Look up a value",
              name: "lookup",
              parameters: {
                properties: { q: { type: "string" } },
                required: ["q"],
                type: "object",
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "gemini-api-key",
          cachedContent: "cachedContents/request-cache",
          reasoning: "medium",
          toolChoice: "auto",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Provider": "google",
          accept: "text/event-stream",
          "x-goog-api-key": "gemini-api-key",
        }),
        method: "POST",
      }),
    );

    const init = guardedFetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = init.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected Google transport request body to be serialized JSON");
    }
    const payload = JSON.parse(requestBody) as Record<string, unknown>;
    expect(payload.systemInstruction).toEqual({
      parts: [{ text: "Follow policy." }],
    });
    expect(payload.cachedContent).toBe("cachedContents/request-cache");
    expect(payload.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    });
    expect(payload.toolConfig).toMatchObject({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(result).toMatchObject({
      api: "google-generative-ai",
      content: [
        { thinking: "draft", thinkingSignature: "sig_1", type: "thinking" },
        { text: "answer", type: "text" },
        { arguments: { q: "hello" }, name: "lookup", type: "toolCall" },
      ],
      provider: "google",
      responseId: "resp_1",
      stopReason: "toolUse",
      usage: {
        cacheRead: 2,
        input: 8,
        output: 8,
        totalTokens: 18,
      },
    });
  });

  it("uses bearer auth when the Google api key is an OAuth JSON payload", async () => {
    guardedFetchMock.mockResolvedValueOnce(buildSseResponse([]));

    const model = attachModelProviderRequestTransport(
      {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gemini-3-flash-preview",
        input: ["text"],
        maxTokens: 8192,
        name: "Gemini 3 Flash Preview",
        provider: "custom-google",
        reasoning: false,
      } satisfies Model<"google-generative-ai">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ content: "hello", role: "user", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: JSON.stringify({ projectId: "demo", token: "oauth-token" }),
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(guardedFetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("builds direct Gemini payloads without negative fallback thinking budgets", () => {
    const model = {
      api: "google-generative-ai",
      baseUrl: "https://proxy.example.com/gemini/v1beta",
      contextWindow: 128_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "custom-gemini-model",
      input: ["text"],
      maxTokens: 8192,
      name: "Custom Gemini",
      provider: "custom-google",
      reasoning: true,
    } satisfies Model<"google-generative-ai">;

    const params = buildGoogleGenerativeAiParams(
      model,
      {
        messages: [{ content: "hello", role: "user", timestamp: 0 }],
      } as never,
      {
        reasoning: "medium",
      },
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: -1 },
    });
  });

  it("includes cachedContent in direct Gemini payloads when requested", () => {
    const model = {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      contextWindow: 128_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: "gemini-2.5-pro",
      input: ["text"],
      maxTokens: 8192,
      name: "Gemini 2.5 Pro",
      provider: "google",
      reasoning: true,
    } satisfies Model<"google-generative-ai">;

    const params = buildGoogleGenerativeAiParams(
      model,
      {
        messages: [{ content: "hello", role: "user", timestamp: 0 }],
      } as never,
      {
        cachedContent: "cachedContents/prebuilt-context",
      },
    );

    expect(params.cachedContent).toBe("cachedContents/prebuilt-context");
  });
});
