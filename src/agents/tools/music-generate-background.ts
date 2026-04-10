import type { OpenClawConfig } from "../../config/config.js";
import { MUSIC_GENERATION_TASK_KIND } from "../music-generation-task-status.js";
import {
  type MediaGenerationTaskHandle,
  createMediaGenerationTaskLifecycle,
} from "./media-generate-background-shared.js";

export type MusicGenerationTaskHandle = MediaGenerationTaskHandle;

const musicGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  announceType: "music generation task",
  completionLabel: "music",
  eventSource: "music_generation",
  failureProgressSummary: "Music generation failed",
  generatedLabel: "track",
  label: "Music generation",
  queuedProgressSummary: "Queued music generation",
  taskKind: MUSIC_GENERATION_TASK_KIND,
  toolName: "music_generate",
});

export const createMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.createTaskRun>
) => musicGenerationTaskLifecycle.createTaskRun(...params);

export const recordMusicGenerationTaskProgress = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.recordTaskProgress>
) => musicGenerationTaskLifecycle.recordTaskProgress(...params);

export const completeMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.completeTaskRun>
) => musicGenerationTaskLifecycle.completeTaskRun(...params);

export const failMusicGenerationTaskRun = (
  ...params: Parameters<typeof musicGenerationTaskLifecycle.failTaskRun>
) => musicGenerationTaskLifecycle.failTaskRun(...params);

export async function wakeMusicGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MusicGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await musicGenerationTaskLifecycle.wakeTaskCompletion(params);
}
