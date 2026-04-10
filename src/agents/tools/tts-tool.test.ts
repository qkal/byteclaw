import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import * as ttsRuntime from "../../tts/tts.js";
import { createTtsTool } from "./tts-tool.js";

let textToSpeechSpy: ReturnType<typeof vi.spyOn>;

describe("createTtsTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    textToSpeechSpy = vi.spyOn(ttsRuntime, "textToSpeech");
  });

  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain(SILENT_REPLY_TOKEN);
  });

  it("stores audio delivery in details.media", async () => {
    textToSpeechSpy.mockResolvedValue({
      audioPath: "/tmp/reply.opus",
      provider: "test",
      success: true,
      voiceCompatible: true,
    });

    const tool = createTtsTool();
    const result = await tool.execute("call-1", { text: "hello" });

    expect(result).toMatchObject({
      content: [{ text: "Generated audio reply.", type: "text" }],
      details: {
        audioPath: "/tmp/reply.opus",
        media: {
          audioAsVoice: true,
          mediaUrl: "/tmp/reply.opus",
        },
        provider: "test",
      },
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });
});
