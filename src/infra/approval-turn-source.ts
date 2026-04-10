import { loadConfig } from "../config/config.js";
import { resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
}): boolean {
  if (!params.turnSourceChannel?.trim()) {
    return false;
  }
  return (
    resolveExecApprovalInitiatingSurfaceState({
      accountId: params.turnSourceAccountId,
      cfg: loadConfig(),
      channel: params.turnSourceChannel,
    }).kind === "enabled"
  );
}
