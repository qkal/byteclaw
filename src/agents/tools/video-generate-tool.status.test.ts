import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as videoGenerationRuntime from "../../video-generation/runtime.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  createVideoGenerateDuplicateGuardResult,
  createVideoGenerateStatusActionResult,
} from "./video-generate-tool.actions.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

describe("createVideoGenerateTool status actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(videoGenerationRuntime, "listRuntimeVideoGenerationProviders").mockReturnValue([]);
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
        progressSummary: "Generating video",
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:video_generate:active",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        status: "running",
        task: "friendly lobster surfing",
        taskId: "task-active",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      },
    ]);

    const result = createVideoGenerateDuplicateGuardResult("agent:main:discord:direct:123");
    const text = (result?.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(result).not.toBeNull();
    expect(text).toContain("Video generation task task-active is already running with openai.");
    expect(text).toContain("Do not call video_generate again for this request.");
    expect(result?.details).toMatchObject({
      action: "status",
      active: true,
      duplicateGuard: true,
      existingTask: true,
      progressSummary: "Generating video",
      provider: "openai",
      status: "running",
      task: {
        runId: "tool:video_generate:active",
        taskId: "task-active",
      },
      taskKind: VIDEO_GENERATION_TASK_KIND,
    });
  });

  it("reports active task status when action=status is requested", async () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main:discord:direct:123",
        progressSummary: "Queued video generation",
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:video_generate:active",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:google",
        status: "queued",
        task: "friendly lobster surfing",
        taskId: "task-active",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      },
    ]);

    const result = createVideoGenerateStatusActionResult("agent:main:discord:direct:123");
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("Video generation task task-active is already queued with google.");
    expect(result.details).toMatchObject({
      action: "status",
      active: true,
      existingTask: true,
      progressSummary: "Queued video generation",
      provider: "google",
      status: "queued",
      task: {
        taskId: "task-active",
      },
      taskKind: VIDEO_GENERATION_TASK_KIND,
    });
  });
});
