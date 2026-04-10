import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  getMediaGenerationTaskProviderId,
  isActiveMediaGenerationTask,
} from "./media-generation-task-status-shared.js";

export const VIDEO_GENERATION_TASK_KIND = "video_generation";
const VIDEO_GENERATION_SOURCE_PREFIX = "video_generate";

export function isActiveVideoGenerationTask(task: TaskRecord): boolean {
  return isActiveMediaGenerationTask({
    task,
    taskKind: VIDEO_GENERATION_TASK_KIND,
  });
}

export function getVideoGenerationTaskProviderId(task: TaskRecord): string | undefined {
  return getMediaGenerationTaskProviderId(task, VIDEO_GENERATION_SOURCE_PREFIX);
}

export function findActiveVideoGenerationTaskForSession(
  sessionKey?: string,
): TaskRecord | undefined {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    taskKind: VIDEO_GENERATION_TASK_KIND,
  });
}

export function buildVideoGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    task,
  });
}

export function buildVideoGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    completionLabel: "video",
    duplicateGuard: params?.duplicateGuard,
    nounLabel: "Video generation",
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    task,
    toolName: "video_generate",
  });
}

export function buildActiveVideoGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    completionLabel: "videos",
    nounLabel: "Video generation",
    sessionKey,
    sourcePrefix: VIDEO_GENERATION_SOURCE_PREFIX,
    taskKind: VIDEO_GENERATION_TASK_KIND,
    toolName: "video_generate",
  });
}
