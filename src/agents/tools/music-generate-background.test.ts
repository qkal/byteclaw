import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  createMusicGenerationTaskRun,
  recordMusicGenerationTaskProgress,
  wakeMusicGenerationTaskCompletion,
} from "./music-generate-background.js";

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
}));

const announceDeliveryMocks = vi.hoisted(() => ({
  deliverSubagentAnnouncement: vi.fn(),
}));
const taskDeliveryRuntimeMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("../../tasks/task-executor.js", () => taskExecutorMocks);
vi.mock("../../tasks/task-registry-delivery-runtime.js", () => taskDeliveryRuntimeMocks);
vi.mock("../subagent-announce-delivery.js", () => announceDeliveryMocks);

describe("music generate background helpers", () => {
  beforeEach(() => {
    taskExecutorMocks.createRunningTaskRun.mockReset();
    taskExecutorMocks.recordTaskRunProgressByRunId.mockReset();
    taskDeliveryRuntimeMocks.sendMessage.mockReset();
    announceDeliveryMocks.deliverSubagentAnnouncement.mockReset();
  });

  it("creates a running task with queued progress text", () => {
    taskExecutorMocks.createRunningTaskRun.mockReturnValue({
      taskId: "task-123",
    });

    const handle = createMusicGenerationTaskRun({
      prompt: "night-drive synthwave",
      providerId: "google",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
      },
      sessionKey: "agent:main:discord:direct:123",
    });

    expect(handle).toMatchObject({
      requesterSessionKey: "agent:main:discord:direct:123",
      taskId: "task-123",
      taskLabel: "night-drive synthwave",
    });
    expect(taskExecutorMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Queued music generation",
        sourceId: "music_generate:google",
        taskKind: MUSIC_GENERATION_TASK_KIND,
      }),
    );
  });

  it("records task progress updates", () => {
    recordMusicGenerationTaskProgress({
      handle: {
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:abc",
        taskId: "task-123",
        taskLabel: "night-drive synthwave",
      },
      progressSummary: "Saving generated music",
    });

    expect(taskExecutorMocks.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Saving generated music",
        runId: "tool:music_generate:abc",
      }),
    );
  });

  it("queues a completion event by default when direct send is disabled", async () => {
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      handle: {
        requesterOrigin: {
          channel: "discord",
          threadId: "thread-1",
          to: "channel:1",
        },
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:abc",
        taskId: "task-123",
        taskLabel: "night-drive synthwave",
      },
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      status: "ok",
      statusLabel: "completed successfully",
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).not.toHaveBeenCalled();
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalled();
  });

  it("delivers completed music directly to the requester channel when enabled", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockResolvedValue({
      channel: "discord",
      messageId: "msg-1",
    });

    await wakeMusicGenerationTaskCompletion({
      config: { tools: { media: { asyncCompletion: { directSend: true } } } },
      handle: {
        requesterOrigin: {
          channel: "discord",
          threadId: "thread-1",
          to: "channel:1",
        },
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:abc",
        taskId: "task-123",
        taskLabel: "night-drive synthwave",
      },
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      status: "ok",
      statusLabel: "completed successfully",
    });

    expect(taskDeliveryRuntimeMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        content: "Generated 1 track.",
        mediaUrls: ["/tmp/generated-night-drive.mp3"],
        threadId: "thread-1",
        to: "channel:1",
      }),
    );
    expect(announceDeliveryMocks.deliverSubagentAnnouncement).not.toHaveBeenCalled();
  });

  it("falls back to a music-generation completion event when direct delivery fails", async () => {
    taskDeliveryRuntimeMocks.sendMessage.mockRejectedValue(new Error("discord upload failed"));
    announceDeliveryMocks.deliverSubagentAnnouncement.mockResolvedValue({
      delivered: true,
      path: "direct",
    });

    await wakeMusicGenerationTaskCompletion({
      config: { tools: { media: { asyncCompletion: { directSend: true } } } },
      handle: {
        requesterOrigin: {
          channel: "discord",
          threadId: "thread-1",
          to: "channel:1",
        },
        requesterSessionKey: "agent:main:discord:direct:123",
        runId: "tool:music_generate:abc",
        taskId: "task-123",
        taskLabel: "night-drive synthwave",
      },
      mediaUrls: ["/tmp/generated-night-drive.mp3"],
      result: "Generated 1 track.\nMEDIA:/tmp/generated-night-drive.mp3",
      status: "ok",
      statusLabel: "completed successfully",
    });

    expect(announceDeliveryMocks.deliverSubagentAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        expectsCompletionMessage: true,
        internalEvents: expect.arrayContaining([
          expect.objectContaining({
            announceType: "music generation task",
            mediaUrls: ["/tmp/generated-night-drive.mp3"],
            replyInstruction: expect.stringContaining("Prefer the message tool for delivery"),
            result: expect.stringContaining("MEDIA:/tmp/generated-night-drive.mp3"),
            source: "music_generation",
            status: "ok",
          }),
        ]),
        requesterOrigin: expect.objectContaining({
          channel: "discord",
          to: "channel:1",
        }),
        requesterSessionKey: "agent:main:discord:direct:123",
      }),
    );
  });
});
