import crypto from "node:crypto";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../../tasks/task-executor.js";
import { sendMessage } from "../../tasks/task-registry-delivery-runtime.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { type AgentInternalEvent, formatAgentInternalEventsForPrompt } from "../internal-events.js";
import { deliverSubagentAnnouncement } from "../subagent-announce-delivery.js";

const log = createSubsystemLogger("agents/tools/media-generate-background-shared");

export interface MediaGenerationTaskHandle {
  taskId: string;
  runId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  taskLabel: string;
}

interface CreateMediaGenerationTaskRunParams {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
}

interface RecordMediaGenerationTaskProgressParams {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}

interface CompleteMediaGenerationTaskRunParams {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
}

interface FailMediaGenerationTaskRunParams {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
}

interface WakeMediaGenerationTaskCompletionParams {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
}

export function createMediaGenerationTaskRun(params: {
  sessionKey?: string;
  requesterOrigin?: DeliveryContext;
  prompt: string;
  providerId?: string;
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
}): MediaGenerationTaskHandle | null {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const runId = `tool:${params.toolName}:${crypto.randomUUID()}`;
  try {
    const task = createRunningTaskRun({
      childSessionKey: sessionKey,
      deliveryStatus: "not_applicable",
      label: params.label,
      lastEventAt: Date.now(),
      notifyPolicy: "silent",
      ownerKey: sessionKey,
      progressSummary: params.queuedProgressSummary,
      requesterOrigin: params.requesterOrigin,
      requesterSessionKey: sessionKey,
      runId,
      runtime: "cli",
      scopeKind: "session",
      sourceId: params.providerId ? `${params.toolName}:${params.providerId}` : params.toolName,
      startedAt: Date.now(),
      task: params.prompt,
      taskKind: params.taskKind,
    });
    return {
      requesterOrigin: params.requesterOrigin,
      requesterSessionKey: sessionKey,
      runId,
      taskId: task.taskId,
      taskLabel: params.prompt,
    };
  } catch (error) {
    log.warn("Failed to create media generation task ledger record", {
      error,
      providerId: params.providerId,
      sessionKey,
      toolName: params.toolName,
    });
    return null;
  }
}

export function recordMediaGenerationTaskProgress(params: {
  handle: MediaGenerationTaskHandle | null;
  progressSummary: string;
  eventSummary?: string;
}) {
  if (!params.handle) {
    return;
  }
  recordTaskRunProgressByRunId({
    eventSummary: params.eventSummary,
    lastEventAt: Date.now(),
    progressSummary: params.progressSummary,
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
  });
}

export function completeMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  provider: string;
  model: string;
  count: number;
  paths: string[];
  generatedLabel: string;
}) {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const target = params.count === 1 ? params.paths[0] : `${params.count} files`;
  completeTaskRunByRunId({
    endedAt,
    lastEventAt: endedAt,
    progressSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"}`,
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    terminalSummary: `Generated ${params.count} ${params.generatedLabel}${params.count === 1 ? "" : "s"} with ${params.provider}/${params.model}${target ? ` -> ${target}` : ""}.`,
  });
}

export function failMediaGenerationTaskRun(params: {
  handle: MediaGenerationTaskHandle | null;
  error: unknown;
  progressSummary: string;
}) {
  if (!params.handle) {
    return;
  }
  const endedAt = Date.now();
  const errorText = formatErrorMessage(params.error);
  failTaskRunByRunId({
    endedAt,
    error: errorText,
    lastEventAt: endedAt,
    progressSummary: params.progressSummary,
    runId: params.handle.runId,
    runtime: "cli",
    sessionKey: params.handle.requesterSessionKey,
    terminalSummary: errorText,
  });
}

function buildMediaGenerationReplyInstruction(params: {
  status: "ok" | "error";
  completionLabel: string;
}) {
  if (params.status === "ok") {
    return [
      `A completed ${params.completionLabel} generation task is ready for user delivery.`,
      `Prefer the message tool for delivery: use action="send" to the current/original chat, put your user-facing caption in message, attach each generated file with path/filePath using the exact path from the result, then reply ONLY: ${SILENT_REPLY_TOKEN}.`,
      `If you cannot use the message tool, reply in your normal assistant voice and include the exact MEDIA: lines from the result so OpenClaw attaches the finished ${params.completionLabel}.`,
      "Keep internal task/session details private and do not copy the internal event text verbatim.",
    ].join(" ");
  }
  return [
    `${params.completionLabel[0]?.toUpperCase() ?? "T"}${params.completionLabel.slice(1)} generation task failed.`,
    "Reply in your normal assistant voice with the failure summary now.",
    "Keep internal task/session details private and do not copy the internal event text verbatim.",
  ].join(" ");
}

function isAsyncMediaDirectSendEnabled(config: OpenClawConfig | undefined): boolean {
  return config?.tools?.media?.asyncCompletion?.directSend === true;
}

