import { onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  type ChatRunState,
  type SessionEventSubscriberRegistry,
  type SessionMessageSubscriberRegistry,
  type ToolEventRecipientRegistry,
  createAgentEventHandler,
} from "./server-chat.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";

export function startGatewayEventSubscriptions(params: {
  minimalTestGateway: boolean;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, unknown>;
}) {
  const agentUnsub = params.minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          broadcastToConnIds: params.broadcastToConnIds,
          chatRunState: params.chatRunState,
          clearAgentRunContext: params.clearAgentRunContext,
          isChatSendRunActive: (runId) => params.chatAbortControllers.has(runId),
          nodeSendToSession: params.nodeSendToSession,
          resolveSessionKeyForRun: params.resolveSessionKeyForRun,
          sessionEventSubscribers: params.sessionEventSubscribers,
          toolEventRecipients: params.toolEventRecipients,
        }),
      );

  const heartbeatUnsub = params.minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        params.broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  const transcriptUnsub = params.minimalTestGateway
    ? null
    : onSessionTranscriptUpdate(
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
        }),
      );

  const lifecycleUnsub = params.minimalTestGateway
    ? null
    : onSessionLifecycleEvent(
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
        }),
      );

  return {
    agentUnsub,
    heartbeatUnsub,
    lifecycleUnsub,
    transcriptUnsub,
  };
}
