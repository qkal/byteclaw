import { hasApprovalTurnSourceRoute } from "../../infra/approval-turn-source.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type {
  ExecApprovalIdLookupResult,
  ExecApprovalManager,
  ExecApprovalRecord,
} from "../exec-approval-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const APPROVAL_NOT_FOUND_DETAILS = {
  reason: ErrorCodes.APPROVAL_NOT_FOUND,
} as const;

type PendingApprovalLookupError =
  | "missing"
  | {
      code: (typeof ErrorCodes)["INVALID_REQUEST"];
      message: string;
    };

interface ApprovalTurnSourceFields {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
}

interface RequestedApprovalEvent<TPayload extends ApprovalTurnSourceFields> {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function isApprovalDecision(value: string): value is ExecApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

export function respondUnknownOrExpiredApproval(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "unknown or expired approval id", {
      details: APPROVAL_NOT_FOUND_DETAILS,
    }),
  );
}

function resolvePendingApprovalLookupError(params: {
  resolvedId: ExecApprovalIdLookupResult;
  exposeAmbiguousPrefixError?: boolean;
}): PendingApprovalLookupError {
  if (params.resolvedId.kind === "none") {
    return "missing";
  }
  if (params.resolvedId.kind === "ambiguous" && !params.exposeAmbiguousPrefixError) {
    return "missing";
  }
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "ambiguous approval id prefix; use the full id",
  };
}

export function resolvePendingApprovalRecord<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  exposeAmbiguousPrefixError?: boolean;
}):
  | {
      ok: true;
      approvalId: string;
      snapshot: ExecApprovalRecord<TPayload>;
    }
  | {
      ok: false;
      response: PendingApprovalLookupError;
    } {
  const resolvedId = params.manager.lookupPendingId(params.inputId);
  if (resolvedId.kind !== "exact" && resolvedId.kind !== "prefix") {
    return {
      ok: false,
      response: resolvePendingApprovalLookupError({
        exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
        resolvedId,
      }),
    };
  }
  const snapshot = params.manager.getSnapshot(resolvedId.id);
  if (!snapshot || snapshot.resolvedAtMs !== undefined) {
    return { ok: false, response: "missing" };
  }
  return { approvalId: resolvedId.id, ok: true, snapshot };
}

export function respondPendingApprovalLookupError(params: {
  respond: RespondFn;
  response: PendingApprovalLookupError;
}): void {
  if (params.response === "missing") {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }
  params.respond(false, undefined, errorShape(params.response.code, params.response.message));
}

export async function handleApprovalWaitDecision<TPayload>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: unknown;
  respond: RespondFn;
}): Promise<void> {
  const id = normalizeOptionalString(params.inputId) ?? "";
  if (!id) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
    return;
  }
  const decisionPromise = params.manager.awaitDecision(id);
  if (!decisionPromise) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "approval expired or not found"),
    );
    return;
  }
  const snapshot = params.manager.getSnapshot(id);
  const decision = await decisionPromise;
  params.respond(
    true,
    {
      createdAtMs: snapshot?.createdAtMs,
      decision,
      expiresAtMs: snapshot?.expiresAtMs,
      id,
    },
    undefined,
  );
}

export async function handlePendingApprovalRequest<
  TPayload extends ApprovalTurnSourceFields,