async function maybeDeliverMediaGenerationResultDirectly(params: {
  handle: MediaGenerationTaskHandle;
  status: "ok" | "error";
  result: string;
  idempotencyKey: string;
}): Promise<boolean> {
  const origin = params.handle.requesterOrigin;
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  if (!channel || !to) {
    return false;
  }
  const parsed = parseReplyDirectives(params.result);
  const content = parsed.text.trim();
  const mediaUrls = parsed.mediaUrls?.filter((entry) => entry.trim().length > 0);
  const requesterAgentId = parseAgentSessionKey(params.handle.requesterSessionKey)?.agentId;
  await sendMessage({
    channel,
    to,
    accountId: origin?.accountId,
    threadId: origin?.threadId,
    content:
      content ||
      (params.status === "ok"
        ? `Finished ${params.handle.taskLabel}.`
        : "Background media generation failed."),
    ...(mediaUrls?.length ? { mediaUrls } : {}),
    agentId: requesterAgentId,
    idempotencyKey: params.idempotencyKey,
    mirror: {
      agentId: requesterAgentId,
      idempotencyKey: params.idempotencyKey,
      sessionKey: params.handle.requesterSessionKey,
    },
  });
  return true;
}

export async function wakeMediaGenerationTaskCompletion(params: {
  config?: OpenClawConfig;
  handle: MediaGenerationTaskHandle | null;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  toolName: string;
  completionLabel: string;
}) {
  if (!params.handle) {
    return;
  }
  const announceId = `${params.toolName}:${params.handle.taskId}:${params.status}`;
  if (isAsyncMediaDirectSendEnabled(params.config)) {
    try {
      const deliveredDirect = await maybeDeliverMediaGenerationResultDirectly({
        handle: params.handle,
        idempotencyKey: announceId,
        result: params.result,
        status: params.status,
      });
      if (deliveredDirect) {
        return;
      }
    } catch (error) {
      log.warn("Media generation direct completion delivery failed; falling back to announce", {
        error,
        runId: params.handle.runId,
        taskId: params.handle.taskId,
        toolName: params.toolName,
      });
    }
  }
  const internalEvents: AgentInternalEvent[] = [
    {
      type: "task_completion",
      source: params.eventSource,
      childSessionKey: `${params.toolName}:${params.handle.taskId}`,
      childSessionId: params.handle.taskId,
      announceType: params.announceType,
      taskLabel: params.handle.taskLabel,
      status: params.status,
      statusLabel: params.statusLabel,
      result: params.result,
      ...(params.mediaUrls?.length ? { mediaUrls: params.mediaUrls } : {}),
      ...(params.statsLine?.trim() ? { statsLine: params.statsLine } : {}),
      replyInstruction: buildMediaGenerationReplyInstruction({
        completionLabel: params.completionLabel,
        status: params.status,
      }),
    },
  ];
  const triggerMessage =
    formatAgentInternalEventsForPrompt(internalEvents) ||
    `A ${params.completionLabel} generation task finished. Process the completion update now.`;
  const delivery = await deliverSubagentAnnouncement({
    announceId,
    bestEffortDeliver: true,
    completionDirectOrigin: params.handle.requesterOrigin,
    directIdempotencyKey: announceId,
    directOrigin: params.handle.requesterOrigin,
    expectsCompletionMessage: true,
    internalEvents,
    requesterIsSubagent: false,
    requesterOrigin: params.handle.requesterOrigin,
    requesterSessionKey: params.handle.requesterSessionKey,
    requesterSessionOrigin: params.handle.requesterOrigin,
    sourceChannel: INTERNAL_MESSAGE_CHANNEL,
    sourceSessionKey: `${params.toolName}:${params.handle.taskId}`,
    sourceTool: params.toolName,
    steerMessage: triggerMessage,
    summaryLine: params.handle.taskLabel,
    targetRequesterSessionKey: params.handle.requesterSessionKey,
    triggerMessage,
  });
  if (!delivery.delivered && delivery.error) {
    log.warn("Media generation completion wake failed", {
      error: delivery.error,
      runId: params.handle.runId,
      taskId: params.handle.taskId,
      toolName: params.toolName,
    });
  }
}

export function createMediaGenerationTaskLifecycle(params: {
  toolName: string;
  taskKind: string;
  label: string;
  queuedProgressSummary: string;
  generatedLabel: string;
  failureProgressSummary: string;
  eventSource: AgentInternalEvent["source"];
  announceType: string;
  completionLabel: string;
}) {
  return {
    completeTaskRun(completionParams: CompleteMediaGenerationTaskRunParams) {
      completeMediaGenerationTaskRun({
        ...completionParams,
        generatedLabel: params.generatedLabel,
      });
    },

    createTaskRun(runParams: CreateMediaGenerationTaskRunParams): MediaGenerationTaskHandle | null {
      return createMediaGenerationTaskRun({
        ...runParams,
        label: params.label,
        queuedProgressSummary: params.queuedProgressSummary,
        taskKind: params.taskKind,
        toolName: params.toolName,
      });
    },

    failTaskRun(failureParams: FailMediaGenerationTaskRunParams) {
      failMediaGenerationTaskRun({
        ...failureParams,
        progressSummary: params.failureProgressSummary,
      });
    },

    recordTaskProgress(progressParams: RecordMediaGenerationTaskProgressParams) {
      recordMediaGenerationTaskProgress(progressParams);
    },

    async wakeTaskCompletion(completionParams: WakeMediaGenerationTaskCompletionParams) {
      await wakeMediaGenerationTaskCompletion({
        ...completionParams,
        announceType: params.announceType,
        completionLabel: params.completionLabel,
        eventSource: params.eventSource,
        toolName: params.toolName,
      });
    },
  };
}
