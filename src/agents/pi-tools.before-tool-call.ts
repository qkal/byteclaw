import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { type PluginApprovalResolution, PluginApprovalResolutions } from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { isPlainObject } from "../utils.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export interface HookContext {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  loopDetection?: ToolLoopDetectionConfig;
}

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./pi-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

function unwrapErrorCause(err: unknown): unknown {
  if (err instanceof Error && err.cause !== undefined) {
    return err.cause;
  }
  return err;
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionId: args.ctx?.agentId,
      sessionKey: args.ctx.sessionKey,
    });
    recordToolCallOutcome(sessionState, {
      config: args.ctx.loopDetection,
      error: args.error,
      result: args.result,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      toolParams: args.toolParams,
    });
  } catch (error) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(error)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const { params } = args;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionId: args.ctx?.agentId,
      sessionKey: args.ctx.sessionKey,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          action: "block",
          count: loopResult.count,
          detector: loopResult.detector,
          level: "critical",
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
          sessionId: args.ctx?.agentId,
          sessionKey: args.ctx.sessionKey,
          toolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            action: "warn",
            count: loopResult.count,
            detector: loopResult.detector,
            level: "warning",
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
            sessionId: args.ctx?.agentId,
            sessionKey: args.ctx.sessionKey,
            toolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        params: normalizedParams,
        toolName,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.requireApproval) {
      const approval = hookResult.requireApproval;
      const safeOnResolution = (resolution: PluginApprovalResolution): void => {
        const { onResolution } = approval;
        if (typeof onResolution !== "function") {
          return;
        }
        try {
          void Promise.resolve(onResolution(resolution)).catch((error) => {
            log.warn(`plugin onResolution callback failed: ${String(error)}`);
          });
        } catch (error) {
          log.warn(`plugin onResolution callback failed: ${String(error)}`);
        }
      };
      try {
        const requestResult = await callGatewayTool<{
          id?: string;
          status?: string;
          decision?: string | null;
        }>(
          "plugin.approval.request",
          // Buffer beyond the approval timeout so the gateway can clean up
          // And respond before the client-side RPC timeout fires.
          { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
          {
            agentId: args.ctx?.agentId,
            description: approval.description,
            pluginId: approval.pluginId,
            sessionKey: args.ctx?.sessionKey,
            severity: approval.severity,
            timeoutMs: approval.timeoutMs ?? 120_000,
            title: approval.title,
            toolCallId: args.toolCallId,
            toolName,
            twoPhase: true,
          },
          { expectFinal: false },
        );
        const id = requestResult?.id;
        if (!id) {
          safeOnResolution(PluginApprovalResolutions.CANCELLED);
          return {
            blocked: true,
            reason: approval.description || "Plugin approval request failed",
          };
        }
        const hasImmediateDecision = Object.hasOwn(requestResult ?? {}, "decision");
        let decision: string | null | undefined;
        if (hasImmediateDecision) {
          decision = requestResult?.decision;
          if (decision === null) {
            safeOnResolution(PluginApprovalResolutions.CANCELLED);
            return {
              blocked: true,
              reason: "Plugin approval unavailable (no approval route)",
            };
          }
        } else {
          // Wait for the decision, but abort early if the agent run is cancelled
          // So the user isn't blocked for the full approval timeout.
          const waitPromise = callGatewayTool<{
            id?: string;
            decision?: string | null;
          }>(
            "plugin.approval.waitDecision",
            // Buffer beyond the approval timeout so the gateway can clean up
            // And respond before the client-side RPC timeout fires.
            { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
            { id },
          );
          let waitResult: { id?: string; decision?: string | null } | undefined;
          if (args.signal) {
            let onAbort: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              if (args.signal!.aborted) {
                reject(args.signal!.reason);
                return;
              }
              onAbort = () => reject(args.signal!.reason);
              args.signal!.addEventListener("abort", onAbort, { once: true });
            });
            try {
              waitResult = await Promise.race([waitPromise, abortPromise]);
            } finally {
              if (onAbort) {
                args.signal.removeEventListener("abort", onAbort);
              }
            }
          } else {
            waitResult = await waitPromise;
          }
          decision = waitResult?.decision;
        }
        const resolution: PluginApprovalResolution =
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
          decision === PluginApprovalResolutions.DENY
            ? decision
            : PluginApprovalResolutions.TIMEOUT;
        safeOnResolution(resolution);
        if (
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS
        ) {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        if (decision === PluginApprovalResolutions.DENY) {
          return { blocked: true, reason: "Denied by user" };
        }
        const timeoutBehavior = approval.timeoutBehavior ?? "deny";
        if (timeoutBehavior === "allow") {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        return { blocked: true, reason: "Approval timed out" };
      } catch (error) {
        safeOnResolution(PluginApprovalResolutions.CANCELLED);
        if (isAbortSignalCancellation(error, args.signal)) {
          log.warn(`plugin approval wait cancelled by run abort: ${String(error)}`);
          return {
            blocked: true,
            reason: "Approval cancelled (run aborted)",
          };
        }
        log.warn(`plugin approval gateway request failed, falling back to block: ${String(error)}`);
        return {
          blocked: true,
          reason: "Plugin approval required (gateway unavailable)",
        };
      }
    }

    if (hookResult?.params) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params, hookResult.params),
      };
    }
  } catch (error) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(error);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
    };
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const { execute } = tool;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        ctx,
        params,
        signal,
        toolCallId,
        toolName,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          result,
          toolCallId,
          toolName: normalizedToolName,
          toolParams: outcome.params,
        });
        return result;
      } catch (error) {
        await recordLoopOutcome({
          ctx,
          error: error,
          toolCallId,
          toolName: normalizedToolName,
          toolParams: outcome.params,
        });
        throw error;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    enumerable: true,
    value: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  isPlainObject,
  mergeParamsWithApprovalOverrides,
  runBeforeToolCallHook,
};
