import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIDEO_GENERATION_TASK_KIND,
  buildActiveVideoGenerationTaskPromptContextForSession,
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
  getVideoGenerationTaskProviderId,
  isActiveVideoGenerationTask,
} from "./video-generation-task-status.js";

const taskRuntimeInternalMocks = vi.hoisted(() => ({
  listTasksForOwnerKey: vi.fn(),
}));

vi.mock("../tasks/runtime-internal.js", () => taskRuntimeInternalMocks);

describe("video generation task status", () => {
  beforeEach(() => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReset();
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([]);
  });

  it("recognizes active session-backed video generation tasks", () => {
    expect(
      isActiveVideoGenerationTask({
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main",
        requesterSessionKey: "agent:main",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        status: "running",
        task: "make lobster video",
        taskId: "task-1",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      }),
    ).toBe(true);
    expect(
      isActiveVideoGenerationTask({
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main",
        requesterSessionKey: "agent:main",
        runtime: "cron",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        status: "running",
        task: "make lobster video",
        taskId: "task-2",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      }),
    ).toBe(false);
  });

  it("prefers a running task over queued session siblings", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main",
        requesterSessionKey: "agent:main",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:google",
        status: "queued",
        task: "queued task",
        taskId: "task-queued",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      },
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main",
        progressSummary: "Generating video",
        requesterSessionKey: "agent:main",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        status: "running",
        task: "running task",
        taskId: "task-running",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      },
    ]);

    const task = findActiveVideoGenerationTaskForSession("agent:main");

    expect(task?.taskId).toBe("task-running");
    expect(getVideoGenerationTaskProviderId(task!)).toBe("openai");
    expect(buildVideoGenerationTaskStatusText(task!, { duplicateGuard: true })).toContain(
      "Do not call video_generate again for this request.",
    );
    expect(buildVideoGenerationTaskStatusDetails(task!)).toMatchObject({
      active: true,
      existingTask: true,
      progressSummary: "Generating video",
      provider: "openai",
      status: "running",
      taskKind: VIDEO_GENERATION_TASK_KIND,
    });
  });

  it("builds prompt context for active session work", () => {
    taskRuntimeInternalMocks.listTasksForOwnerKey.mockReturnValue([
      {
        createdAt: Date.now(),
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        ownerKey: "agent:main",
        progressSummary: "Generating video",
        requesterSessionKey: "agent:main",
        runtime: "cli",
        scopeKind: "session",
        sourceId: "video_generate:openai",
        status: "running",
        task: "running task",
        taskId: "task-running",
        taskKind: VIDEO_GENERATION_TASK_KIND,
      },
    ]);

    const context = buildActiveVideoGenerationTaskPromptContextForSession("agent:main");

    expect(context).toContain("An active video generation background task already exists");
    expect(context).toContain("Task task-running is currently running via openai.");
    expect(context).toContain('call `video_generate` with `action:"status"`');
  });
});
