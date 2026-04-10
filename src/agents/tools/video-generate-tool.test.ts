import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import * as videoGenerateBackground from "./video-generate-background.js";
import { createVideoGenerateTool } from "./video-generate-tool.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);
vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("createVideoGenerateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when no video-generation config or auth-backed provider is available", () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);

    expect(createVideoGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when video-generation config is present", () => {
    expect(
      createVideoGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
            },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("generates videos, saves them, and emits MEDIA paths without a session-backed detach", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      createdAt: Date.now(),
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "agent:main:discord:direct:123",
      requesterSessionKey: "agent:main:discord:direct:123",
      runtime: "cli",
      scopeKind: "session",
      status: "running",
      task: "friendly lobster surfing",
      taskId: "task-123",
    });
    taskExecutorMocks.completeTaskRunByRunId.mockReturnValue(undefined);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: { taskId: "task-1" },
      model: "wan2.6-t2v",
      provider: "qwen",
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          fileName: "lobster.mp4",
          mimeType: "video/mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "video/mp4",
      id: "generated-lobster.mp4",
      path: "/tmp/generated-lobster.mp4",
      size: 11,
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 video with qwen/wan2.6-t2v.");
    expect(text).toContain("MEDIA:/tmp/generated-lobster.mp4");
    expect(result.details).toMatchObject({
      count: 1,
      media: {
        mediaUrls: ["/tmp/generated-lobster.mp4"],
      },
      metadata: { taskId: "task-1" },
      model: "wan2.6-t2v",
      paths: ["/tmp/generated-lobster.mp4"],
      provider: "qwen",
    });
    expect(taskExecutorMocks.createRunningTaskRun).not.toHaveBeenCalled();
    expect(taskExecutorMocks.completeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("starts background generation and wakes the session with MEDIA lines", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      createdAt: Date.now(),
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "agent:main:discord:direct:123",
      requesterSessionKey: "agent:main:discord:direct:123",
      runtime: "cli",
      scopeKind: "session",
      status: "running",
      task: "friendly lobster surfing",
      taskId: "task-123",
    });
    const wakeSpy = vi
      .spyOn(videoGenerateBackground, "wakeVideoGenerationTaskCompletion")
      .mockResolvedValue(undefined);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: { taskId: "task-1" },
      model: "wan2.6-t2v",
      provider: "qwen",
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          fileName: "lobster.mp4",
          mimeType: "video/mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "video/mp4",
      id: "generated-lobster.mp4",
      path: "/tmp/generated-lobster.mp4",
      size: 11,
    });

    let scheduledWork: (() => Promise<void>) | undefined;
    const tool = createVideoGenerateTool({
      agentSessionKey: "agent:main:discord:direct:123",
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      scheduleBackgroundWork: (work) => {
        scheduledWork = work;
      },
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { prompt: "friendly lobster surfing" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Background task started for video generation (task-123).");
    expect(text).toContain("Do not call video_generate again for this request.");
    expect(result.details).toMatchObject({
      async: true,
      status: "started",
      task: {
        taskId: "task-123",
      },
    });
    expect(typeof scheduledWork).toBe("function");
    await scheduledWork?.();
    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Generating video",
        runId: expect.stringMatching(/^tool:video_generate:/),
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:video_generate:/),
      }),
    );
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          taskId: "task-123",
        }),
        result: expect.stringContaining("MEDIA:/tmp/generated-lobster.mp4"),
        status: "ok",
      }),
    );
  });

  it("surfaces provider generation failures inline when there is no detached session", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockRejectedValue(new Error("queue boom"));

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
          },
        },
      }),
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await expect(tool.execute("call-2", { prompt: "broken lobster" })).rejects.toThrow(
      "queue boom",
    );
    expect(taskExecutorMocks.failTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("shows duration normalization details from runtime metadata", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: {
        normalizedDurationSeconds: 6,
        requestedDurationSeconds: 5,
        supportedDurationSeconds: [4, 6, 8],
      },
      model: "veo-3.1-fast-generate-preview",
      normalization: {
        durationSeconds: {
          applied: 6,
          requested: 5,
          supportedValues: [4, 6, 8],
        },
      },
      provider: "google",
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          fileName: "lobster.mp4",
          mimeType: "video/mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "video/mp4",
      id: "generated-lobster.mp4",
      path: "/tmp/generated-lobster.mp4",
      size: 11,
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", {
      durationSeconds: 5,
      prompt: "friendly lobster surfing",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Duration normalized: requested 5s; used 6s.");
    expect(result.details).toMatchObject({
      durationSeconds: 6,
      normalization: {
        durationSeconds: {
          applied: 6,
          requested: 5,
          supportedValues: [4, 6, 8],
        },
      },
      requestedDurationSeconds: 5,
      supportedDurationSeconds: [4, 6, 8],
    });
  });

  it("surfaces normalized video geometry from runtime metadata", async () => {
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: {
        normalizedAspectRatio: "16:9",
        requestedSize: "1280x720",
      },
      model: "gen4.5",
      normalization: {
        aspectRatio: {
          applied: "16:9",
          derivedFrom: "size",
        },
      },
      provider: "runway",
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          fileName: "lobster.mp4",
          mimeType: "video/mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "video/mp4",
      id: "generated-lobster.mp4",
      path: "/tmp/generated-lobster.mp4",
      size: 11,
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "runway/gen4.5" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "friendly lobster surfing",
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

  it("lists supported provider durations when advertised", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        capabilities: {
          generate: {
            maxDurationSeconds: 8,
            supportedDurationSeconds: [4, 6, 8],
          },
          imageToVideo: {
            enabled: true,
            maxDurationSeconds: 8,
            maxInputImages: 1,
            supportedDurationSeconds: [4, 6, 8],
          },
        },
        defaultModel: "veo-3.1-fast-generate-preview",
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "google",
        models: ["veo-3.1-fast-generate-preview"],
      },
    ]);

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "google/veo-3.1-fast-generate-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("modes=generate/imageToVideo");
    expect(text).toContain("supportedDurationSeconds=4/6/8");
    expect(result.details).toMatchObject({
      providers: [
        expect.objectContaining({
          id: "google",
          modes: ["generate", "imageToVideo"],
        }),
      ],
    });
  });

  it("rejects image-to-video when the provider disables that mode", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        capabilities: {
          imageToVideo: {
            enabled: false,
          },
        },
        defaultModel: "vid-v1",
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "video-plugin",
        models: ["vid-v1"],
      },
    ]);
    const generateSpy = vi.spyOn(videoGenerationRuntime, "generateVideo");

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "video-plugin/vid-v1" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    await expect(
      tool.execute("call-1", {
        image: "data:image/png;base64,cG5n",
        prompt: "lobster timelapse",
      }),
    ).rejects.toThrow("video-plugin does not support image-to-video reference inputs.");
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("warns when optional provider overrides are ignored", async () => {
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([
      {
        capabilities: {
          generate: {
            supportsSize: true,
          },
        },
        defaultModel: "sora-2",
        generateVideo: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "openai",
        models: ["sora-2"],
      },
    ]);
    vi.spyOn(videoGenerationRuntime, "generateVideo").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [
        { key: "resolution", value: "720P" },
        { key: "audio", value: false },
        { key: "watermark", value: false },
      ],
      model: "sora-2",
      provider: "openai",
      videos: [
        {
          buffer: Buffer.from("video-bytes"),
          fileName: "lobster.mp4",
          mimeType: "video/mp4",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "video/mp4",
      id: "generated-lobster.mp4",
      path: "/tmp/generated-lobster.mp4",
      size: 11,
    });

    const tool = createVideoGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            videoGenerationModel: { primary: "openai/sora-2" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected video_generate tool");
    }

    const result = await tool.execute("call-openai-generate", {
      audio: false,
      prompt: "A lobster on a neon bridge",
      resolution: "720P",
      size: "1280x720",
      watermark: false,
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 video with openai/sora-2.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for openai/sora-2: resolution=720P, audio=false, watermark=false.",
    );
    expect(result).toMatchObject({
      details: {
        ignoredOverrides: [
          { key: "resolution", value: "720P" },
          { key: "audio", value: false },
          { key: "watermark", value: false },
        ],
        size: "1280x720",
        warning:
          "Ignored unsupported overrides for openai/sora-2: resolution=720P, audio=false, watermark=false.",
      },
    });
    expect(result.details).not.toHaveProperty("resolution");
    expect(result.details).not.toHaveProperty("audio");
    expect(result.details).not.toHaveProperty("watermark");
  });
});
