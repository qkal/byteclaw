import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
  PluginHookSessionStartEvent,
} from "../../plugins/types.js";

export interface SessionHookContext {
  sessionId: string;
  sessionKey: string;
  agentId: string;
}

function buildSessionHookContext(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
}): SessionHookContext {
  return {
    agentId: resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey }),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
}

export function buildSessionStartHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
  resumedFrom?: string;
}): {
  event: PluginHookSessionStartEvent;
  context: SessionHookContext;
} {
  return {
    context: buildSessionHookContext({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    event: {
      resumedFrom: params.resumedFrom,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    },
  };
}

export function buildSessionEndHookPayload(params: {
  sessionId: string;
  sessionKey: string;
  cfg: OpenClawConfig;
  messageCount?: number;
  durationMs?: number;
  reason?: PluginHookSessionEndReason;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
}): {
  event: PluginHookSessionEndEvent;
  context: SessionHookContext;
} {
  return {
    context: buildSessionHookContext({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
    event: {
      durationMs: params.durationMs,
      messageCount: params.messageCount ?? 0,
      nextSessionId: params.nextSessionId,
      nextSessionKey: params.nextSessionKey,
      reason: params.reason,
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      transcriptArchived: params.transcriptArchived,
    },
  };
}
