import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

import {
  _setFalFetchGuardForTesting,
  buildFalImageGenerationProvider,
} from "./image-generation-provider.js";

function expectFalJsonPost(params: { call: number; url: string; body: Record<string, unknown> }) {
  const request = fetchWithSsrFGuardMock.mock.calls[params.call - 1]?.[0];
  expect(request).toBeTruthy();
  expect(request?.url).toBe(params.url);
  expect(request?.auditContext).toBe("fal-image-generate");
  expect(request?.init?.method).toBe("POST");
  const headers = new Headers(request?.init?.headers);
  expect(headers.get("authorization")).toBe("Key fal-test-key");
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(String(request?.init?.body))).toEqual(params.body);
}

describe("fal image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setFalFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("generates image buffers from the fal sync API", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    const releaseRequest = vi.fn(async () => {});
    const releaseDownload = vi.fn(async () => {});
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: releaseRequest,
        response: new Response(
          JSON.stringify({
            images: [
              {
                content_type: "image/png",
                url: "https://v3.fal.media/files/example/generated.png",
              },
            ],
            prompt: "draw a cat",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: releaseDownload,
        response: new Response(Buffer.from("png-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildFalImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      count: 2,
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      provider: "fal",
      size: "1536x1024",
    });

    expectFalJsonPost({
      body: {
        image_size: { height: 1024, width: 1536 },
        num_images: 2,
        output_format: "png",
        prompt: "draw a cat",
      },
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "fal-image-download",
        policy: undefined,
        url: "https://v3.fal.media/files/example/generated.png",
      }),
    );
    expect(releaseRequest).toHaveBeenCalledTimes(1);
    expect(releaseDownload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "image-1.png",
          mimeType: "image/png",
        },
      ],
      metadata: { prompt: "draw a cat" },
      model: "fal-ai/flux/dev",
    });
  });

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/edited.png" }],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("edited-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("source-image"),
          fileName: "source.jpg",
          mimeType: "image/jpeg",
        },
      ],
      model: "fal-ai/flux/dev",
      prompt: "turn this into a noir poster",
      provider: "fal",
      resolution: "2K",
    });

    expectFalJsonPost({
      body: {
        image_size: { height: 2048, width: 2048 },
        image_url: `data:image/jpeg;base64,${Buffer.from("source-image").toString("base64")}`,
        num_images: 1,
        output_format: "png",
        prompt: "turn this into a noir poster",
      },
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev/image-to-image",
    });
  });

  it("maps aspect ratio for text generation without forcing a square default", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/wide.png" }],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("wide-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      aspectRatio: "16:9",
      cfg: {},
      model: "fal-ai/flux/dev",
      prompt: "wide cinematic shot",
      provider: "fal",
    });

    expectFalJsonPost({
      body: {
        image_size: "landscape_16_9",
        num_images: 1,
        output_format: "png",
        prompt: "wide cinematic shot",
      },
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
    });
  });

  it("combines resolution and aspect ratio for text generation", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            images: [{ url: "https://v3.fal.media/files/example/portrait.png" }],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("portrait-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      aspectRatio: "9:16",
      cfg: {},
      model: "fal-ai/flux/dev",
      prompt: "portrait poster",
      provider: "fal",
      resolution: "2K",
    });

    expectFalJsonPost({
      body: {
        image_size: { height: 2048, width: 1152 },
        num_images: 1,
        output_format: "png",
        prompt: "portrait poster",
      },
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
    });
  });

  it("rejects multi-image edit requests for now", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        cfg: {},
        inputImages: [
          { buffer: Buffer.from("one"), mimeType: "image/png" },
          { buffer: Buffer.from("two"), mimeType: "image/png" },
        ],
        model: "fal-ai/flux/dev",
        prompt: "combine these",
        provider: "fal",
      }),
    ).rejects.toThrow("at most one reference image");
  });

  it("rejects aspect ratio overrides for the current edit endpoint", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        aspectRatio: "16:9",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("one"), mimeType: "image/png" }],
        model: "fal-ai/flux/dev",
        prompt: "make it widescreen",
        provider: "fal",
      }),
    ).rejects.toThrow("does not support aspectRatio overrides");
  });

  it("blocks private-network image download URLs through the SSRF guard", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    const blocked = new Error("Blocked: resolves to private/internal/special-use IP address");
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            images: [{ url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" }],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockRejectedValueOnce(blocked);

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        cfg: {},
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        provider: "fal",
      }),
    ).rejects.toThrow(blocked.message);

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "fal-image-download",
        policy: undefined,
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      }),
    );
  });

  it("does not auto-whitelist trusted private relay hosts from a configured baseUrl", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      mode: "api-key",
      source: "env",
    });
    _setFalFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            images: [{ url: "http://media.relay.internal/files/generated.png" }],
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("png-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      cfg: {
        models: {
          providers: {
            fal: {
              baseUrl: "http://relay.internal:8080",
              models: [],
            },
          },
        },
      },
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      provider: "fal",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        auditContext: "fal-image-generate",
        policy: undefined,
        url: "http://relay.internal:8080/fal-ai/flux/dev",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "fal-image-download",
        policy: undefined,
        url: "http://media.relay.internal/files/generated.png",
      }),
    );
  });
});
