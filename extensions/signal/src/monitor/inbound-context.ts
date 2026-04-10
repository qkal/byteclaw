import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/config-runtime";
import {
  type ContextVisibilityDecision,
  evaluateSupplementalContextVisibility,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  formatSignalSenderDisplay,
  isSignalSenderAllowed,
  resolveSignalSender,
} from "../identity.js";
import type { SignalDataMessage } from "./event-handler.types.js";

export interface SignalQuoteContext {
  contextVisibilityMode: ReturnType<typeof resolveChannelContextVisibilityMode>;
  decision: ContextVisibilityDecision;
  quoteSenderAllowed: boolean;
  visibleQuoteText: string;
  visibleQuoteSender?: string;
}

export function resolveSignalQuoteContext(params: {
  cfg: Parameters<typeof resolveChannelContextVisibilityMode>[0]["cfg"];
  accountId: string;
  isGroup: boolean;
  dataMessage?: SignalDataMessage | null;
  effectiveGroupAllow: string[];
}): SignalQuoteContext {
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "signal",
  });
  const quoteText = normalizeOptionalString(params.dataMessage?.quote?.text) ?? "";
  const quoteSender = resolveSignalSender({
    sourceNumber: params.dataMessage?.quote?.author ?? null,
    sourceUuid: params.dataMessage?.quote?.authorUuid ?? null,
  });
  const quoteSenderAllowed =
    !params.isGroup || params.effectiveGroupAllow.length === 0
      ? true
      : (quoteSender
        ? isSignalSenderAllowed(quoteSender, params.effectiveGroupAllow)
        : false);
  const decision = evaluateSupplementalContextVisibility({
    kind: "quote",
    mode: contextVisibilityMode,
    senderAllowed: quoteSenderAllowed,
  });

  return {
    contextVisibilityMode,
    decision,
    quoteSenderAllowed,
    visibleQuoteSender:
      decision.include && quoteSender ? formatSignalSenderDisplay(quoteSender) : undefined,
    visibleQuoteText: decision.include ? quoteText : "",
  };
}
