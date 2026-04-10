import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { EndReason } from "../../types.js";

const TERMINAL_PROVIDER_STATUS_TO_END_REASON: Record<string, EndReason> = {
  busy: "busy",
  canceled: "hangup-bot",
  completed: "completed",
  failed: "failed",
  "no-answer": "no-answer",
};

export function normalizeProviderStatus(status: string | null | undefined): string {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function mapProviderStatusToEndReason(status: string | null | undefined): EndReason | null {
  const normalized = normalizeProviderStatus(status);
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalized] ?? null;
}

export function isProviderStatusTerminal(status: string | null | undefined): boolean {
  return mapProviderStatusToEndReason(status) !== null;
}
