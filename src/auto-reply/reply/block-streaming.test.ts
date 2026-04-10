import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveBlockStreamingChunking,
  resolveEffectiveBlockStreamingConfig,
} from "./block-streaming.js";

describe("resolveEffectiveBlockStreamingConfig", () => {
  it("applies ACP-style overrides while preserving chunk/coalescer bounds", () => {
    const cfg = {} as OpenClawConfig;
    const baseChunking = resolveBlockStreamingChunking(cfg, "discord");
    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg,
      coalesceIdleMs: 25,
      maxChunkChars: 64,
      provider: "discord",
    });

    expect(baseChunking.maxChars).toBeGreaterThanOrEqual(64);
    expect(resolved.chunking.maxChars).toBe(64);
    expect(resolved.chunking.minChars).toBeLessThanOrEqual(resolved.chunking.maxChars);
    expect(resolved.coalescing.maxChars).toBeLessThanOrEqual(resolved.chunking.maxChars);
    expect(resolved.coalescing.minChars).toBeLessThanOrEqual(resolved.coalescing.maxChars);
    expect(resolved.coalescing.idleMs).toBe(25);
  });

  it("reuses caller-provided chunking for shared main/subagent/ACP config resolution", () => {
    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg: undefined,
      chunking: {
        breakPreference: "paragraph",
        maxChars: 20,
        minChars: 10,
      },
      coalesceIdleMs: 0,
    });

    expect(resolved.chunking).toEqual({
      breakPreference: "paragraph",
      maxChars: 20,
      minChars: 10,
    });
    expect(resolved.coalescing.maxChars).toBe(20);
    expect(resolved.coalescing.idleMs).toBe(0);
  });

  it("honors newline chunkMode for plugin channels even before the plugin registry is loaded", () => {
    const cfg = {
      agents: {
        defaults: {
          blockStreamingChunk: {
            breakPreference: "paragraph",
            maxChars: 4000,
            minChars: 1,
          },
        },
      },
      channels: {
        bluebubbles: {
          chunkMode: "newline",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg,
      provider: "bluebubbles",
    });

    expect(resolved.chunking.flushOnParagraph).toBe(true);
    expect(resolved.coalescing.flushOnEnqueue).toBeUndefined();
    expect(resolved.coalescing.joiner).toBe("\n\n");
  });

  it("allows ACP maxChunkChars overrides above base defaults up to provider text limits", () => {
    const cfg = {
      channels: {
        discord: {
          textChunkLimit: 4096,
        },
      },
    } as OpenClawConfig;

    const baseChunking = resolveBlockStreamingChunking(cfg, "discord");
    expect(baseChunking.maxChars).toBeLessThan(1800);

    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg,
      maxChunkChars: 1800,
      provider: "discord",
    });

    expect(resolved.chunking.maxChars).toBe(1800);
    expect(resolved.chunking.minChars).toBeLessThanOrEqual(resolved.chunking.maxChars);
  });
});
