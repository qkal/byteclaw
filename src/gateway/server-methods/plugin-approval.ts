import { randomUUID } from "node:crypto";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../../infra/plugin-approvals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginApprovalRequestParams,
  validatePluginApprovalResolveParams,
} from "../protocol/index.js";
import {
  handleApprovalResolve,
  handleApprovalWaitDecision,
  handlePendingApprovalRequest,
  isApprovalDecision,
} from "./approval-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

export function createPluginApprovalHandlers(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  opts?: { forwarder?: ExecApprovalForwarder },
): GatewayRequestHandlers {
  return {
    "plugin.approval.list": async ({ respond }) => {
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
    "plugin.approval.request": async ({ params, client, respond, context }) => {
      if (!validatePluginApprovalRequestParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.request params: ${formatValidationErrors(
              validatePluginApprovalRequestParams.errors,
            )}`,
          ),
        );
        return;
      }
      const p = params as {
        pluginId?: string | null;
        title: string;
        description: string;
        severity?: string | null;
        toolName?: string | null;
        toolCallId?: string | null;
        agentId?: string | null;
        sessionKey?: string | null;
        turnSourceChannel?: string | null;
        turnSourceTo?: string | null;
        turnSourceAccountId?: string | null;
        turnSourceThreadId?: string | number | null;
        timeoutMs?: number;
        twoPhase?: boolean;
      };
      const twoPhase = p.twoPhase === true;
      const timeoutMs = Math.min(
        typeof p.timeoutMs === "number" ? p.timeoutMs : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
        MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
      );

      const normalizeTrimmedString = (value?: string | null): string | null =>
        normalizeOptionalString(value) || null;

      const request: PluginApprovalRequestPayload = {
        agentId: p.agentId ?? null,
        description: p.description,
        pluginId: p.pluginId ?? null,
        sessionKey: p.sessionKey ?? null,
        severity: (p.severity as PluginApprovalRequestPayload["severity"]) ?? null,
        title: p.title,
        toolCallId: p.toolCallId ?? null,
        toolName: p.toolName ?? null,
        turnSourceAccountId: normalizeTrimmedString(p.turnSourceAccountId),
        turnSourceChannel: normalizeTrimmedString(p.turnSourceChannel),
        turnSourceThreadId: p.turnSourceThreadId ?? null,
        turnSourceTo: normalizeTrimmedString(p.turnSourceTo),
      };

      // Always server-generate the ID — never accept plugin-provided IDs.
      // Kind-prefix so /approve routing can distinguish plugin vs exec IDs deterministically.
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);

      let decisionPromise: Promise<ExecApprovalDecision | null>;
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

      const requestEvent = {
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        id: record.id,
        request: record.request,
      };

      await handlePendingApprovalRequest({
        clientConnId: client?.connId,
        context,
        decisionPromise,
        deliverRequest: () => {
          if (!opts?.forwarder?.handlePluginApprovalRequested) {
            return false;
          }
          return opts.forwarder.handlePluginApprovalRequested(requestEvent).catch((err) => {
            context.logGateway?.error?.(`plugin approvals: forward request failed: ${String(err)}`);
            return false;
          });
        },
        manager,
        record,
        requestEvent,
        requestEventName: "plugin.approval.requested",
        respond,
        twoPhase,
      });
    },

    "plugin.approval.resolve": async ({ params, respond, client, context }) => {
      if (!validatePluginApprovalResolveParams(params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid plugin.approval.resolve params: ${formatValidationErrors(
              validatePluginApprovalResolveParams.errors,
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
      await handleApprovalResolve({
        buildResolvedEvent: ({ approvalId, decision, resolvedBy, snapshot, nowMs }) => ({
          id: approvalId,
          decision,
          resolvedBy,
          ts: nowMs,
          request: snapshot.request,
        }),
        client,
        context,
        decision: p.decision,
        exposeAmbiguousPrefixError: false,
        forwardResolved: (resolvedEvent) =>
          opts?.forwarder?.handlePluginApprovalResolved?.(resolvedEvent),
        forwardResolvedErrorLabel: "plugin approvals: forward resolve failed",
        inputId: p.id,
        manager,
        resolvedEventName: "plugin.approval.resolved",
        respond,
      });
    },

    "plugin.approval.waitDecision": async ({ params, respond }) => {
      await handleApprovalWaitDecision({
        inputId: (params as { id?: string }).id,
        manager,
        respond,
      });
    },
  };
}
