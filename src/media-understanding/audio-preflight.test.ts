import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeFirstAudio } from "./audio-preflight.js";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      attachments: [],
      transcript: "voice note transcript",
    });

    const transcript = await transcribeFirstAudio({
      cfg: {},
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
    });

    expect(transcript).toBeUndefined();
    expect(runAudioTranscriptionMock).not.toHaveBeenCalled();
  });
});
