import type { ErrorShape } from "./types.js";

export const ErrorCodes = {
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}
