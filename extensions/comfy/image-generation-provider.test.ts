import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setComfyFetchGuardForTesting,
  buildComfyImageGenerationProvider,
} from "./image-generation-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

function parseJsonBody(call: number): Record<string, unknown> {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0];
  expect(request?.init?.body).toBeTruthy();
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function buildComfyConfig(config: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        comfy: config,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("comfy image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setComfyFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("treats local comfy workflows as configured without an API key", () => {
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          promptNodeId: "6",
          workflow: {
            "6": { inputs: { text: "" } },
          },
        }),
      }),
    ).toBe(true);
  });

  it("submits a local workflow, waits for history, and downloads images", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "local-prompt-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            "local-prompt-1": {
              outputs: {
                "9": {
                  images: [{ filename: "generated.png", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
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

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: buildComfyConfig({
        outputNodeId: "9",
        promptNodeId: "6",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
      }),
      model: "workflow",
      prompt: "draw a lobster",
      provider: "comfy",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        auditContext: "comfy-image-generate",
        url: "http://127.0.0.1:8188/prompt",
      }),
    );
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "draw a lobster" } },
        "9": { inputs: {} },
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "comfy-history",
        url: "http://127.0.0.1:8188/history/local-prompt-1",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        auditContext: "comfy-image-download",
        url: "http://127.0.0.1:8188/view?filename=generated.png&subfolder=&type=output",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          fileName: "generated.png",
          metadata: {
            nodeId: "9",
            promptId: "local-prompt-1",
          },
          mimeType: "image/png",
        },
      ],
      metadata: {
        outputNodeIds: ["9"],
        promptId: "local-prompt-1",
      },
      model: "workflow",
    });
  });

  it("uploads reference images for local edit workflows", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ name: "upload.png" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "local-edit-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            "local-edit-1": {
              outputs: {
                "9": {
                  images: [{ filename: "edited.png", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
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

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      cfg: buildComfyConfig({
        inputImageNodeId: "7",
        outputNodeId: "9",
        promptNodeId: "6",
        workflow: {
          "6": { inputs: { text: "" } },
          "7": { inputs: { image: "" } },
          "9": { inputs: {} },
        },
      }),
      inputImages: [
        {
          buffer: Buffer.from("source"),
          fileName: "source.png",
          mimeType: "image/png",
        },
      ],
      model: "workflow",
      prompt: "turn this into a poster",
      provider: "comfy",
    });

    const uploadRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(uploadRequest?.url).toBe("http://127.0.0.1:8188/upload/image");
    expect(uploadRequest?.auditContext).toBe("comfy-image-upload");
    expect(uploadRequest?.init?.method).toBe("POST");
    const uploadForm = uploadRequest?.init?.body;
    expect(uploadForm).toBeInstanceOf(FormData);
    expect(uploadForm?.get("type")).toBe("input");
    expect(uploadForm?.get("overwrite")).toBe("true");

    expect(parseJsonBody(2)).toEqual({
      prompt: {
        "6": { inputs: { text: "turn this into a poster" } },
        "7": { inputs: { image: "upload.png" } },
        "9": { inputs: {} },
      },
    });
  });

  it("uses cloud endpoints, auth headers, and partner-node extra_data", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "comfy-test-key",
      mode: "api-key",
      source: "env",
    });
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "cloud-job-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ status: "completed" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            "cloud-job-1": {
              outputs: {
                "9": {
                  images: [{ filename: "cloud.png", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(null, {
          headers: { location: "https://cdn.example.com/cloud.png" },
          status: 302,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("cloud-data"), {
          headers: { "content-type": "image/png" },
          status: 200,
        }),
      });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      cfg: buildComfyConfig({
        mode: "cloud",
        outputNodeId: "9",
        promptNodeId: "6",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
      }),
      model: "workflow",
      prompt: "cloud workflow prompt",
      provider: "comfy",
    });

    const submitRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(submitRequest?.url).toBe("https://cloud.comfy.org/api/prompt");
    expect(submitRequest?.auditContext).toBe("comfy-image-generate");
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("comfy-test-key");
    expect(parseJsonBody(1)).toEqual({
      extra_data: {
        api_key_comfy_org: "comfy-test-key",
      },
      prompt: {
        "6": { inputs: { text: "cloud workflow prompt" } },
        "9": { inputs: {} },
      },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "comfy-status",
        url: "https://cloud.comfy.org/api/job/cloud-job-1/status",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        auditContext: "comfy-history",
        url: "https://cloud.comfy.org/api/history_v2/cloud-job-1",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        auditContext: "comfy-image-download",
        url: "https://cloud.comfy.org/api/view?filename=cloud.png&subfolder=&type=output",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        auditContext: "comfy-image-download",
        url: "https://cdn.example.com/cloud.png",
      }),
    );
    expect(result.metadata).toEqual({
      outputNodeIds: ["9"],
      promptId: "cloud-job-1",
    });
  });
});
