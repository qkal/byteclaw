import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { SessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import {
  type GatewaySessionRow,
  attachOpenClawTranscriptMeta,
  loadGatewaySessionRow,
  loadSessionEntry,
  readSessionMessages,
} from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  includeSession?: boolean;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  return {
    ...(params.includeSession ? { session: sessionRow } : {}),
    abortedLastRun: sessionRow.abortedLastRun,
    channel: sessionRow.channel,
    chatType: sessionRow.chatType,
    childSessions: sessionRow.childSessions,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    contextTokens: sessionRow.contextTokens,
    deliveryContext: sessionRow.deliveryContext,
    displayName: params.displayName ?? sessionRow.displayName,
    elevatedLevel: sessionRow.elevatedLevel,
    endedAt: sessionRow.endedAt,
    estimatedCostUsd: sessionRow.estimatedCostUsd,
    fastMode: sessionRow.fastMode,
    forkedFromParent: sessionRow.forkedFromParent,
    groupChannel: sessionRow.groupChannel,
    inputTokens: sessionRow.inputTokens,
    kind: sessionRow.kind,
    label: params.label ?? sessionRow.label,
    lastAccountId: sessionRow.lastAccountId,
    lastChannel: sessionRow.lastChannel,
    lastThreadId: sessionRow.lastThreadId,
    lastTo: sessionRow.lastTo,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
    model: sessionRow.model,
    modelProvider: sessionRow.modelProvider,
    origin: sessionRow.origin,
    outputTokens: sessionRow.outputTokens,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    reasoningLevel: sessionRow.reasoningLevel,
    responseUsage: sessionRow.responseUsage,
    runtimeMs: sessionRow.runtimeMs,
    sendPolicy: sessionRow.sendPolicy,
    sessionId: sessionRow.sessionId,
    space: sessionRow.space,
    spawnDepth: sessionRow.spawnDepth,
    spawnedBy: sessionRow.spawnedBy,
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    startedAt: sessionRow.startedAt,
    status: sessionRow.status,
    subagentControlScope: sessionRow.subagentControlScope,
    subagentRole: sessionRow.subagentRole,
    subject: sessionRow.subject,
    systemSent: sessionRow.systemSent,
    thinkingLevel: sessionRow.thinkingLevel,
    totalTokens: sessionRow.totalTokens,
    totalTokensFresh: sessionRow.totalTokensFresh,
    updatedAt: sessionRow.updatedAt ?? undefined,
    verboseLevel: sessionRow.verboseLevel,
  };
}

export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
}) {
  return (update: SessionTranscriptUpdate): void => {
    const sessionKey = update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
    if (!sessionKey || update.message === undefined) {
      return;
    }
    const connIds = new Set<string>();
    for (const connId of params.sessionEventSubscribers.getAll()) {
      connIds.add(connId);
    }
    for (const connId of params.sessionMessageSubscribers.get(sessionKey)) {
      connIds.add(connId);
    }
    if (connIds.size === 0) {
      return;
    }
    const { entry, storePath } = loadSessionEntry(sessionKey);
    const messageSeq = entry?.sessionId
      ? readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length
      : undefined;
    const sessionSnapshot = buildGatewaySessionSnapshot({
      includeSession: true,
      sessionRow: loadGatewaySessionRow(sessionKey),
    });
    const message = attachOpenClawTranscriptMeta(update.message, {
      ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
      ...(typeof messageSeq === "number" ? { seq: messageSeq } : {}),
    });
    params.broadcastToConnIds(
      "session.message",
      {
        message,
        sessionKey,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
        ...sessionSnapshot,
      },
      connIds,
      { dropIfSlow: true },
    );

    const sessionEventConnIds = params.sessionEventSubscribers.getAll();
    if (sessionEventConnIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        phase: "message",
        sessionKey,
        ts: Date.now(),
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
        ...sessionSnapshot,
      },
      sessionEventConnIds,
      { dropIfSlow: true },
    );
  };
}

export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
}) {
  return (event: SessionLifecycleEvent): void => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (connIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        displayName: event.displayName,
        label: event.label,
        parentSessionKey: event.parentSessionKey,
        reason: event.reason,
        sessionKey: event.sessionKey,
        ts: Date.now(),
        ...buildGatewaySessionSnapshot({
          displayName: event.displayName,
          label: event.label,
          parentSessionKey: event.parentSessionKey,
          sessionRow: loadGatewaySessionRow(event.sessionKey),
        }),
      },
      connIds,
      { dropIfSlow: true },
    );
  };
}