>(params: {
  manager: ExecApprovalManager<TPayload>;
  record: ExecApprovalRecord<TPayload>;
  decisionPromise: Promise<ExecApprovalDecision | null>;
  respond: RespondFn;
  context: GatewayRequestContext;
  clientConnId?: string;
  requestEventName: string;
  requestEvent: RequestedApprovalEvent<TPayload>;
  twoPhase: boolean;
  deliverRequest: () => boolean | Promise<boolean>;
  afterDecision?: (
    decision: ExecApprovalDecision | null,
    requestEvent: RequestedApprovalEvent<TPayload>,
  ) => Promise<void> | void;
  afterDecisionErrorLabel?: string;
}): Promise<void> {
  params.context.broadcast(params.requestEventName, params.requestEvent, { dropIfSlow: true });

  const hasApprovalClients = params.context.hasExecApprovalClients?.(params.clientConnId) ?? false;
  const hasTurnSourceRoute = hasApprovalTurnSourceRoute({
    turnSourceAccountId: params.record.request.turnSourceAccountId,
    turnSourceChannel: params.record.request.turnSourceChannel,
  });
  const deliveredResult = params.deliverRequest();
  const delivered = isPromiseLike(deliveredResult) ? await deliveredResult : deliveredResult;

  if (!hasApprovalClients && !hasTurnSourceRoute && !delivered) {
    params.manager.expire(params.record.id, "no-approval-route");
    params.respond(
      true,
      {
        createdAtMs: params.record.createdAtMs,
        decision: null,
        expiresAtMs: params.record.expiresAtMs,
        id: params.record.id,
      },
      undefined,
    );
    return;
  }

  if (params.twoPhase) {
    params.respond(
      true,
      {
        createdAtMs: params.record.createdAtMs,
        expiresAtMs: params.record.expiresAtMs,
        id: params.record.id,
        status: "accepted",
      },
      undefined,
    );
  }

  const decision = await params.decisionPromise;
  if (params.afterDecision) {
    try {
      await params.afterDecision(decision, params.requestEvent);
    } catch (error) {
      params.context.logGateway?.error?.(
        `${params.afterDecisionErrorLabel ?? "approval follow-up failed"}: ${String(error)}`,
      );
    }
  }
  params.respond(
    true,
    {
      createdAtMs: params.record.createdAtMs,
      decision,
      expiresAtMs: params.record.expiresAtMs,
      id: params.record.id,
    },
    undefined,
  );
}

export async function handleApprovalResolve<TPayload, TResolvedEvent extends object>(params: {
  manager: ExecApprovalManager<TPayload>;
  inputId: string;
  decision: ExecApprovalDecision;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  exposeAmbiguousPrefixError?: boolean;
  validateDecision?: (snapshot: ExecApprovalRecord<TPayload>) =>
    | {
        message: string;
        details?: Record<string, unknown>;
      }
    | null
    | undefined;
  resolvedEventName: string;
  buildResolvedEvent: (params: {
    approvalId: string;
    decision: ExecApprovalDecision;
    resolvedBy: string | null;
    snapshot: ExecApprovalRecord<TPayload>;
    nowMs: number;
  }) => TResolvedEvent;
  forwardResolved?: (event: TResolvedEvent) => Promise<void> | void;
  forwardResolvedErrorLabel?: string;
  extraResolvedHandlers?: {
    run: (event: TResolvedEvent) => Promise<void> | void;
    errorLabel: string;
  }[];
}): Promise<void> {
  const resolved = resolvePendingApprovalRecord({
    exposeAmbiguousPrefixError: params.exposeAmbiguousPrefixError,
    inputId: params.inputId,
    manager: params.manager,
  });
  if (!resolved.ok) {
    respondPendingApprovalLookupError({ respond: params.respond, response: resolved.response });
    return;
  }

  const validationError = params.validateDecision?.(resolved.snapshot);
  if (validationError) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        validationError.message,
        validationError.details ? { details: validationError.details } : undefined,
      ),
    );
    return;
  }

  const resolvedBy =
    params.client?.connect?.client?.displayName ?? params.client?.connect?.client?.id ?? null;
  const ok = params.manager.resolve(resolved.approvalId, params.decision, resolvedBy);
  if (!ok) {
    respondUnknownOrExpiredApproval(params.respond);
    return;
  }

  const resolvedEvent = params.buildResolvedEvent({
    approvalId: resolved.approvalId,
    decision: params.decision,
    nowMs: Date.now(),
    resolvedBy,
    snapshot: resolved.snapshot,
  });
  params.context.broadcast(params.resolvedEventName, resolvedEvent, { dropIfSlow: true });

  const followUps = [
    params.forwardResolved
      ? {
          errorLabel: params.forwardResolvedErrorLabel ?? "approval resolve follow-up failed",
          run: params.forwardResolved,
        }
      : null,
    ...(params.extraResolvedHandlers ?? []),
  ].filter(
    (
      entry,
    ): entry is { run: (event: TResolvedEvent) => Promise<void> | void; errorLabel: string } =>
      Boolean(entry),
  );

  for (const followUp of followUps) {
    try {
      await followUp.run(resolvedEvent);
    } catch (error) {
      params.context.logGateway?.error?.(`${followUp.errorLabel}: ${String(error)}`);
    }
  }

  params.respond(true, { ok: true }, undefined);
}
