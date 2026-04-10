import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let imageGenerationRuntime: typeof import("../../image-generation/runtime.js");
let imageOps: typeof import("../../media/image-ops.js");
let mediaStore: typeof import("../../media/store.js");
let webMedia: typeof import("../../media/web-media.js");
let createImageGenerateTool: typeof import("./image-generate-tool.js").createImageGenerateTool;
let resolveImageGenerationModelConfigForTool: typeof import("./image-generate-tool.js").resolveImageGenerationModelConfigForTool;

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      capabilities: {
        edit: {
          enabled: true,
          maxInputImages: 5,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        generate: {
          maxCount: 4,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
          resolutions: ["1K", "2K", "4K"],
        },
      },
      defaultModel: "gemini-3.1-flash-image-preview",
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
      id: "google",
      models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
    },
    {
      capabilities: {
        edit: {
          enabled: false,
          maxInputImages: 0,
        },
        generate: {
          maxCount: 4,
          supportsAspectRatio: true,
          supportsSize: true,
        },
        geometry: {
          aspectRatios: ["1:1", "16:9"],
          sizes: ["1024x1024", "1024x1536", "1536x1024"],
        },
      },
      defaultModel: "gpt-image-1",
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
      id: "openai",
      models: ["gpt-image-1"],
    },
  ]);
}

function requireImageGenerateTool(tool: ReturnType<typeof createImageGenerateTool>) {
  expect(tool).not.toBeNull();
  if (!tool) {
    throw new Error("expected image_generate tool");
  }
  return tool;
}

function ensureDefaultImageGenerationProvidersStubbed() {
  if (vi.isMockFunction(imageGenerationRuntime.listRuntimeImageGenerationProviders)) {
    return;
  }
  stubImageGenerationProviders();
}

function createToolWithPrimaryImageModel(
  primary: string,
  extra?: {
    agentDir?: string;
    workspaceDir?: string;
  },
) {
  ensureDefaultImageGenerationProvidersStubbed();
  return requireImageGenerateTool(
    createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary,
            },
          },
        },
      },
      ...extra,
    }),
  );
}

function stubEditedImageFlow(params?: { width?: number; height?: number }) {
  const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
    attempts: [],
    ignoredOverrides: [],
    images: [
      {
        buffer: Buffer.from("png-out"),
        fileName: "edited.png",
        mimeType: "image/png",
      },
    ],
    model: "gemini-3-pro-image-preview",
    provider: "google",
  });
  vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
    buffer: Buffer.from("input-image"),
    contentType: "image/png",
    kind: "image",
  });
  if (params?.width && params?.height) {
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      height: params.height,
      width: params.width,
    });
  }
  vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
    contentType: "image/png",
    id: "edited.png",
    path: "/tmp/edited.png",
    size: 7,
  });
  return generateImage;
}

function createFalEditProvider(params?: {
  maxInputImages?: number;
  supportsAspectRatio?: boolean;
  aspectRatios?: string[];
}) {
  return {
    capabilities: {
      edit: {
        enabled: true,
        maxInputImages: params?.maxInputImages ?? 1,
        supportsAspectRatio: params?.supportsAspectRatio ?? false,
        supportsResolution: true,
        supportsSize: true,
      },
      generate: {
        maxCount: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
      },
      ...(params?.aspectRatios
        ? {
            geometry: {
              aspectRatios: params.aspectRatios,
            },
          }
        : {}),
    },
    defaultModel: "fal-ai/flux/dev",
    generateImage: vi.fn(async () => {
      throw new Error("not used");
    }),
    id: "fal",
    models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
  };
}

