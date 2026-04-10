import { describe, expect, it } from "vitest";
import {
  listSupportedVideoGenerationModes,
  resolveVideoGenerationMode,
  resolveVideoGenerationModeCapabilities,
} from "./capabilities.js";
import type { VideoGenerationProvider } from "./types.js";

function createProvider(
  capabilities: VideoGenerationProvider["capabilities"],
): VideoGenerationProvider {
  return {
    capabilities,
    async generateVideo() {
      throw new Error("not used");
    },
    id: "video-plugin",
  };
}

describe("video-generation capabilities", () => {
  it("requires explicit transform capabilities before advertising transform modes", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 2,
    });

    expect(listSupportedVideoGenerationModes(provider)).toEqual(["generate"]);
  });

  it("prefers explicit mode capabilities for image-to-video requests", () => {
    const provider = createProvider({
      imageToVideo: {
        enabled: true,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsSize: false,
      },
      supportsSize: true,
    });

    expect(
      resolveVideoGenerationModeCapabilities({
        inputImageCount: 1,
        inputVideoCount: 0,
        provider,
      }),
    ).toEqual({
      capabilities: {
        enabled: true,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsSize: false,
      },
      mode: "imageToVideo",
    });
  });

  it("does not infer transform capabilities for mixed reference requests", () => {
    const provider = createProvider({
      maxInputImages: 1,
      maxInputVideos: 4,
      supportsAudio: true,
    });

    expect(resolveVideoGenerationMode({ inputImageCount: 1, inputVideoCount: 1 })).toBeNull();
    expect(
      resolveVideoGenerationModeCapabilities({
        inputImageCount: 1,
        inputVideoCount: 1,
        provider,
      }),
    ).toEqual({
      capabilities: undefined,
      mode: null,
    });
  });
});
