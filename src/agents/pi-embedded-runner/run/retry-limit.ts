import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "../types.js";
import type { RetryLimitFailoverDecision } from "./failover-policy.js";

export function handleRetryLimitExhaustion(params: {
  message: string;
  decision: RetryLimitFailoverDecision;
  provider: string;
  model: string;
  profileId?: string;
  durationMs: number;
  agentMeta: EmbeddedPiAgentMeta;
}): EmbeddedPiRunResult {
  if (params.decision.action === "fallback_model") {
    throw new FailoverError(params.message, {
      model: params.model,
      profileId: params.profileId,
      provider: params.provider,
      reason: params.decision.reason,
      status: resolveFailoverStatus(params.decision.reason),
    });
  }

  return {
    meta: {
      agentMeta: params.agentMeta,
      durationMs: params.durationMs,
      error: { kind: "retry_limit", message: params.message },
    },
    payloads: [
      {
        isError: true,
        text:
          "Request failed after repeated internal retries. " +
          "Please try again, or use /new to start a fresh session.",
      },
    ],
  };
}
