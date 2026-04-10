import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildActiveMediaGenerationTaskPromptContextForSession,
  buildMediaGenerationTaskStatusDetails,
  buildMediaGenerationTaskStatusText,
  findActiveMediaGenerationTaskForSession,
  getMediaGenerationTaskProviderId,
  isActiveMediaGenerationTask,
} from "./media-generation-task-status-shared.js";

export const MUSIC_GENERATION_TASK_KIND = "music_generation";
const MUSIC_GENERATION_SOURCE_PREFIX = "music_generate";

export function isActiveMusicGenerationTask(task: TaskRecord): boolean {
  return isActiveMediaGenerationTask({
    task,
    taskKind: MUSIC_GENERATION_TASK_KIND,
  });
}

export function getMusicGenerationTaskProviderId(task: TaskRecord): string | undefined {
  return getMediaGenerationTaskProviderId(task, MUSIC_GENERATION_SOURCE_PREFIX);
}

export function findActiveMusicGenerationTaskForSession(
  sessionKey?: string,
): TaskRecord | undefined {
  return findActiveMediaGenerationTaskForSession({
    sessionKey,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    taskKind: MUSIC_GENERATION_TASK_KIND,
  });
}

export function buildMusicGenerationTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return buildMediaGenerationTaskStatusDetails({
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    task,
  });
}

export function buildMusicGenerationTaskStatusText(
  task: TaskRecord,
  params?: { duplicateGuard?: boolean },
): string {
  return buildMediaGenerationTaskStatusText({
    completionLabel: "music",
    duplicateGuard: params?.duplicateGuard,
    nounLabel: "Music generation",
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    task,
    toolName: "music_generate",
  });
}

export function buildActiveMusicGenerationTaskPromptContextForSession(
  sessionKey?: string,
): string | undefined {
  return buildActiveMediaGenerationTaskPromptContextForSession({
    completionLabel: "music tracks",
    nounLabel: "Music generation",
    sessionKey,
    sourcePrefix: MUSIC_GENERATION_SOURCE_PREFIX,
    taskKind: MUSIC_GENERATION_TASK_KIND,
    toolName: "music_generate",
  });
}
