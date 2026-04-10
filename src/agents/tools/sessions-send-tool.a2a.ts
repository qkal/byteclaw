import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = typeof callGateway;

const defaultSessionsSendA2ADeps = {
  callGateway,
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
} = defaultSessionsSendA2ADeps;

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        callGateway: sessionsSendA2ADeps.callGateway,
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
      });
      if (wait.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      displayKey: params.displayKey,
      sessionKey: params.targetSessionKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          currentRole,
          maxTurns: params.maxPingPongTurns,
          requesterChannel: params.requesterChannel,
          requesterSessionKey: params.requesterSessionKey,
          targetChannel,
          targetSessionKey: params.displayKey,
          turn,
        });
        const replyText = await runAgentStep({
          extraSystemPrompt: replyPrompt,
          lane: AGENT_LANE_NESTED,
          message: incomingMessage,
          sessionKey: currentSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceSessionKey: nextSessionKey,
          sourceTool: "sessions_send",
          timeoutMs: params.announceTimeoutMs,
        });
        if (!replyText || isReplySkip(replyText)) {
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      latestReply,
      originalMessage: params.message,
      requesterChannel: params.requesterChannel,
      requesterSessionKey: params.requesterSessionKey,
      roundOneReply: primaryReply,
      targetChannel,
      targetSessionKey: params.displayKey,
    });
    const announceReply = await runAgentStep({
      extraSystemPrompt: announcePrompt,
      lane: AGENT_LANE_NESTED,
      message: "Agent-to-agent announce step.",
      sessionKey: params.targetSessionKey,
      sourceChannel: params.requesterChannel,
      sourceSessionKey: params.requesterSessionKey,
      sourceTool: "sessions_send",
      timeoutMs: params.announceTimeoutMs,
    });
    if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
      try {
        await sessionsSendA2ADeps.callGateway({
          method: "send",
          params: {
            accountId: announceTarget.accountId,
            channel: announceTarget.channel,
            idempotencyKey: crypto.randomUUID(),
            message: announceReply.trim(),
            threadId: announceTarget.threadId,
            to: announceTarget.to,
          },
          timeoutMs: 10_000,
        });
      } catch (error) {
        log.warn("sessions_send announce delivery failed", {
          channel: announceTarget.channel,
          error: formatErrorMessage(error),
          runId: runContextId,
          to: announceTarget.to,
        });
      }
    }
  } catch (error) {
    log.warn("sessions_send announce flow failed", {
      error: formatErrorMessage(error),
      runId: runContextId,
    });
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};
