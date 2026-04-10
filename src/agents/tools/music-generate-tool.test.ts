import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import * as musicGenerateBackground from "./music-generate-background.js";
import { createMusicGenerateTool } from "./music-generate-tool.js";

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

describe("createMusicGenerateTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
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

  it("returns null when no music-generation config or auth-backed provider is available", () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    expect(createMusicGenerateTool({ config: asConfig({}) })).toBeNull();
  });

  it("registers when music-generation config is present", () => {
    expect(
      createMusicGenerateTool({
        config: asConfig({
          agents: {
            defaults: {
              musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
            },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("generates tracks, saves them, and emits MEDIA paths without a session-backed detach", async () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      createdAt: Date.now(),
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      ownerKey: "agent:main:discord:direct:123",
      requesterSessionKey: "agent:main:discord:direct:123",
      runtime: "cli",
      scopeKind: "session",
      status: "running",
      task: "night-drive synthwave",
      taskId: "task-123",
    });
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      lyrics: ["wake the city up"],
      metadata: { taskId: "music-task-1" },
      model: "lyria-3-clip-preview",
      provider: "google",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          fileName: "night-drive.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "audio/mpeg",
      id: "generated-night-drive.mp3",
      path: "/tmp/generated-night-drive.mp3",
      size: 11,
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      instrumental: true,
      prompt: "night-drive synthwave",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 track with google/lyria-3-clip-preview.");
    expect(text).toContain("Lyrics returned.");
    expect(text).toContain("MEDIA:/tmp/generated-night-drive.mp3");
    expect(result.details).toMatchObject({
      count: 1,
      instrumental: true,
      lyrics: ["wake the city up"],
      media: {
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
      },
      metadata: { taskId: "music-task-1" },
      model: "lyria-3-clip-preview",
      paths: ["/tmp/generated-night-drive.mp3"],
      provider: "google",
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
      task: "night-drive synthwave",
      taskId: "task-123",
    });
    const wakeSpy = vi
      .spyOn(musicGenerateBackground, "wakeMusicGenerationTaskCompletion")
      .mockResolvedValue(undefined);
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: { taskId: "music-task-1" },
      model: "lyria-3-clip-preview",
      provider: "google",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          fileName: "night-drive.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "audio/mpeg",
      id: "generated-night-drive.mp3",
      path: "/tmp/generated-night-drive.mp3",
      size: 11,
    });

    let scheduledWork: (() => Promise<void>) | undefined;
    const tool = createMusicGenerateTool({
      agentSessionKey: "agent:main:discord:direct:123",
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
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
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      instrumental: true,
      prompt: "night-drive synthwave",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Background task started for music generation (task-123).");
    expect(text).toContain("Do not call music_generate again for this request.");
    expect(result.details).toMatchObject({
      async: true,
      instrumental: true,
      status: "started",
      task: {
        taskId: "task-123",
      },
    });
    expect(typeof scheduledWork).toBe("function");
    await scheduledWork?.();
    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Generating music",
        runId: expect.stringMatching(/^tool:music_generate:/),
      }),
    );
    expect(taskExecutorMocks.completeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^tool:music_generate:/),
      }),
    );
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({
          taskId: "task-123",
        }),
        result: expect.stringContaining("MEDIA:/tmp/generated-night-drive.mp3"),
        status: "ok",
      }),
    );
  });

  it("lists provider capabilities", async () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([
      {
        capabilities: {
          generate: {
            maxTracks: 1,
            supportedFormats: ["mp3"],
            supportsDuration: true,
            supportsFormat: true,
            supportsInstrumental: true,
            supportsLyrics: true,
          },
        },
        defaultModel: "music-2.5+",
        generateMusic: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "minimax",
        models: ["music-2.5+"],
      },
    ]);

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("supportedFormats=mp3");
    expect(text).toContain("instrumental");
  });

  it("warns when optional provider overrides are ignored", async () => {
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([
      {
        capabilities: {
          generate: {
            supportedFormatsByModel: {
              "lyria-3-clip-preview": ["mp3"],
            },
            supportsFormat: true,
            supportsInstrumental: true,
            supportsLyrics: true,
          },
        },
        defaultModel: "lyria-3-clip-preview",
        generateMusic: vi.fn(async () => {
          throw new Error("not used");
        }),
        id: "google",
        models: ["lyria-3-clip-preview"],
      },
    ]);
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [
        { key: "durationSeconds", value: 30 },
        { key: "format", value: "wav" },
      ],
      model: "lyria-3-clip-preview",
      provider: "google",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          fileName: "molty-anthem.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "audio/mpeg",
      id: "molty-anthem.mp3",
      path: "/tmp/molty-anthem.mp3",
      size: 11,
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "google/lyria-3-clip-preview" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-google-generate", {
      durationSeconds: 30,
      format: "wav",
      instrumental: true,
      prompt: "OpenClaw anthem",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Generated 1 track with google/lyria-3-clip-preview.");
    expect(text).toContain(
      "Warning: Ignored unsupported overrides for google/lyria-3-clip-preview: durationSeconds=30, format=wav.",
    );
    expect(result).toMatchObject({
      details: {
        ignoredOverrides: [
          { key: "durationSeconds", value: 30 },
          { key: "format", value: "wav" },
        ],
        instrumental: true,
        warning:
          "Ignored unsupported overrides for google/lyria-3-clip-preview: durationSeconds=30, format=wav.",
      },
    });
    expect(result.details).not.toHaveProperty("durationSeconds");
    expect(result.details).not.toHaveProperty("format");
  });

  it("surfaces normalized durations from runtime metadata", async () => {
    vi.spyOn(musicGenerationRuntime, "generateMusic").mockResolvedValue({
      attempts: [],
      ignoredOverrides: [],
      metadata: {
        normalizedDurationSeconds: 30,
        requestedDurationSeconds: 45,
      },
      model: "music-2.5+",
      normalization: {
        durationSeconds: {
          applied: 30,
          requested: 45,
        },
      },
      provider: "minimax",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          fileName: "night-drive.mp3",
          mimeType: "audio/mpeg",
        },
      ],
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValueOnce({
      contentType: "audio/mpeg",
      id: "generated-night-drive.mp3",
      path: "/tmp/generated-night-drive.mp3",
      size: 11,
    });

    const tool = createMusicGenerateTool({
      config: asConfig({
        agents: {
          defaults: {
            musicGenerationModel: { primary: "minimax/music-2.5+" },
          },
        },
      }),
    });
    if (!tool) {
      throw new Error("expected music_generate tool");
    }

    const result = await tool.execute("call-1", {
      durationSeconds: 45,
      prompt: "night-drive synthwave",
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Duration normalized: requested 45s; used 30s.");
    expect(result.details).toMatchObject({
      durationSeconds: 30,
      normalization: {
        durationSeconds: {
          applied: 30,
          requested: 45,
        },
      },
      requestedDurationSeconds: 45,
    });
  });
});
