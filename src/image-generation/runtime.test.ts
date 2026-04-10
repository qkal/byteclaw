import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMediaGenerationRuntimeMocks,
  resetImageGenerationRuntimeMocks,
} from "../../test/helpers/media-generation/runtime-module-mocks.js";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

const mocks = getMediaGenerationRuntimeMocks();

vi.mock("./model-ref.js", () => ({
  parseImageGenerationModelRef: mocks.parseImageGenerationModelRef,
}));

vi.mock("./provider-registry.js", () => ({
  getImageGenerationProvider: mocks.getImageGenerationProvider,
  listImageGenerationProviders: mocks.listImageGenerationProviders,
}));

describe("image-generation runtime", () => {
  beforeEach(() => {
    resetImageGenerationRuntimeMocks();
  });

  it("generates images through the active image-generation provider", async () => {
    const authStore = { profiles: {}, version: 1 } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("image-plugin/img-v1");
    const provider: ImageGenerationProvider = {
      capabilities: {
        edit: { enabled: false },
        generate: {},
      },
      async generateImage(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          images: [
            {
              buffer: Buffer.from("png-bytes"),
              fileName: "sample.png",
              mimeType: "image/png",
            },
          ],
          model: "img-v1",
        };
      },
      id: "image-plugin",
    };
    mocks.getImageGenerationProvider.mockReturnValue(provider);

    const result = await generateImage({
      agentDir: "/tmp/agent",
      authStore,
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-plugin/img-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        fileName: "sample.png",
        mimeType: "image/png",
      },
    ]);
    expect(result.ignoredOverrides).toEqual([]);
  });

  it("auto-detects and falls through to another configured image-generation provider by default", async () => {
    mocks.getImageGenerationProvider.mockImplementation((providerId: string) => {
      if (providerId === "openai") {
        return {
          capabilities: {
            edit: { enabled: true },
            generate: {},
          },
          defaultModel: "gpt-image-1",
          async generateImage() {
            throw new Error("OpenAI API key missing");
          },
          id: "openai",
          isConfigured: () => true,
        };
      }
      if (providerId === "google") {
        return {
          capabilities: {
            edit: { enabled: true },
            generate: {},
          },
          defaultModel: "gemini-3.1-flash-image-preview",
          async generateImage() {
            return {
              images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
              model: "gemini-3.1-flash-image-preview",
            };
          },
          id: "google",
          isConfigured: () => true,
        };
      }
      return undefined;
    });
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        capabilities: {
          edit: { enabled: true },
          generate: {},
        },
        defaultModel: "gpt-image-1",
        generateImage: async () => ({ images: [] }),
        id: "openai",
        isConfigured: () => true,
      },
      {
        capabilities: {
          edit: { enabled: true },
          generate: {},
        },
        defaultModel: "gemini-3.1-flash-image-preview",
        generateImage: async () => ({ images: [] }),
        id: "google",
        isConfigured: () => true,
      },
    ]);

    const result = await generateImage({
      cfg: {} as OpenClawConfig,
      prompt: "draw a cat",
    });

    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-3.1-flash-image-preview");
    expect(result.attempts).toEqual([
      {
        error: "OpenAI API key missing",
        model: "gpt-image-1",
        provider: "openai",
      },
    ]);
  });

  it("drops unsupported provider geometry overrides and reports them", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("openai/gpt-image-1");
    mocks.getImageGenerationProvider.mockReturnValue({
      capabilities: {
        edit: {
          enabled: true,
          supportsAspectRatio: false,
          supportsResolution: false,
          supportsSize: true,
        },
        generate: {
          supportsAspectRatio: false,
          supportsResolution: false,
          supportsSize: true,
        },
        geometry: {
          sizes: ["1024x1024", "1024x1536", "1536x1024"],
        },
      },
      async generateImage(req) {
        seenRequest = {
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
          size: req.size,
        };
        return {
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        };
      },
      id: "openai",
    });

    const result = await generateImage({
      aspectRatio: "1:1",
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "openai/gpt-image-1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      resolution: "2K",
      size: "1024x1024",
    });

    expect(seenRequest).toEqual({
      aspectRatio: undefined,
      resolution: undefined,
      size: "1024x1024",
    });
    expect(result.ignoredOverrides).toEqual([
      { key: "aspectRatio", value: "1:1" },
      { key: "resolution", value: "2K" },
    ]);
  });

  it("maps requested size to the closest supported fallback geometry", async () => {
    let seenRequest:
      | {
          size?: string;
          aspectRatio?: string;
          resolution?: string;
        }
      | undefined;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("minimax/image-01");
    mocks.getImageGenerationProvider.mockReturnValue({
      capabilities: {
        edit: {
          enabled: true,
          supportsAspectRatio: true,
          supportsResolution: false,
          supportsSize: false,
        },
        generate: {
          supportsAspectRatio: true,
          supportsResolution: false,
          supportsSize: false,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
        },
      },
      async generateImage(req) {
        seenRequest = {
          aspectRatio: req.aspectRatio,
          resolution: req.resolution,
          size: req.size,
        };
        return {
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
          model: "image-01",
        };
      },
      id: "minimax",
    });

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "minimax/image-01" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      size: "1280x720",
    });

    expect(seenRequest).toEqual({
      aspectRatio: "16:9",
      resolution: undefined,
      size: undefined,
    });
    expect(result.ignoredOverrides).toEqual([]);
    expect(result.normalization).toMatchObject({
      aspectRatio: {
        applied: "16:9",
        derivedFrom: "size",
      },
    });
    expect(result.metadata).toMatchObject({
      aspectRatioDerivedFromSize: "16:9",
      normalizedAspectRatio: "16:9",
      requestedSize: "1280x720",
    });
  });

  it("lists runtime image-generation providers through the provider registry", () => {
    const providers: ImageGenerationProvider[] = [
      {
        capabilities: {
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          generate: {
            supportsResolution: true,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
        defaultModel: "img-v1",
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
        id: "image-plugin",
        models: ["img-v1", "img-v2"],
      },
    ];
    mocks.listImageGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeImageGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listImageGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        capabilities: {
          edit: { enabled: false },
          generate: {},
        },
        defaultModel: "paint-v1",
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
        id: "vision-one",
        isConfigured: () => false,
      },
      {
        capabilities: {
          edit: { enabled: false },
          generate: {},
        },
        defaultModel: "paint-v2",
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
        id: "vision-two",
        isConfigured: () => false,
      },
    ]);
    mocks.getProviderEnvVars.mockImplementation((providerId: string) => {
      if (providerId === "vision-one") {
        return ["VISION_ONE_API_KEY"];
      }
      if (providerId === "vision-two") {
        return ["VISION_TWO_API_KEY"];
      }
      return [];
    });

    const promise = generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" });

    await expect(promise).rejects.toThrow("No image-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.imageGenerationModel.primary to a provider/model like "vision-one/paint-v1".',
    );
    await expect(promise).rejects.toThrow("vision-one: VISION_ONE_API_KEY");
    await expect(promise).rejects.toThrow("vision-two: VISION_TWO_API_KEY");
  });
});
