import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "../../infra/exec-approval-command-display.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
} from "../../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
} from "../../infra/system-run-approval-binding.js";
import { resolveSystemRunApprovalRequestContext } from "../../infra/system-run-approval-context.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateExecApprovalGetParams,
  validateExecApprovalRequestParams,
  validateExecApprovalResolveParams,
} from "../protocol/index.js";
import {
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalDecision,
  resolvePendingApprovalRecord,
  respondPendingApprovalLookupError,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS = {
  reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
} as const;
const RESERVED_PLUGIN_APPROVAL_ID_PREFIX = "plugin:";

interface ExecApprovalIosPushDelivery {
  handleRequested?: (request: ExecApprovalRequest) => Promise<boolean>;
  handleResolved?: (resolved: ExecApprovalResolved) => Promise<void>;
  handleExpired?: (request: ExecApprovalRequest) => Promise<void>;
}

export function createExecApprovalHandlers(
  manager: ExecApprovalManager,
  opts?: { forwarder?: ExecApprovalForwarder; iosPushDelivery?: ExecApprovalIosPushDelivery },
): GatewayRequestHandlers {
  return {
    "exec.approval.get": async ({ params, respond }) => {
      if (!validateExecApprovalGetParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.get params: ${formatValidationErrors(
              validateExecApprovalGetParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string };
      const resolved = resolvePendingApprovalRecord({
        exposeAmbiguousPrefixError: true,
        inputId: p.id,
        manager,
      });
      if (!resolved.ok) {
        respondPendingApprovalLookupError({ respond, response: resolved.response });
        return;
      }
      const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(
        resolved.snapshot.request,
      );
      respond(
        true,
        {
          agentId: resolved.snapshot.request.agentId ?? null,
          allowedDecisions: resolveExecApprovalRequestAllowedDecisions(resolved.snapshot.request),
          commandPreview,
          commandText,
          expiresAtMs: resolved.snapshot.expiresAtMs,
          host: resolved.snapshot.request.host ?? null,
          id: resolved.approvalId,
          nodeId: resolved.snapshot.request.nodeId ?? null,
        },
        undefined,
      );
    },
    "exec.approval.list": async ({ respond }) => {
      respond(
        true,
        manager.listPendingRecords().map((record) => ({
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
          id: record.id,
          request: record.request,
        })),
        undefined,
      );
    },
    "exec.approval.request": async ({ params, respond, context, client }) => {
      if (!validateExecApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.request params: ${formatValidationErrors(
              validateExecApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        id?: string;
        command: string;
        commandArgv?: string[];
        env?: Record<string, string>;
        cwd?: string;
        systemRunPlan?: unknown;
        nodeId?: string;
        host?: string;
        security?: string;
        ask?: string;
        agentId?: string;
        resolvedPath?: string;
        sessionKey?: string;
        turnSourceChannel?: string;
        turnSourceTo?: string;
        turnSourceAccountId?: string;
        turnSourceThreadId?: string | number;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs =
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
      const explicitId = normalizeOptionalString(p.id) ?? null;
      const host = normalizeOptionalString(p.host) ?? "";
      const nodeId = normalizeOptionalString(p.nodeId) ?? "";
      const approvalContext = resolveSystemRunApprovalRequestContext({
        agentId: p.agentId,
        command: p.command,
        commandArgv: p.commandArgv,
        cwd: p.cwd,
        host,
        sessionKey: p.sessionKey,
        systemRunPlan: p.systemRunPlan,
      });
      const effectiveCommandArgv = approvalContext.commandArgv;
      const effectiveCwd = approvalContext.cwd;
      const effectiveAgentId = approvalContext.agentId;
      const effectiveSessionKey = approvalContext.sessionKey;
      const effectiveCommandText = approvalContext.commandText;
      if (host === "node" && !nodeId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "nodeId is required for host=node"),
        );
        return;
      }
      if (host === "node" && !approvalContext.plan) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "systemRunPlan is required for host=node"),
        );
        return;
      }
      if (!effectiveCommandText) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "command is required"));
        return;
      }
      if (explicitId?.startsWith(RESERVED_PLUGIN_APPROVAL_ID_PREFIX)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `approval ids starting with ${RESERVED_PLUGIN_APPROVAL_ID_PREFIX} are reserved`,
          ),
        );
        return;
      }
      if (
        host === "node" &&
        (!Array.isArray(effectiveCommandArgv) || effectiveCommandArgv.length === 0)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "commandArgv is required for host=node"),
        );
        return;
      }
      const envBinding = buildSystemRunApprovalEnvBinding(p.env);
      const systemRunBinding =
        host === "node"
          ? buildSystemRunApprovalBinding({
              agentId: effectiveAgentId,
              argv: effectiveCommandArgv,
              cwd: effectiveCwd,
              env: p.env,
              sessionKey: effectiveSessionKey,
            })
          : null;
      if (explicitId && manager.getSnapshot(explicitId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "approval id already pending"),
        );
        return;
      }
      const request = {
        agentId: effectiveAgentId ?? null,
        allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: p.ask ?? null }),
        ask: p.ask ?? null,
        command: sanitizeExecApprovalDisplayText(effectiveCommandText),
        commandArgv: host === "node" ? undefined : effectiveCommandArgv,
        commandPreview:
          host === "node" || !approvalContext.commandPreview
            ? undefined
            : sanitizeExecApprovalDisplayText(approvalContext.commandPreview),
        cwd: effectiveCwd ?? null,
        envKeys: envBinding.envKeys.length > 0 ? envBinding.envKeys : undefined,
        host: host || null,
        nodeId: host === "node" ? nodeId : null,
        resolvedPath: p.resolvedPath ?? null,
        security: p.security ?? null,
        sessionKey: effectiveSessionKey ?? null,
        systemRunBinding: systemRunBinding?.binding ?? null,
        systemRunPlan: approvalContext.plan,
        turnSourceAccountId: normalizeOptionalString(p.turnSourceAccountId) ?? null,
        turnSourceChannel: normalizeOptionalString(p.turnSourceChannel) ?? null,
        turnSourceThreadId: p.turnSourceThreadId ?? null,
        turnSourceTo: normalizeOptionalString(p.turnSourceTo) ?? null,
      };
      const record = manager.create(request, timeoutMs, explicitId);
      record.requestedByConnId = client?.connId ?? null;
      record.requestedByDeviceId = client?.connect?.device?.id ?? null;
      record.requestedByClientId = client?.connect?.client?.id ?? null;
      // Use register() to synchronously add to pending map before sending any response.
      // This ensures the approval ID is valid immediately after the "accepted" response.
      let decisionPromise: Promise<
        import("../../infra/exec-approvals.js").ExecApprovalDecision | null
      >;
      try {
        decisionPromise = manager.register(record, timeoutMs);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registration failed: ${String(error)}`),
        );
        return;
      }
      const requestEvent: ExecApprovalRequest = {
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        id: record.id,
        request: record.request,
      };
      await handlePendingApprovalRequest({
        afterDecision: async (decision) => {
          if (decision === null) {
            await opts?.iosPushDelivery?.handleExpired?.(requestEvent);
          }
        },
        afterDecisionErrorLabel: "exec approvals: iOS push expire failed",
        clientConnId: client?.connId,
        context,
        decisionPromise,
        deliverRequest: () => {
          const deliveryTasks: Array<Promise<boolean>> = [];
          if (opts?.forwarder) {
            deliveryTasks.push(
              opts.forwarder.handleRequested(requestEvent).catch((err) => {
                context.logGateway?.error?.(
                  `exec approvals: forward request failed: ${String(err)}`,
                );
                return false;
              }),
            );
          }
          if (opts?.iosPushDelivery?.handleRequested) {
            deliveryTasks.push(
              opts.iosPushDelivery.handleRequested(requestEvent).catch((err) => {
                context.logGateway?.error?.(
                  `exec approvals: iOS push request failed: ${String(err)}`,
                );
                return false;
              }),
            );
          }
          if (deliveryTasks.length === 0) {
            return false;
          }
          return (async () => {
            let delivered = false;
            for (const task of deliveryTasks) {
              delivered = (await task) || delivered;
            }
            return delivered;
          })();
        },
        manager,
        record,
        requestEvent,
        requestEventName: "exec.approval.requested",
        respond,
        twoPhase,
      });
    },
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validateExecApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid exec.approval.resolve params: ${formatValidationErrors(
              validateExecApprovalResolveParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as { id: string; decision: string };
      if (!isApprovalDecision(p.decision)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid decision"));
        return;
      }
      const {decision} = p;
      await handleApprovalResolve({
        buildResolvedEvent: ({ approvalId, decision, resolvedBy, snapshot, nowMs }) =>
          ({
            id: approvalId,
            decision,
            resolvedBy,
            ts: nowMs,
            request: snapshot.request,
          }) satisfies ExecApprovalResolved,
        client,
        context,
        decision,
        exposeAmbiguousPrefixError: true,
        extraResolvedHandlers: opts?.iosPushDelivery?.handleResolved
          ? [
              {
                run: (resolvedEvent) => opts.iosPushDelivery!.handleResolved!(resolvedEvent),
                errorLabel: "exec approvals: iOS push resolve failed",
              },
            ]
          : undefined,
        forwardResolved: (resolvedEvent) => opts?.forwarder?.handleResolved(resolvedEvent),
        forwardResolvedErrorLabel: "exec approvals: forward resolve failed",
        inputId: p.id,
        manager,
        resolvedEventName: "exec.approval.resolved",
        respond,
        validateDecision: (snapshot) => {
          const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(snapshot.request);
          return allowedDecisions.includes(decision)
            ? null
            : {
                message:
                  "allow-always is unavailable because the effective policy requires approval every time",
                details: APPROVAL_ALLOW_ALWAYS_UNAVAILABLE_DETAILS,
              };
        },
      });
    },
    "exec.approval.waitDecision": async ({ params, respond }) => {
      await handleApprovalWaitDecision({
        inputId: (params as { id?: string }).id,
        manager,
        respond,
      });
    },
  };
}
