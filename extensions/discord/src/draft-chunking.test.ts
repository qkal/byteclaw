import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveDiscordDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveDiscordDraftStreamingChunking", () => {
  it("returns sane defaults when discord draft chunking is unset", () => {
    expect(resolveDiscordDraftStreamingChunking(undefined)).toEqual({
      breakPreference: "paragraph",
      maxChars: 800,
      minChars: 200,
    });
  });

  it("clamps requested draft chunk sizes to the resolved text limit", () => {
    const cfg = {
      channels: {
        discord: {
          draftChunk: {
            breakPreference: "sentence",
            maxChars: 1200,
            minChars: 900,
          },
          textChunkLimit: 500,
        },
      },
    } as OpenClawConfig;

    expect(resolveDiscordDraftStreamingChunking(cfg)).toEqual({
      breakPreference: "sentence",
      maxChars: 500,
      minChars: 500,
    });
  });

  it("prefers account draft chunking over channel defaults", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: {
              draftChunk: {
                breakPreference: "newline",
                maxChars: 75,
                minChars: 25,
              },
            },
          },
          draftChunk: {
            breakPreference: "paragraph",
            maxChars: 800,
            minChars: 200,
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDiscordDraftStreamingChunking(cfg, "ops")).toEqual({
      breakPreference: "newline",
      maxChars: 75,
      minChars: 25,
    });
  });
});
