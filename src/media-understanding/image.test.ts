import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  fetchMock: vi.fn(),
  getApiKeyForModelMock: vi.fn(async () => ({
    apiKey: "oauth-test", // Pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "oauth-test", // Pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  setRuntimeApiKeyMock: vi.fn(),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
} = hoisted;

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: getApiKeyForModelMock,
  requireApiKey: requireApiKeyMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("../agents/pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: () => ({
    setRuntimeApiKey: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => ({
        base_resp: { status_code: 0 },
        content: "portal ok",
      })),
      ok: true,
      status: 200,
      statusText: "OK",
      text: vi.fn(async () => ""),
    });
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        baseUrl: "https://api.minimax.io/anthropic",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        provider: "minimax-portal",
      })),
    });
  });

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const result = await describeImageWithModel({
      agentDir: "/tmp/openclaw-agent",
      buffer: Buffer.from("png-bytes"),
      cfg: {},
      fileName: "image.png",
      mime: "image/png",
      model: "MiniMax-VL-01",
      prompt: "Describe the image.",
      provider: "minimax-portal",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      model: "MiniMax-VL-01",
      text: "portal ok",
    });
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalled();
    expect(getApiKeyForModelMock).toHaveBeenCalled();
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/coding_plan/vlm",
      expect.objectContaining({
        body: JSON.stringify({
          image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
          prompt: "Describe the image.",
        }),
        headers: {
          Authorization: "Bearer oauth-test",
          "Content-Type": "application/json",
          "MM-API-Source": "OpenClaw",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        baseUrl: "https://api.minimax.io/anthropic",
        id: "custom-vision",
        input: ["text", "image"],
        provider: "minimax-portal",
      })),
    });
    completeMock.mockResolvedValue({
      api: "anthropic-messages",
      content: [{ text: "generic ok", type: "text" }],
      model: "custom-vision",
      provider: "minimax-portal",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await describeImageWithModel({
      agentDir: "/tmp/openclaw-agent",
      buffer: Buffer.from("png-bytes"),
      cfg: {},
      fileName: "image.png",
      mime: "image/png",
      model: "custom-vision",
      prompt: "Describe the image.",
      provider: "minimax-portal",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      model: "custom-vision",
      text: "generic ok",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes image prompt as system instructions for codex image requests", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        input: ["text", "image"],
        provider: "openai-codex",
      })),
    });
    completeMock.mockResolvedValue({
      api: "openai-codex-responses",
      content: [{ text: "codex ok", type: "text" }],
      model: "gpt-5.4",
      provider: "openai-codex",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await describeImageWithModel({
      agentDir: "/tmp/openclaw-agent",
      buffer: Buffer.from("png-bytes"),
      cfg: {},
      fileName: "image.png",
      mime: "image/png",
      model: "gpt-5.4",
      prompt: "Describe the image.",
      provider: "openai-codex",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      model: "gpt-5.4",
      text: "codex ok",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gpt-5.4",
        provider: "openai-codex",
      }),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({
                type: "image",
                mimeType: "image/png",
              }),
            ],
            role: "user",
          }),
        ],
        systemPrompt: "Describe the image.",
      }),
      expect.any(Object),
    );
    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.messages?.[0]?.content).toHaveLength(1);
  });

  it("normalizes deprecated google flash ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        provider: "google",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      api: "google-generative-ai",
      content: [{ text: "flash ok", type: "text" }],
      model: "gemini-3-flash-preview",
      provider: "google",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await describeImageWithModel({
      agentDir: "/tmp/openclaw-agent",
      buffer: Buffer.from("png-bytes"),
      cfg: {},
      fileName: "image.png",
      mime: "image/png",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      prompt: "Describe the image.",
      provider: "google",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      model: "gemini-3-flash-preview",
      text: "flash ok",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("normalizes gemini 3.1 flash-lite ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite-preview");
      return {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        id: "gemini-3.1-flash-lite-preview",
        input: ["text", "image"],
        provider: "google",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      api: "google-generative-ai",
      content: [{ text: "flash lite ok", type: "text" }],
      model: "gemini-3.1-flash-lite-preview",
      provider: "google",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const result = await describeImageWithModel({
      agentDir: "/tmp/openclaw-agent",
      buffer: Buffer.from("png-bytes"),
      cfg: {},
      fileName: "image.png",
      mime: "image/png",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      prompt: "Describe the image.",
      provider: "google",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      model: "gemini-3.1-flash-lite-preview",
      text: "flash lite ok",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });
});
