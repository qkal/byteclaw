import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to partial when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("partial");
    expect(resolveTelegramStreamMode({})).toBe("partial");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("maps legacy streamMode values", () => {
    expect(resolveTelegramStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveTelegramStreamMode({ streamMode: "partial" })).toBe("partial");
    expect(resolveTelegramStreamMode({ streamMode: "block" })).toBe("block");
  });

  it("maps unified progress mode to partial on Telegram", () => {
    expect(resolveTelegramStreamMode({ streaming: "progress" })).toBe("partial");
  });
});

describe("resolveTelegramDraftStreamingChunking", () => {
  it("uses smaller defaults than block streaming", () => {
    const chunking = resolveTelegramDraftStreamingChunking(undefined, "default");
    expect(chunking).toEqual({
      breakPreference: "paragraph",
      maxChars: 800,
      minChars: 200,
    });
  });

  it("clamps to telegram.textChunkLimit", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { allowFrom: ["*"], textChunkLimit: 150 } },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      breakPreference: "paragraph",
      maxChars: 150,
      minChars: 150,
    });
  });

  it("supports per-account overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            default: {
              allowFrom: ["*"],
              streaming: {
                preview: {
                  chunk: {
                    breakPreference: "sentence",
                    maxChars: 20,
                    minChars: 10,
                  },
                },
              },
            },
          },
          allowFrom: ["*"],
        },
      },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      breakPreference: "sentence",
      maxChars: 20,
      minChars: 10,
    });
  });
});
