import { afterEach, describe, expect, it, vi } from "vitest";
import { elevenLabsTTS } from "./tts.js";

describe("elevenlabs tts diagnostics", () => {
  const originalFetch = globalThis.fetch;

  function createStreamingErrorResponse(params: {
    status: number;
    chunkCount: number;
    chunkSize: number;
    byte: number;
  }): { response: Response; getReadCount: () => number } {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads >= params.chunkCount) {
          controller.close();
          return;
        }
        reads += 1;
        controller.enqueue(new Uint8Array(params.chunkSize).fill(params.byte));
      },
    });
    return {
      getReadCount: () => reads,
      response: new Response(stream, { status: params.status }),
    };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              message: "Quota exceeded",
              status: "quota_exceeded",
            },
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "el_req_456",
            },
            status: 429,
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        apiKey: "test-key",
        baseUrl: "https://api.elevenlabs.io",
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        text: "hello",
        timeoutMs: 5000,
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        voiceSettings: {
          similarityBoost: 0.75,
          speed: 1,
          stability: 0.5,
          style: 0,
          useSpeakerBoost: true,
        },
      }),
    ).rejects.toThrow(
      "ElevenLabs API error (429): Quota exceeded [code=quota_exceeded] [request_id=el_req_456]",
    );
  });

  it("falls back to raw body text when the error body is non-JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("service unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        apiKey: "test-key",
        baseUrl: "https://api.elevenlabs.io",
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        text: "hello",
        timeoutMs: 5000,
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        voiceSettings: {
          similarityBoost: 0.75,
          speed: 1,
          stability: 0.5,
          style: 0,
          useSpeakerBoost: true,
        },
      }),
    ).rejects.toThrow("ElevenLabs API error (503): service unavailable");
  });

  it("caps streamed non-JSON error reads instead of consuming full response bodies", async () => {
    const streamed = createStreamingErrorResponse({
      byte: 121,
      chunkCount: 200,
      chunkSize: 1024,
      status: 503,
    });
    const fetchMock = vi.fn(async () => streamed.response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      elevenLabsTTS({
        apiKey: "test-key",
        baseUrl: "https://api.elevenlabs.io",
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        text: "hello",
        timeoutMs: 5000,
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        voiceSettings: {
          similarityBoost: 0.75,
          speed: 1,
          stability: 0.5,
          style: 0,
          useSpeakerBoost: true,
        },
      }),
    ).rejects.toThrow("ElevenLabs API error (503)");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });
});
