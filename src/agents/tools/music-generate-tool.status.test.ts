import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as musicGenerationRuntime from "../../music-generation/runtime.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

describe("createMusicGenerateTool status actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(musicGenerationRuntime, "listRuntimeMusicGenerationProviders").mockReturnValue([]);
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns active task status instead of starting a duplicate generation", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main:discord:direct:123",
        progressSummary: "Generating music",
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:active",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "music_generate:google",
        status: "running",
        task: "night-drive synthwave",
        taskId: "task-active",
        taskKind: MUSIC_GENERATION_TASK_KIND,
      },
    ]);

    const result = createMusicGenerateDuplicateGuardResult("agent:main:discord:direct:123");
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(result).not.toBeNull();
    expect(text).toContain("Music generation task task-active is already running with google.");
    expect(text).toContain("Do not call music_generate again for this request.");
    expect(result?.details).toMatchObject({
      action: "status",
      active: true,
      duplicateGuard: true,
      existingTask: true,
      progressSummary: "Generating music",
      provider: "google",
      status: "running",
      task: {
        runId: "tool:music_generate:active",
        taskId: "task-active",
      },
      taskKind: MUSIC_GENERATION_TASK_KIND,
    });
  });

  it("reports active task status when action=status is requested", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main:discord:direct:123",
        progressSummary: "Queued music generation",
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:active",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "music_generate:minimax",
        status: "queued",
        task: "night-drive synthwave",
        taskId: "task-active",
        taskKind: MUSIC_GENERATION_TASK_KIND,
      },
    ]);

    const result = createMusicGenerateStatusActionResult("agent:main:discord:direct:123");
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Music generation task task-active is already queued with minimax.");
    expect(result.details).toMatchObject({
      action: "status",
      active: true,
      existingTask: true,
      progressSummary: "Queued music generation",
      provider: "minimax",
      status: "queued",
      task: {
        taskId: "task-active",
      },
      taskKind: MUSIC_GENERATION_TASK_KIND,
    });
  });
});
