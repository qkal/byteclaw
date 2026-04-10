import { describe, expect, it, vi } from "vitest";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { _setComfyFetchGuardForTesting } from "./workflow-runtime.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

describe("comfy music-generation provider", () => {
  it("registers the workflow model", () => {
    const provider = buildComfyMusicGenerationProvider();

    expect(provider.defaultModel).toBe("workflow");
    expect(provider.models).toEqual(["workflow"]);
    expect(provider.capabilities.edit?.maxInputImages).toBe(1);
  });

  it("runs a music workflow and returns audio outputs", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(JSON.stringify({ prompt_id: "music-job-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      })
      .mockResolvedValueOnce({
        release: vi.fn(async () => {}),
        response: new Response(
          JSON.stringify({
            "music-job-1": {
              outputs: {
                "9": {
                  audio: [{ filename: "song.mp3", subfolder: "", type: "output" }],
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
        response: new Response(Buffer.from("music-bytes"), {
          headers: { "content-type": "audio/mpeg" },
          status: 200,
        }),
      });

    const provider = buildComfyMusicGenerationProvider();
    const result = await provider.generateMusic({
      cfg: {
        models: {
          providers: {
            comfy: {
              music: {
                outputNodeId: "9",
                promptNodeId: "6",
                workflow: {
                  "6": { inputs: { text: "" } },
                  "9": { inputs: {} },
                },
              },
            },
          },
        },
      } as never,
      model: "workflow",
      prompt: "gentle ambient synth loop",
      provider: "comfy",
    });

    expect(result).toMatchObject({
      metadata: {
        inputImageCount: 0,
        outputNodeIds: ["9"],
        promptId: "music-job-1",
      },
      model: "workflow",
      tracks: [
        {
          fileName: "song.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    });
    expect(result.tracks[0]?.buffer).toEqual(Buffer.from("music-bytes"));
  });
});
