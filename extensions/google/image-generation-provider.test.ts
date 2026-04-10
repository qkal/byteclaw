import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleImageGenerationProvider } from "./image-generation-provider.js";
import { __testing as geminiWebSearchTesting } from "./src/gemini-web-search-provider.js";

function mockGoogleApiKeyAuth() {
  vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "google-test-key",
    mode: "api-key",
    source: "env",
  });
}

function installGoogleFetchMock(params?: {
  data?: string;
  mimeType?: string;
  inlineDataKey?: "inlineData" | "inline_data";
}) {
  const mimeType = params?.mimeType ?? "image/png";
  const data = params?.data ?? "png-data";
  const inlineDataKey = params?.inlineDataKey ?? "inlineData";
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                [inlineDataKey]: {
                  [inlineDataKey === "inlineData" ? "mimeType" : "mime_type"]: mimeType,
                  data: Buffer.from(data).toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
    ok: true,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates image buffers from the Gemini generateContent API", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      mode: "api-key",
      source: "env",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: "generated" },
                {
                  inlineData: {
                    data: Buffer.from("png-data").toString("base64"),
                    mimeType: "image/png",
                  },
                },
              ],
            },
          },
        ],
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a cat",
      provider: "google",
      size: "1536x1024",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
      expect.objectContaining({
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: "draw a cat" }],
              role: "user",
            },
          ],
          generationConfig: {
            imageConfig: {
              aspectRatio: "3:2",
              imageSize: "2K",
            },
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
        method: "POST",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "image-1.png",
          mimeType: "image/png",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("accepts OAuth JSON auth and inline_data responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      mode: "token",
      source: "profile",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  inline_data: {
                    data: Buffer.from("jpg-data").toString("base64"),
                    mime_type: "image/jpeg",
                  },
                },
              ],
            },
          },
        ],
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildGoogleImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a dog",
      provider: "google",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          fileName: "image-1.jpg",
          mimeType: "image/jpeg",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
    });
  });

  it("sends reference images and explicit resolution for edit flows", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("reference-bytes"),
          fileName: "reference.png",
          mimeType: "image/png",
        },
      ],
      model: "gemini-3-pro-image-preview",
      prompt: "Change only the sky to a sunset.",
      provider: "google",
      resolution: "4K",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("reference-bytes").toString("base64"),
                  },
                },
                { text: "Change only the sky to a sunset." },
              ],
              role: "user",
            },
          ],
          generationConfig: {
            imageConfig: {
              imageSize: "4K",
            },
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
        method: "POST",
      }),
    );
  });

  it("forwards explicit aspect ratio without forcing a default when size is omitted", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      aspectRatio: "9:16",
      cfg: {},
      model: "gemini-3-pro-image-preview",
      prompt: "portrait photo",
      provider: "google",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.objectContaining({
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: "portrait photo" }],
              role: "user",
            },
          ],
          generationConfig: {
            imageConfig: {
              aspectRatio: "9:16",
            },
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
        method: "POST",
      }),
    );
  });

  it("disables DNS pinning for Google image generation requests", async () => {
    mockGoogleApiKeyAuth();
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest");

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      cfg: {},
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw a fox",
      provider: "google",
    });

    expect(postJsonRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
      }),
    );
  });

  it("normalizes a configured bare Google host to the v1beta API root", async () => {
    mockGoogleApiKeyAuth();
    const fetchMock = installGoogleFetchMock();

    const provider = buildGoogleImageGenerationProvider();
    await provider.generateImage({
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com",
              models: [],
            },
          },
        },
      },
      model: "gemini-3-pro-image-preview",
      prompt: "draw a cat",
      provider: "google",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent",
      expect.any(Object),
    );
  });

  it("prefers scoped configured Gemini API keys over environment fallbacks", () => {
    expect(
      geminiWebSearchTesting.resolveGeminiApiKey({
        apiKey: "gemini-secret",
      }),
    ).toBe("gemini-secret");
  });

  it("falls back to the default Gemini model when unset or blank", () => {
    expect(geminiWebSearchTesting.resolveGeminiModel()).toBe("gemini-2.5-flash");
    expect(geminiWebSearchTesting.resolveGeminiModel({ model: "  " })).toBe("gemini-2.5-flash");
    expect(geminiWebSearchTesting.resolveGeminiModel({ model: "gemini-2.5-pro" })).toBe(
      "gemini-2.5-pro",
    );
  });
});
