import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoAuthStore,
} from "./live-test-helpers.js";

describe("video-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseCsvFilter()).toBeNull();
    expect(parseCsvFilter("all")).toBeNull();
    expect(parseCsvFilter(" google , openai ")).toEqual(new Set(["google", "openai"]));
  });

  it("parses provider model overrides by provider id", () => {
    expect(
      parseProviderModelMap("google/veo-3.1-fast-generate-preview, openai/sora-2, invalid"),
    ).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("collects configured models from primary and fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          videoGenerationModel: {
            fallbacks: ["openai/sora-2", "invalid"],
            primary: "google/veo-3.1-fast-generate-preview",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveConfiguredLiveVideoModels(cfg)).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("uses an empty auth store when live env keys should override stale profiles", () => {
    expect(
      resolveLiveVideoAuthStore({
        hasLiveKeys: true,
        requireProfileKeys: false,
      }),
    ).toEqual({
      profiles: {},
      version: 1,
    });
  });

  it("keeps profile-store mode when requested or when no live keys exist", () => {
    expect(
      resolveLiveVideoAuthStore({
        hasLiveKeys: true,
        requireProfileKeys: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLiveVideoAuthStore({
        hasLiveKeys: false,
        requireProfileKeys: false,
      }),
    ).toBeUndefined();
  });

  it("redacts live API keys for diagnostics", () => {
    expect(redactLiveApiKey(undefined)).toBe("none");
    expect(redactLiveApiKey("short-key")).toBe("short-key");
    expect(redactLiveApiKey("sk-proj-1234567890")).toBe("sk-proj-...7890");
  });

  it("runs buffer-backed video-to-video only for supported providers/models", () => {
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "google/veo-3.1-fast-generate-preview",
        providerId: "google",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "openai/sora-2",
        providerId: "openai",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "runway/gen4_aleph",
        providerId: "runway",
      }),
    ).toBe(true);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "runway/gen4.5",
        providerId: "runway",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "alibaba/wan2.6-r2v",
        providerId: "alibaba",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "qwen/wan2.6-r2v",
        providerId: "qwen",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        modelRef: "xai/grok-imagine-video",
        providerId: "xai",
      }),
    ).toBe(false);
  });

  it("runs buffer-backed image-to-video only for providers that accept bundled image inputs", () => {
    expect(
      canRunBufferBackedImageToVideoLiveLane({
        modelRef: "openai/sora-2",
        providerId: "openai",
      }),
    ).toBe(true);
    expect(
      canRunBufferBackedImageToVideoLiveLane({
        modelRef: "vydra/veo3",
        providerId: "vydra",
      }),
    ).toBe(false);
  });
});
