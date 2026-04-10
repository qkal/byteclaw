import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  deriveAspectRatioFromSize,
  normalizeDurationToClosestMax,
  resolveCapabilityModelCandidates,
  resolveClosestAspectRatio,
  resolveClosestResolution,
  resolveClosestSize,
} from "./runtime-shared.js";

function parseModelRef(raw?: string) {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  return {
    model: trimmed.slice(slash + 1),
    provider: trimmed.slice(0, slash),
  };
}

describe("media-generation runtime shared candidates", () => {
  it("appends auth-backed provider defaults after explicit refs by default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    const candidates = resolveCapabilityModelCandidates({
      cfg,
      listProviders: () => [
        {
          defaultModel: "gemini-3.1-flash-image-preview",
          id: "google",
          isConfigured: () => true,
        },
        {
          defaultModel: "gpt-image-1",
          id: "openai",
          isConfigured: () => true,
        },
        {
          defaultModel: "image-01",
          id: "minimax",
          isConfigured: () => true,
        },
      ],
      modelConfig: {
        fallbacks: ["fal/fal-ai/flux/dev"],
        primary: "google/gemini-3.1-flash-image-preview",
      },
      parseModelRef,
    });

    expect(candidates).toEqual([
      { model: "gemini-3.1-flash-image-preview", provider: "google" },
      { model: "fal-ai/flux/dev", provider: "fal" },
      { model: "gpt-image-1", provider: "openai" },
      { model: "image-01", provider: "minimax" },
    ]);
  });

  it("auto-detects auth-backed provider defaults when no explicit media model is configured", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {} as OpenClawConfig,
      listProviders: () => [
        {
          defaultModel: "gpt-image-1",
          id: "openai",
          isConfigured: () => true,
        },
        {
          defaultModel: "fal-ai/flux/dev",
          id: "fal",
          isConfigured: () => true,
        },
      ],
      modelConfig: undefined,
      parseModelRef,
    });

    expect(candidates).toEqual([
      { model: "gpt-image-1", provider: "openai" },
      { model: "fal-ai/flux/dev", provider: "fal" },
    ]);
  });

  it("disables implicit provider expansion when mediaGenerationAutoProviderFallback=false", () => {
    const candidates = resolveCapabilityModelCandidates({
      cfg: {
        agents: {
          defaults: {
            mediaGenerationAutoProviderFallback: false,
          },
        },
      } as OpenClawConfig,
      listProviders: () => [
        {
          defaultModel: "gpt-image-1",
          id: "openai",
          isConfigured: () => true,
        },
      ],
      modelConfig: {
        primary: "google/gemini-3.1-flash-image-preview",
      },
      parseModelRef,
    });

    expect(candidates).toEqual([{ model: "gemini-3.1-flash-image-preview", provider: "google" }]);
  });
});

describe("media-generation runtime shared normalization", () => {
  it("derives reduced aspect ratios from size strings", () => {
    expect(deriveAspectRatioFromSize("1280x720")).toBe("16:9");
    expect(deriveAspectRatioFromSize("1024x1536")).toBe("2:3");
  });

  it("maps unsupported sizes to the closest supported size", () => {
    expect(
      resolveClosestSize({
        requestedSize: "1792x1024",
        supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
      }),
    ).toBe("1536x1024");
  });

  it("maps unsupported aspect ratios to the closest supported aspect ratio", () => {
    expect(
      resolveClosestAspectRatio({
        requestedAspectRatio: "17:10",
        supportedAspectRatios: ["1:1", "4:3", "16:9"],
      }),
    ).toBe("16:9");
  });

  it("maps unsupported resolutions to the closest supported resolution", () => {
    expect(
      resolveClosestResolution({
        requestedResolution: "2K",
        supportedResolutions: ["1K", "4K"],
      }),
    ).toBe("1K");
  });

  it("clamps durations to the closest supported max", () => {
    expect(normalizeDurationToClosestMax(12, 8)).toBe(8);
    expect(normalizeDurationToClosestMax(6, 8)).toBe(6);
  });
});
