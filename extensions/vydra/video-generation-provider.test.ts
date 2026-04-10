import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraVideoGenerationProvider } from "./video-generation-provider.js";

describe("vydra video-generation provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits veo3 jobs and downloads the completed video", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-123", status: "processing" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-123",
            status: "completed",
            videoUrl: "https://cdn.vydra.ai/generated/test.mp4",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("mp4-data"), {
          headers: { "Content-Type": "video/mp4" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      model: "veo3",
      prompt: "tiny city at sunrise",
      provider: "vydra",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/veo3",
      expect.objectContaining({
        body: JSON.stringify({ prompt: "tiny city at sunrise" }),
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.vydra.ai/api/v1/jobs/job-123",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-123",
      status: "completed",
      videoUrl: "https://cdn.vydra.ai/generated/test.mp4",
    });
  });

  it("requires a remote image url for kling", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      mode: "api-key",
      source: "env",
    });
    vi.stubGlobal("fetch", vi.fn());

    const provider = buildVydraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png"), mimeType: "image/png" }],
        model: "kling",
        prompt: "animate this image",
        provider: "vydra",
      }),
    ).rejects.toThrow("Vydra kling currently requires a remote image URL reference.");
  });

  it("submits kling jobs with a remote image url", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-kling", status: "processing" }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-kling",
            status: "completed",
            videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("mp4-data"), {
          headers: { "Content-Type": "video/mp4" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: {},
      inputImages: [{ url: "https://example.com/reference.png" }],
      model: "kling",
      prompt: "animate this image",
      provider: "vydra",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/kling",
      expect.objectContaining({
        body: JSON.stringify({
          image_url: "https://example.com/reference.png",
          prompt: "animate this image",
          video_url: "https://example.com/reference.png",
        }),
        method: "POST",
      }),
    );
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual({
      jobId: "job-kling",
      status: "completed",
      videoUrl: "https://cdn.vydra.ai/generated/kling.mp4",
    });
  });
});
