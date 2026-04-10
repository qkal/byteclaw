import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_MAX_CAPTION_LENGTH, splitTelegramCaption } from "./caption.js";
import { resolveTelegramVoiceSend } from "./voice.js";

describe("splitTelegramCaption", () => {
  it("returns empty parts for blank captions", () => {
    expect(splitTelegramCaption("   ")).toEqual({
      caption: undefined,
      followUpText: undefined,
    });
  });

  it("keeps short captions inline", () => {
    expect(splitTelegramCaption(" hello ")).toEqual({
      caption: "hello",
      followUpText: undefined,
    });
  });

  it("moves oversized captions into follow-up text", () => {
    const text = "x".repeat(TELEGRAM_MAX_CAPTION_LENGTH + 1);
    expect(splitTelegramCaption(text)).toEqual({
      caption: undefined,
      followUpText: text,
    });
  });
});

describe("resolveTelegramVoiceSend", () => {
  it("skips voice when wantsVoice is false", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
      wantsVoice: false,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it("logs fallback for incompatible media", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      contentType: "audio/wav",
      fileName: "track.wav",
      logFallback,
      wantsVoice: true,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).toHaveBeenCalledWith(
      "Telegram voice requested but media is audio/wav (track.wav); sending as audio file instead.",
    );
  });

  it("keeps voice when compatible", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
      wantsVoice: true,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "audio/mpeg", fileName: "track.mp3" },
    { contentType: "audio/mp4", fileName: "track.m4a" },
  ])("keeps voice for compatible MIME $contentType", ({ contentType, fileName }) => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      contentType,
      fileName,
      logFallback,
      wantsVoice: true,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });
});
