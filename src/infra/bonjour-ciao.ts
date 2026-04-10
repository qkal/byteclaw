import { formatBonjourError } from "./bonjour-errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE =
  /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGE FROM DEFINED TO UNDEFINED!?/u;

export type CiaoUnhandledRejectionClassification =
  | { kind: "cancellation"; formatted: string }
  | { kind: "interface-assertion"; formatted: string };

export function classifyCiaoUnhandledRejection(
  reason: unknown,
): CiaoUnhandledRejectionClassification | null {
  const formatted = formatBonjourError(reason);
  const message = formatted.toUpperCase();
  if (CIAO_CANCELLATION_MESSAGE_RE.test(message)) {
    return { formatted, kind: "cancellation" };
  }
  if (CIAO_INTERFACE_ASSERTION_MESSAGE_RE.test(message)) {
    return { formatted, kind: "interface-assertion" };
  }
  return null;
}

export function ignoreCiaoUnhandledRejection(reason: unknown): boolean {
  return classifyCiaoUnhandledRejection(reason) !== null;
}
