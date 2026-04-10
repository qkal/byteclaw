import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraImageGenerationProvider } from "./image-generation-provider.js";

describe("vydra image-generation provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the www api and downloads the generated image", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            imageUrl: "https://cdn.vydra.ai/generated/test.png",
            jobId: "job-123",
            status: "completed",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png-data"), {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      model: "grok-imagine",
      prompt: "draw a cat",
      provider: "vydra",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/grok-imagine",
      expect.objectContaining({
        body: JSON.stringify({
          model: "text-to-image",
          prompt: "draw a cat",
        }),
        method: "POST",
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "image-1.png",
          mimeType: "image/png",
        },
      ],
      metadata: {
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
        jobId: "job-123",
        status: "completed",
      },
      model: "grok-imagine",
    });
  });

  it("polls jobs when the create response is not completed yet", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-456", status: "queued" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-456",
            resultUrls: ["https://cdn.vydra.ai/generated/polled.png"],
            status: "completed",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png-data"), {
          headers: { "Content-Type": "image/png" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraImageGenerationProvider();
    await provider.generateImage({
      cfg: {},
      model: "grok-imagine",
      prompt: "draw a cat",
      provider: "vydra",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.vydra.ai/api/v1/jobs/job-456",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
