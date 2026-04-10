import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { WebhookContext } from "../../types.js";

export type TwimlResponseKind = "empty" | "pause" | "queue" | "stored" | "stream";

export interface TwimlRequestView {
  callStatus: string | null;
  direction: string | null;
  isStatusCallback: boolean;
  callSid?: string;
  callIdFromQuery?: string;
}

export type TwimlPolicyInput = TwimlRequestView & {
  hasStoredTwiml: boolean;
  isNotifyCall: boolean;
  hasActiveStreams: boolean;
  canStream: boolean;
};

export type TwimlDecision =
  | {
      kind: "empty" | "pause" | "queue";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stored";
      consumeStoredTwimlCallId: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stream";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    };

function isOutboundDirection(direction: string | null): boolean {
  return direction?.startsWith("outbound") ?? false;
}

export function readTwimlRequestView(ctx: WebhookContext): TwimlRequestView {
  const params = new URLSearchParams(ctx.rawBody);
  const type = normalizeOptionalString(ctx.query?.type);
  const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);

  return {
    callIdFromQuery,
    callSid: params.get("CallSid") || undefined,
    callStatus: params.get("CallStatus"),
    direction: params.get("Direction"),
    isStatusCallback: type === "status",
  };
}

export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      return { consumeStoredTwimlCallId: input.callIdFromQuery, kind: "stored" };
    }
    if (input.isNotifyCall) {
      return { kind: "empty" };
    }

    if (isOutboundDirection(input.direction)) {
      return input.canStream ? { kind: "stream" } : { kind: "pause" };
    }
  }

  if (input.isStatusCallback) {
    return { kind: "empty" };
  }

  if (input.direction === "inbound") {
    if (input.hasActiveStreams) {
      return { kind: "queue" };
    }
    if (input.canStream && input.callSid) {
      return { activateStreamCallSid: input.callSid, kind: "stream" };
    }
    return { kind: "pause" };
  }

  if (input.callStatus !== "in-progress") {
    return { kind: "empty" };
  }

  return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
