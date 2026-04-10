import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/config.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import {
  type FailoverReason,
  formatAssistantErrorText,
  formatBillingErrorMessage,
  isTimeoutErrorMessage,
} from "../../pi-embedded-helpers.js";
import {
  type AssistantFailoverDecision,
  mergeRetryFailoverReason,
  resolveRunFailoverDecision,
} from "./failover-policy.js";

type AssistantFailoverOutcome =
  | {
      action: "continue_normal";
      overloadProfileRotations: number;
    }
  | {
      action: "retry";
      overloadProfileRotations: number;
      lastRetryFailoverReason: FailoverReason | null;
      retryKind?: "same_model_idle_timeout";
    }
  | {
      action: "throw";
      overloadProfileRotations: number;
      error: FailoverError;
    };

export async function handleAssistantFailover(params: {
  initialDecision: AssistantFailoverDecision;
  aborted: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  allowSameModelIdleTimeoutRetry: boolean;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
  lastProfileId?: string;
  modelId: string;
  provider: string;
  activeErrorContext: { provider: string; model: string };
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  authFailure: boolean;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  cloudCodeAssistFormatError: boolean;
  isProbeSession: boolean;
  overloadProfileRotations: number;
  overloadProfileRotationLimit: number;
  previousRetryFailoverReason: FailoverReason | null;
  logAssistantFailoverDecision: (
    decision: "rotate_profile" | "fallback_model" | "surface_error",
    extra?: { status?: number },
  ) => void;
  warn: (message: string) => void;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeEscalateRateLimitProfileFallback: (params: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
  }) => void;
  maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
  advanceAuthProfile: () => Promise<boolean>;
}): Promise<AssistantFailoverOutcome> {
  let { overloadProfileRotations } = params;
  let decision = params.initialDecision;
  const sameModelIdleTimeoutRetry = (): AssistantFailoverOutcome => {
    params.warn(
      `[llm-idle-timeout] ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} produced no reply before the idle watchdog; retrying same model`,
    );
    return {
      action: "retry",
      lastRetryFailoverReason: mergeRetryFailoverReason({
        failoverReason: params.failoverReason,
        previous: params.previousRetryFailoverReason,
        timedOut: true,
      }),
      overloadProfileRotations,
      retryKind: "same_model_idle_timeout",
    };
  };

  if (decision.action === "rotate_profile") {
    if (params.lastProfileId) {
      const reason = params.timedOut ? "timeout" : params.assistantProfileFailureReason;
      await params.maybeMarkAuthProfileFailure({
        modelId: params.modelId,
        profileId: params.lastProfileId,
        reason,
      });
      if (params.timedOut && !params.isProbeSession) {
        params.warn(`Profile ${params.lastProfileId} timed out. Trying next account...`);
      }
      if (params.cloudCodeAssistFormatError) {
        params.warn(
          `Profile ${params.lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
        );
      }
    }

    if (params.failoverReason === "overloaded") {
      overloadProfileRotations += 1;
      if (
        overloadProfileRotations > params.overloadProfileRotationLimit &&
        params.fallbackConfigured
      ) {
        const status = resolveFailoverStatus("overloaded");
        params.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        params.logAssistantFailoverDecision("fallback_model", { status });
        return {
          action: "throw",
          error: new FailoverError(
            "The AI service is temporarily overloaded. Please try again in a moment.",
            {
              model: params.activeErrorContext.model,
              profileId: params.lastProfileId,
              provider: params.activeErrorContext.provider,
              reason: "overloaded",
              status,
            },
          ),
          overloadProfileRotations,
        };
      }
    }

    if (params.failoverReason === "rate_limit") {
      params.maybeEscalateRateLimitProfileFallback({
        failoverModel: params.activeErrorContext.model,
        failoverProvider: params.activeErrorContext.provider,
        logFallbackDecision: params.logAssistantFailoverDecision,
      });
    }

    const rotated = await params.advanceAuthProfile();
    if (rotated) {
      params.logAssistantFailoverDecision("rotate_profile");
      await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
      return {
        action: "retry",
        lastRetryFailoverReason: mergeRetryFailoverReason({
          failoverReason: params.failoverReason,
          previous: params.previousRetryFailoverReason,
          timedOut: params.timedOut,
        }),
        overloadProfileRotations,
      };
    }
    if (params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }

    decision = resolveRunFailoverDecision({
      aborted: params.aborted,
      failoverFailure: params.failoverFailure,
      failoverReason: params.failoverReason,
      fallbackConfigured: params.fallbackConfigured,
      profileRotated: true,
      stage: "assistant",
      timedOut: params.timedOut,
      timedOutDuringCompaction: params.timedOutDuringCompaction,
    });
  }

  if (decision.action === "fallback_model") {
    await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
    const message =
      (params.lastAssistant
        ? formatAssistantErrorText(params.lastAssistant, {
            cfg: params.config,
            model: params.activeErrorContext.model,
            provider: params.activeErrorContext.provider,
            sessionKey: params.sessionKey,
          })
        : undefined) ||
      params.lastAssistant?.errorMessage?.trim() ||
      (params.timedOut
        ? "LLM request timed out."
        : params.rateLimitFailure
          ? "LLM request rate limited."
          : params.billingFailure
            ? formatBillingErrorMessage(
                params.activeErrorContext.provider,
                params.activeErrorContext.model,
              )
            : params.authFailure
              ? "LLM request unauthorized."
              : "LLM request failed.");
    const status =
      resolveFailoverStatus(decision.reason) ?? (isTimeoutErrorMessage(message) ? 408 : undefined);
    params.logAssistantFailoverDecision("fallback_model", { status });
    return {
      action: "throw",
      error: new FailoverError(message, {
        model: params.activeErrorContext.model,
        profileId: params.lastProfileId,
        provider: params.activeErrorContext.provider,
        reason: decision.reason,
        status,
      }),
      overloadProfileRotations,
    };
  }

  if (decision.action === "surface_error") {
    if (params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }
    params.logAssistantFailoverDecision("surface_error");
  }

  return {
    action: "continue_normal",
    overloadProfileRotations,
  };
}
