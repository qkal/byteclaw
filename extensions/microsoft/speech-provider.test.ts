import { writeFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMicrosoftSpeechProvider,
  isCjkDominant,
  listMicrosoftVoices,
} from "./speech-provider.js";
import * as ttsModule from "./tts.js";

const TEST_CFG = {} as OpenClawConfig;

describe("listMicrosoftVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps Microsoft voice metadata into speech voice options", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
            Gender: "Female",
            Locale: "en-US",
            ShortName: "en-US-AvaNeural",
            VoiceTag: {
              ContentCategories: ["General"],
              VoicePersonalities: ["Friendly", "Positive"],
            },
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof globalThis.fetch;

    const voices = await listMicrosoftVoices();

    expect(voices).toEqual([
      {
        category: "General",
        description: "Friendly, Positive",
        gender: "Female",
        id: "en-US-AvaNeural",
        locale: "en-US",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        personalities: ["Friendly", "Positive"],
      },
    ]);
  });

  it("throws on Microsoft voice list failures", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("nope", { status: 503 }),
      ) as unknown as typeof globalThis.fetch;

    await expect(listMicrosoftVoices()).rejects.toThrow("Microsoft voices API error (503)");
  });
});

describe("isCjkDominant", () => {
  it("returns true for Chinese text", () => {
    expect(isCjkDominant("你好世界")).toBe(true);
  });

  it("returns true for mixed text with majority CJK", () => {
    expect(isCjkDominant("你好，这是一个测试 hello")).toBe(true);
  });

  it("returns false for English text", () => {
    expect(isCjkDominant("Hello, this is a test")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCjkDominant("")).toBe(false);
  });

  it("returns false for mostly English with a few CJK chars", () => {
    expect(isCjkDominant("This is a long English sentence with one 字")).toBe(false);
  });
});

describe("buildMicrosoftSpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches to a Chinese voice for CJK text when no explicit voice override is set", async () => {
    const provider = buildMicrosoftSpeechProvider();
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xFF, 0xFB, 0x90, 0x00]));
    });

    await provider.synthesize({
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
        voice: "en-US-MichelleNeural",
      },
      providerOverrides: {},
      target: "audio-file",
      text: "你好，这是一个测试 hello",
      timeoutMs: 1000,
    });

    expect(edgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          lang: "zh-CN",
          voice: "zh-CN-XiaoxiaoNeural",
        }),
      }),
    );
  });

  it("preserves an explicitly configured English voice for CJK text", async () => {
    const provider = buildMicrosoftSpeechProvider();
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xFF, 0xFB, 0x90, 0x00]));
    });

    await provider.synthesize({
      cfg: TEST_CFG,
      providerConfig: {
        enabled: true,
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
        voice: "en-US-AvaNeural",
      },
      providerOverrides: {},
      target: "audio-file",
      text: "你好，这是一个测试 hello",
      timeoutMs: 1000,
    });

    expect(edgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          lang: "en-US",
          voice: "en-US-AvaNeural",
        }),
      }),
    );
  });
});