describe("createImageGenerateTool", () => {
  beforeAll(async () => {
    vi.doUnmock("../../secrets/provider-env-vars.js");
    imageGenerationRuntime = await import("../../image-generation/runtime.js");
    imageOps = await import("../../media/image-ops.js");
    mediaStore = await import("../../media/store.js");
    webMedia = await import("../../media/web-media.js");
    ({ createImageGenerateTool, resolveImageGenerationModelConfigForTool } =
      await import("./image-generate-tool.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when no image-generation model can be inferred", () => {
    stubImageGenerationProviders();
    expect(createImageGenerateTool({ config: {} })).toBeNull();
  });

  it("matches image-generation providers across canonical provider aliases", () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        aliases: ["z-ai"],
        capabilities: {
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
          generate: {
            maxCount: 4,
          },
          geometry: {},
        },
        defaultModel: "glm-4.5-image",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "z.ai",
        models: ["glm-4.5-image"],
      },
    ]);

    expect(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "z-ai/glm-4.5-image",
              },
            },
          },
        },
      }),
    ).not.toBeNull();
  });

  it("infers an OpenAI image-generation model from env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    expect(resolveImageGenerationModelConfigForTool({ cfg: {} })).toEqual({
      primary: "openai/gpt-image-1",
    });
    expect(createImageGenerateTool({ config: {} })).not.toBeNull();
  });

  it("prefers the primary model provider when multiple image providers have auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test");

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "google/gemini-3.1-pro-preview",
              },
            },
          },
        },
      }),
    ).toEqual({
      fallbacks: ["openai/gpt-image-1"],
      primary: "google/gemini-3.1-flash-image-preview",
    });
  });

  it("generates images and returns details.media paths", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
          generate: {
            maxCount: 4,
            supportsAspectRatio: true,
            supportsSize: true,
          },
          geometry: {
            aspectRatios: ["1:1", "16:9"],
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        defaultModel: "gpt-image-1",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "openai",
        models: ["gpt-image-1"],
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-1"),
          fileName: "cat-one.png",
          mimeType: "image/png",
        },
        {
          buffer: Buffer.from("png-2"),
          fileName: "cat-two.png",
          mimeType: "image/png",
          revisedPrompt: "A more cinematic cat",
        },
      ],
      model: "gpt-image-1",
      provider: "openai",
    });
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      id: "generated-1.png",
      path: "/tmp/generated-1.png",
      size: 5,
    });
    saveMediaBuffer.mockResolvedValueOnce({
      contentType: "image/png",
      id: "generated-2.png",
      path: "/tmp/generated-2.png",
      size: 5,
    });

    const tool = createImageGenerateTool({
      agentDir: "/tmp/agent",
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-1", {
      count: 2,
      filename: "cats/output.png",
      model: "openai/gpt-image-1",
      prompt: "A cat wearing sunglasses",
      size: "1024x1024",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/agent",
        cfg: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        count: 2,
        inputImages: [],
        modelOverride: "openai/gpt-image-1",
        prompt: "A cat wearing sunglasses",
        size: "1024x1024",
      }),
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("png-1"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("png-2"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(result).toMatchObject({
      content: [
        {
          text: expect.stringContaining("Generated 2 images with openai/gpt-image-1."),
          type: "text",
        },
      ],
      details: {
        count: 2,
        filename: "cats/output.png",
        media: {
          mediaUrls: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        },
        model: "gpt-image-1",
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        provider: "openai",
        revisedPrompts: ["A more cinematic cat"],
      },
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("MEDIA:/tmp/generated-1.png");
    expect(text).toContain("MEDIA:/tmp/generated-2.png");
  });

  it("includes MEDIA paths in content text so follow-up replies use the real saved file", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: true,
            maxInputImages: 5,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          generate: {
            maxCount: 4,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          geometry: {
            aspectRatios: ["1:1", "16:9"],
            resolutions: ["1K", "2K", "4K"],
          },
        },
        defaultModel: "gemini-3.1-flash-image-preview",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "google",
        models: ["gemini-3.1-flash-image-preview"],
      },
    ]);
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("jpg-data"),
          fileName: "kodo_sawaki_zazen.jpg",
          mimeType: "image/jpeg",
        },
      ],
      model: "gemini-3.1-flash-image-preview",
      provider: "google",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "image/jpeg",
      id: "kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
      path: "/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
      size: 8,
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "google/gemini-3.1-flash-image-preview" },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-regression", { prompt: "kodo sawaki zazen" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain(
      "MEDIA:/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
    );
    expect(result.details).toMatchObject({
      media: {
        mediaUrls: [
          "/home/openclaw/.openclaw/media/tool-image-generation/kodo_sawaki_zazen---3337a0ed-898a-4572-8950-0d288719f4f8.jpg",
        ],
      },
    });
  });

  it("rejects counts outside the supported range", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: true,
            maxInputImages: 5,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          generate: {
            maxCount: 4,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          geometry: {
            aspectRatios: ["1:1", "16:9"],
            resolutions: ["1K", "2K", "4K"],
          },
        },
        defaultModel: "gemini-3.1-flash-image-preview",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "google",
        models: ["gemini-3.1-flash-image-preview"],
      },
    ]);
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(tool.execute("call-2", { count: 5, prompt: "too many cats" })).rejects.toThrow(
      "count must be between 1 and 4",
    );
  });

  it("forwards reference images and inferred resolution for edit mode", async () => {
    const generateImage = stubEditedImageFlow({ height: 1800, width: 3200 });
    const tool = createToolWithPrimaryImageModel("google/gemini-3-pro-image-preview", {
      workspaceDir: process.cwd(),
    });

    await tool.execute("call-edit", {
      image: "./fixtures/reference.png",
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: undefined,
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/png",
          }),
        ],
        resolution: "4K",
      }),
    );
  });

  it("ignores non-finite mediaMaxMb when loading reference images", async () => {
    stubImageGenerationProviders();
    stubEditedImageFlow({ height: 1800, width: 3200 });
    const tool = requireImageGenerateTool(
      createImageGenerateTool({
        config: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "google/gemini-3-pro-image-preview",
              },
              mediaMaxMb: Number.POSITIVE_INFINITY,
            },
          },
        },
        workspaceDir: process.cwd(),
      }),
    );

    await tool.execute("call-edit-infinity-cap", {
      image: "./fixtures/reference.png",
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
    });

    expect(webMedia.loadWebMedia).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxBytes: undefined }),
    );
  });

  it("does not treat inferred edit resolution as an OpenAI override", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: true,
            maxCount: 4,
            maxInputImages: 5,
            supportsAspectRatio: false,
            supportsResolution: false,
            supportsSize: true,
          },
          generate: {
            maxCount: 4,
            supportsAspectRatio: false,
            supportsResolution: false,
            supportsSize: true,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        defaultModel: "gpt-image-1",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "openai",
        models: ["gpt-image-1"],
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          fileName: "edited.png",
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-1",
      provider: "openai",
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("input-image"),
      contentType: "image/jpeg",
      kind: "image",
    });
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      height: 1800,
      width: 3200,
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      contentType: "image/png",
      id: "edited.png",
      path: "/tmp/edited.png",
      size: 7,
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1", {
      workspaceDir: process.cwd(),
    });

    await expect(
      tool.execute("call-openai-edit", {
        image: "./fixtures/reference.png",
        prompt: "Remove the subject but keep the rest unchanged.",
      }),
    ).resolves.toBeDefined();

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/jpeg",
          }),
        ],
        modelOverride: undefined,
        resolution: undefined,
      }),
    );
  });

  it("forwards explicit aspect ratio and supports up to 5 reference images", async () => {
    const generateImage = stubEditedImageFlow();
    const tool = createToolWithPrimaryImageModel("google/gemini-3-pro-image-preview", {
      workspaceDir: process.cwd(),
    });

    const images = Array.from({ length: 5 }, (_, index) => `./fixtures/ref-${index + 1}.png`);
    await tool.execute("call-compose", {
      aspectRatio: "16:9",
      images,
      prompt: "Combine these into one scene",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
        inputImages: expect.arrayContaining([
          expect.objectContaining({ buffer: Buffer.from("input-image"), mimeType: "image/png" }),
        ]),
      }),
    );
    expect(generateImage.mock.calls[0]?.[0].inputImages).toHaveLength(5);
  });

  it("reports ignored unsupported overrides instead of failing", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: true,
            maxCount: 4,
            maxInputImages: 5,
            supportsAspectRatio: false,
            supportsResolution: false,
            supportsSize: true,
          },
          generate: {
            maxCount: 4,
            supportsAspectRatio: false,
            supportsResolution: false,
            supportsSize: true,
          },
          geometry: {
            sizes: ["1024x1024", "1024x1536", "1536x1024"],
          },
        },
        defaultModel: "gpt-image-1",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "openai",
        models: ["gpt-image-1"],
      },
    ]);
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [{ key: "aspectRatio", value: "1:1" }],
      images: [
        {
          buffer: Buffer.from("png-out"),
          fileName: "generated.png",
          mimeType: "image/png",
        },
      ],
      model: "gpt-image-1",
      provider: "openai",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      contentType: "image/png",
      id: "generated.png",
      path: "/tmp/generated.png",
      size: 7,
    });

    const tool = createToolWithPrimaryImageModel("openai/gpt-image-1");
    const result = await tool.execute("call-openai-generate", {
      aspectRatio: "1:1",
      prompt: "A lobster at the movies",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 image with openai/gpt-image-1.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
    );
    expect(result).toMatchObject({
      details: {
        ignoredOverrides: [{ key: "aspectRatio", value: "1:1" }],
        warning: "Ignored unsupported overrides for openai/gpt-image-1: aspectRatio=1:1.",
      },
    });
  });

  it("surfaces normalized image geometry from runtime metadata", async () => {
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          fileName: "generated.png",
          mimeType: "image/png",
        },
      ],
      metadata: {
        normalizedAspectRatio: "16:9",
        requestedSize: "1280x720",
      },
      model: "image-01",
      normalization: {
        aspectRatio: {
          applied: "16:9",
          derivedFrom: "size",
        },
      },
      provider: "minimax",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      contentType: "image/png",
      id: "generated.png",
      path: "/tmp/generated.png",
      size: 7,
    });

    const tool = createToolWithPrimaryImageModel("minimax/image-01");
    const result = await tool.execute("call-minimax-generate", {
      prompt: "A lobster at the movies",
      size: "1280x720",
    });

    expect(result.details).toMatchObject({
      aspectRatio: "16:9",
      metadata: {
        normalizedAspectRatio: "16:9",
        requestedSize: "1280x720",
      },
      normalization: {
        aspectRatio: {
          applied: "16:9",
          derivedFrom: "size",
        },
      },
    });
    expect(result.details).not.toHaveProperty("size");
  });

  it("rejects unsupported aspect ratios", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-bad-aspect", { aspectRatio: "7:5", prompt: "portrait" }),
    ).rejects.toThrow(
      "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
    );
  });

  it("lists registered provider and model options", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("google (default gemini-3.1-flash-image-preview)");
    expect(text).toContain("gemini-3.1-flash-image-preview");
    expect(text).toContain("gemini-3-pro-image-preview");
    expect(text).toContain("auth: set GEMINI_API_KEY / GOOGLE_API_KEY to use google/*");
    expect(text).toContain("auth: set OPENAI_API_KEY to use openai/*");
    expect(text).toContain("editing up to 5 refs");
    expect(text).toContain("aspect ratios 1:1, 16:9");
    expect(result).toMatchObject({
      details: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            authEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            capabilities: expect.objectContaining({
              edit: expect.objectContaining({
                enabled: true,
                maxInputImages: 5,
              }),
            }),
            defaultModel: "gemini-3.1-flash-image-preview",
            id: "google",
            models: expect.arrayContaining([
              "gemini-3.1-flash-image-preview",
              "gemini-3-pro-image-preview",
            ]),
          }),
          expect.objectContaining({
            authEnvVars: ["OPENAI_API_KEY"],
            id: "openai",
          }),
        ]),
      },
    });
  });

  it("skips auth hints for prototype-like provider ids", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        capabilities: {
          edit: {
            enabled: false,
            maxInputImages: 0,
          },
          generate: {
            maxCount: 1,
          },
        },
        defaultModel: "proto-v1",
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "__proto__",
        models: ["proto-v1"],
      },
    ]);

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "__proto__/proto-v1",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list-proto", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("__proto__ (default proto-v1)");
    expect(text).not.toContain("auth: set");
    expect(result).toMatchObject({
      details: {
        providers: [expect.objectContaining({ authEnvVars: [], id: "__proto__" })],
      },
    });
  });

  it("rejects provider-specific edit limits before runtime", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      createFalEditProvider(),
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
      kind: "image",
    });

    const tool = createToolWithPrimaryImageModel("fal/fal-ai/flux/dev", {
      workspaceDir: process.cwd(),
    });

    await expect(
      tool.execute("call-fal-edit", {
        images: ["./fixtures/a.png", "./fixtures/b.png"],
        prompt: "combine",
      }),
    ).rejects.toThrow("fal edit supports at most 1 reference image");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("passes edit aspect ratio overrides through to runtime for provider-level handling", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      createFalEditProvider({ aspectRatios: ["1:1", "16:9"] }),
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [{ key: "aspectRatio", value: "16:9" }],
      images: [
        {
          buffer: Buffer.from("png-out"),
          fileName: "edited.png",
          mimeType: "image/png",
        },
      ],
      model: "fal-ai/flux/dev",
      provider: "fal",
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
      kind: "image",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      contentType: "image/png",
      id: "edited.png",
      path: "/tmp/edited.png",
      size: 7,
    });

    const tool = createToolWithPrimaryImageModel("fal/fal-ai/flux/dev", {
      workspaceDir: process.cwd(),
    });

    const result = await tool.execute("call-fal-aspect", {
      aspectRatio: "16:9",
      image: "./fixtures/a.png",
      prompt: "edit",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
      }),
    );
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for fal/fal-ai/flux/dev: aspectRatio=16:9.",
    );
  });
});
