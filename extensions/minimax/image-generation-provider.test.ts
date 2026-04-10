import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMinimaxImageGenerationProvider } from "./image-generation-provider.js";

describe("minimax image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers through the shared provider HTTP path", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "minimax-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: {
            image_base64: [Buffer.from("png-data").toString("base64")],
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildMinimaxImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      model: "image-01",
      prompt: "draw a cat",
      provider: "minimax",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/image_generation",
      expect.objectContaining({
        body: JSON.stringify({
          model: "image-01",
          n: 1,
          prompt: "draw a cat",
          response_format: "base64",
        }),
        method: "POST",
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer minimax-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "image-1.png",
          mimeType: "image/png",
        },
      ],
      model: "image-01",
    });
  });

  it("uses the configured provider base URL origin", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "minimax-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          data: {
            image_base64: [Buffer.from("png-data").toString("base64")],
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildMinimaxImageGenerationProvider();
    await provider.generateImage({
      cfg: {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              models: [],
            },
          },
        },
      },
      model: "image-01",
      prompt: "draw a cat",
      provider: "minimax",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/image_generation",
      expect.any(Object),
    );
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "minimax-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildMinimaxImageGenerationProvider();
    await expect(
      provider.generateImage({
        cfg: {
          models: {
            providers: {
              minimax: {
                baseUrl: "http://127.0.0.1:8080/anthropic",
                models: [],
              },
            },
          },
        },
        model: "image-01",
        prompt: "draw a cat",
        provider: "minimax",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
