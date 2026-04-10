import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMinimaxProviderHttpMocks,
  installMinimaxProviderHttpMockCleanup,
  loadMinimaxMusicGenerationProviderModule,
} from "./provider-http.test-helpers.js";

const { postJsonRequestMock, fetchWithTimeoutMock } = getMinimaxProviderHttpMocks();

let buildMinimaxMusicGenerationProvider: Awaited<
  ReturnType<typeof loadMinimaxMusicGenerationProviderModule>
>["buildMinimaxMusicGenerationProvider"];

beforeAll(async () => {
  ({ buildMinimaxMusicGenerationProvider } = await loadMinimaxMusicGenerationProviderModule());
});

installMinimaxProviderHttpMockCleanup();

function mockMusicGenerationResponse(json: Record<string, unknown>): void {
  postJsonRequestMock.mockResolvedValue({
    release: vi.fn(async () => {}),
    response: {
      json: async () => json,
    },
  });
  fetchWithTimeoutMock.mockResolvedValue({
    arrayBuffer: async () => Buffer.from("mp3-bytes"),
    headers: new Headers({ "content-type": "audio/mpeg" }),
  });
}

describe("minimax music generation provider", () => {
  it("creates music and downloads the generated track", async () => {
    mockMusicGenerationResponse({
      audio_url: "https://example.com/out.mp3",
      base_resp: { status_code: 0 },
      lyrics: "our city wakes",
      task_id: "task-123",
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      cfg: {},
      durationSeconds: 45,
      lyrics: "our city wakes",
      model: "music-2.5+",
      prompt: "upbeat dance-pop with female vocals",
      provider: "minimax",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          audio_setting: {
            bitrate: 256000,
            format: "mp3",
            sample_rate: 44100,
          },
          lyrics: "our city wakes",
          model: "music-2.5+",
          output_format: "url",
        }),
        headers: expect.objectContaining({
          get: expect.any(Function),
        }),
        url: "https://api.minimax.io/v1/music_generation",
      }),
    );
    const headers = postJsonRequestMock.mock.calls[0]?.[0]?.headers as Headers | undefined;
    expect(headers?.get("content-type")).toBe("application/json");
    expect(result.tracks).toHaveLength(1);
    expect(result.lyrics).toEqual(["our city wakes"]);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        audioUrl: "https://example.com/out.mp3",
        taskId: "task-123",
      }),
    );
  });

  it("downloads tracks when url output is returned in data.audio", async () => {
    mockMusicGenerationResponse({
      base_resp: { status_code: 0 },
      data: {
        audio: "https://example.com/url-audio.mp3",
      },
    });

    const provider = buildMinimaxMusicGenerationProvider();
    const result = await provider.generateMusic({
      cfg: {},
      lyrics: "our city wakes",
      model: "music-2.5+",
      prompt: "upbeat dance-pop with female vocals",
      provider: "minimax",
    });

    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      "https://example.com/url-audio.mp3",
      { method: "GET" },
      120_000,
      fetch,
    );
    expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(0);
  });

  it("rejects instrumental requests that also include lyrics", async () => {
    const provider = buildMinimaxMusicGenerationProvider();

    await expect(
      provider.generateMusic({
        cfg: {},
        instrumental: true,
        lyrics: "do not sing this",
        model: "music-2.5+",
        prompt: "driving techno",
        provider: "minimax",
      }),
    ).rejects.toThrow("cannot use lyrics when instrumental=true");
  });

  it("uses lyrics optimizer when lyrics are omitted", async () => {
    mockMusicGenerationResponse({
      audio_url: "https://example.com/out.mp3",
      base_resp: { status_code: 0 },
      task_id: "task-456",
    });

    const provider = buildMinimaxMusicGenerationProvider();
    await provider.generateMusic({
      cfg: {},
      model: "music-2.5+",
      prompt: "upbeat dance-pop",
      provider: "minimax",
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          lyrics_optimizer: true,
          model: "music-2.5+",
        }),
      }),
    );
  });
});
