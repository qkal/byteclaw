import type { OpenClawConfig } from "../../config/config.js";
import { VIDEO_GENERATION_TASK_KIND } from "../video-generation-task-status.js";
import {
  type MediaGenerationTaskHandle,
  createMediaGenerationTaskLifecycle,
} from "./media-generate-background-shared.js";

export type VideoGenerationTaskHandle = MediaGenerationTaskHandle;

const videoGenerationTaskLifecycle = createMediaGenerationTaskLifecycle({
  announceType: "video generation task",
  completionLabel: "video",
  eventSource: "video_generation",
  failureProgressSummary: "Video generation failed",
  generatedLabel: "video",
  label: "Video generation",
  queuedProgressSummary: "Queued video generation",
  taskKind: VIDEO_GENERATION_TASK_KIND,
  toolName: "video_generate",
});

export const createVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.createTaskRun>
) => videoGenerationTaskLifecycle.createTaskRun(...params);

export const recordVideoGenerationTaskProgress = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.recordTaskProgress>
) => videoGenerationTaskLifecycle.recordTaskProgress(...params);

export const completeVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.completeTaskRun>
) => videoGenerationTaskLifecycle.completeTaskRun(...params);

export const failVideoGenerationTaskRun = (
  ...params: Parameters<typeof videoGenerationTaskLifecycle.failTaskRun>
) => videoGenerationTaskLifecycle.failTaskRun(...params);

export async function wakeVideoGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: VideoGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}) {
  await videoGenerationTaskLifecycle.wakeTaskCompletion(params);
}
