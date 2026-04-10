import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openai-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    dispatcherPolicy: undefined,
    headers: new Headers(params.defaultHeaders),
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

describe("openai image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("does not auto-allow local baseUrl overrides for image requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
      },
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
      model: "gpt-image-1",
      prompt: "Draw a QA lighthouse",
      provider: "openai",
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:44080/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: false,
        url: "http://127.0.0.1:44080/v1/images/generations",
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("allows loopback image requests for the synthetic mock-openai provider", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
      },
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
      model: "gpt-image-1",
      prompt: "Draw a QA lighthouse",
      provider: "mock-openai",
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
        url: "http://127.0.0.1:44080/v1/images/generations",
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("allows loopback image requests for openai only inside the QA harness envelope", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
      },
    });
    vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
      model: "gpt-image-1",
      prompt: "Draw a QA lighthouse",
      provider: "openai",
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(result.images).toHaveLength(1);
  });

  it("uses JSON image_url edits for input-image requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      release: vi.fn(async () => {}),
      response: {
        json: async () => ({
          data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
        }),
      },
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("png-bytes"),
          fileName: "reference.png",
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-1",
      prompt: "Change only the background to pale blue",
      provider: "openai",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          images: [
            {
              image_url: "data:image/png;base64,cG5nLWJ5dGVz",
            },
          ],
          model: "gpt-image-1",
          prompt: "Change only the background to pale blue",
        }),
        url: "https://api.openai.com/v1/images/edits",
      }),
    );
    expect(result.images).toHaveLength(1);
  });
});
