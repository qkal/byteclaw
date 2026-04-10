import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setComfyFetchGuardForTesting,
  buildComfyVideoGenerationProvider,
} from "./video-generation-provider.js";

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

describe("comfy video-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setComfyFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("treats local comfy video workflows as configured without an API key", () => {
    const provider = buildComfyVideoGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          video: {
            promptNodeId: "6",
            workflow: {
              "6": { inputs: { text: "" } },
            },
          },
        }),
      }),
    ).toBe(true);
  });

  it("submits a local workflow, waits for history, and downloads videos", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "local-video-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            "local-video-1": {
              outputs: {
                "9": {
                  gifs: [{ filename: "generated.mp4", subfolder: "", type: "output" }],
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
        response: new Response(Buffer.from("mp4-data"), {
          headers: { "content-type": "video/mp4" },
          status: 200,
        }),
      });

    const provider = buildComfyVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: buildComfyConfig({
        video: {
          outputNodeId: "9",
          promptNodeId: "6",
          workflow: {
            "6": { inputs: { text: "" } },
            "9": { inputs: {} },
          },
        },
      }),
      model: "workflow",
      prompt: "animate a lobster",
      provider: "comfy",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        auditContext: "comfy-video-generate",
        url: "http://127.0.0.1:8188/prompt",
      }),
    );
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "animate a lobster" } },
        "9": { inputs: {} },
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        auditContext: "comfy-history",
        url: "http://127.0.0.1:8188/history/local-video-1",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        auditContext: "comfy-video-download",
        url: "http://127.0.0.1:8188/view?filename=generated.mp4&subfolder=&type=output",
      }),
    );
    expect(result).toEqual({
      metadata: {
        outputNodeIds: ["9"],
        promptId: "local-video-1",
      },
      model: "workflow",
      videos: [
        {
          buffer: Buffer.from("mp4-data"),
          fileName: "generated.mp4",
          metadata: {
            nodeId: "9",
            promptId: "local-video-1",
          },
          mimeType: "video/mp4",
        },
      ],
    });
  });

  it("uses cloud endpoints for video workflows", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "comfy-test-key",
      mode: "api-key",
      source: "env",
    });
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "cloud-video-1" }), {
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
            "cloud-video-1": {
              outputs: {
                "9": {
                  gifs: [{ filename: "cloud.mp4", subfolder: "", type: "output" }],
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
          headers: { location: "https://cdn.example.com/cloud.mp4" },
          status: 302,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(Buffer.from("cloud-video-data"), {
          headers: { "content-type": "video/mp4" },
          status: 200,
        }),
      });

    const provider = buildComfyVideoGenerationProvider();
    const result = await provider.generateVideo({
      cfg: buildComfyConfig({
        mode: "cloud",
        video: {
          outputNodeId: "9",
          promptNodeId: "6",
          workflow: {
            "6": { inputs: { text: "" } },
            "9": { inputs: {} },
          },
        },
      }),
      model: "workflow",
      prompt: "cloud video workflow",
      provider: "comfy",
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        auditContext: "comfy-video-generate",
        url: "https://cloud.comfy.org/api/prompt",
      }),
    );
    expect(result.metadata).toEqual({
      outputNodeIds: ["9"],
      promptId: "cloud-video-1",
    });
  });
});
