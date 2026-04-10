import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import {
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  describeSessionsSendTool,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { buildAgentToAgentMessageContext, resolvePingPongTurns } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const SessionsSendToolSchema = Type.Object({
  agentId: Type.Optional(Type.String({ maxLength: 64, minLength: 1 })),
  label: Type.Optional(Type.String({ maxLength: SESSION_LABEL_MAX_LENGTH, minLength: 1 })),
  message: Type.String(),
  sessionKey: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
}): Promise<{ ok: true; runId: string } | { ok: false; result: ReturnType<typeof jsonResult> }> {
  try {
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : typeof error === "string" ? error : "error";
    return {
      ok: false,
      result: jsonResult({
        error: messageText,
        runId: params.runId,
        sessionKey: params.sessionKey,
        status: "error",
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    description: describeSessionsSendTool(),
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const labelParam = normalizeOptionalString(readStringParam(params, "label"));
      const labelAgentIdParam = normalizeOptionalString(readStringParam(params, "agentId"));
      if (sessionKeyParam && labelParam) {
        return jsonResult({
          error: "Provide either sessionKey or label (not both).",
          runId: crypto.randomUUID(),
          status: "error",
        });
      }

      let sessionKey = sessionKeyParam;
      if (!sessionKey && labelParam) {
        const requesterAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
        const requestedAgentId = labelAgentIdParam
          ? normalizeAgentId(labelAgentIdParam)
          : undefined;

        if (restrictToSpawned && requestedAgentId && requestedAgentId !== requesterAgentId) {
          return jsonResult({
            error: "Sandboxed sessions_send label lookup is limited to this agent",
            runId: crypto.randomUUID(),
            status: "forbidden",
          });
        }

        if (requesterAgentId && requestedAgentId && requestedAgentId !== requesterAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
              runId: crypto.randomUUID(),
              status: "forbidden",
            });
          }
          if (!a2aPolicy.isAllowed(requesterAgentId, requestedAgentId)) {
            return jsonResult({
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
              runId: crypto.randomUUID(),
              status: "forbidden",
            });
          }
        }

        const resolveParams: Record<string, unknown> = {
          label: labelParam,
          ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey = "";
        try {
          const resolved = await gatewayCall<{ key: string }>({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          });
          resolvedKey = normalizeOptionalString(resolved?.key) ?? "";
        } catch (error) {
          const msg = formatErrorMessage(error);
          if (restrictToSpawned) {
            return jsonResult({
              error: "Session not visible from this sandboxed agent session.",
              runId: crypto.randomUUID(),
              status: "forbidden",
            });
          }
          return jsonResult({
            error: msg || `No session found with label: ${labelParam}`,
            runId: crypto.randomUUID(),
            status: "error",
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              error: "Session not visible from this sandboxed agent session.",
              runId: crypto.randomUUID(),
              status: "forbidden",
            });
          }
          return jsonResult({
            error: `No session found with label: ${labelParam}`,
            runId: crypto.randomUUID(),
            status: "error",
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          error: "Either sessionKey or label is required",
          runId: crypto.randomUUID(),
          status: "error",
        });
      }
      const resolvedSession = await resolveSessionReference({
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
        sessionKey,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          error: resolvedSession.error,
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        requesterSessionKey: effectiveRequesterKey,
        resolvedSession,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      if (!visibleSession.ok) {
        return jsonResult({
          error: visibleSession.error,
          runId: crypto.randomUUID(),
          sessionKey: visibleSession.displayKey,
          status: visibleSession.status,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      const resolvedKey = visibleSession.key;
      const { displayKey } = visibleSession;
      const timeoutSeconds =
        typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)
          ? Math.max(0, Math.floor(params.timeoutSeconds))
          : 30;
      const timeoutMs = timeoutSeconds * 1000;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      const visibilityGuard = await createSessionVisibilityGuard({
        a2aPolicy,
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        return jsonResult({
          error: access.error,
          runId: crypto.randomUUID(),
          sessionKey: displayKey,
          status: access.status,
        });
      }

      // Capture the pre-run assistant snapshot before starting the nested run.
      // Fast in-process test doubles and short-circuit agent paths can finish
      // Before we reach the post-run read, which would otherwise make the new
      // Reply look like the baseline and hide it from the caller.
      const baselineReply =
        timeoutSeconds === 0
          ? undefined
          : await readLatestAssistantReplySnapshot({
              callGateway: gatewayCall,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              sessionKey: resolvedKey,
            });

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterChannel: opts?.agentChannel,
        requesterSessionKey: opts?.agentSessionKey,
        targetSessionKey: displayKey,
      });
      const sendParams = {
        channel: INTERNAL_MESSAGE_CHANNEL,
        deliver: false,
        extraSystemPrompt: agentMessageContext,
        idempotencyKey,
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: opts?.agentChannel,
          sourceSessionKey: opts?.agentSessionKey,
          sourceTool: "sessions_send",
        },
        lane: AGENT_LANE_NESTED,
        message,
        sessionKey: resolvedKey,
      };
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const maxPingPongTurns = resolvePingPongTurns(cfg);
      const delivery = { mode: "announce" as const, status: "pending" };
      const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
        void runSessionsSendA2AFlow({
          announceTimeoutMs,
          displayKey,
          maxPingPongTurns,
          message,
          requesterChannel,
          requesterSessionKey,
          roundOneReply,
          targetSessionKey: resolvedKey,
          waitRunId,
        });
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
        });
        if (!start.ok) {
          return start.result;
        }
        ({ runId } = start);
        startA2AFlow(undefined, runId);
        return jsonResult({
          delivery,
          runId,
          sessionKey: displayKey,
          status: "accepted",
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
      });
      if (!start.ok) {
        return start.result;
      }
      ({ runId } = start);
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        baseline: baselineReply,
        callGateway: gatewayCall,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        runId,
        sessionKey: resolvedKey,
        timeoutMs,
      });

      if (result.status === "timeout") {
        return jsonResult({
          error: result.error,
          runId,
          sessionKey: displayKey,
          status: "timeout",
        });
      }
      if (result.status === "error") {
        return jsonResult({
          error: result.error ?? "agent error",
          runId,
          sessionKey: displayKey,
          status: "error",
        });
      }
      const reply = result.replyText;
      startA2AFlow(reply ?? undefined);

      return jsonResult({
        delivery,
        reply,
        runId,
        sessionKey: displayKey,
        status: "ok",
      });
    },
    label: "Session Send",
    name: "sessions_send",
    parameters: SessionsSendToolSchema,
  };
}
