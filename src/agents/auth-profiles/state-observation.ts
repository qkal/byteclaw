import { redactIdentifier } from "../../logging/redact-identifier.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { sanitizeForConsole } from "../console-sanitize.js";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";

const observationLog = createSubsystemLogger("agent/embedded");

export function logAuthProfileFailureStateChange(params: {
  runId?: string;
  profileId: string;
  provider: string;
  reason: AuthProfileFailureReason;
  previous: ProfileUsageStats | undefined;
  next: ProfileUsageStats;
  now: number;
}): void {
  const windowType =
    params.reason === "billing" || params.reason === "auth_permanent" ? "disabled" : "cooldown";
  const previousCooldownUntil = params.previous?.cooldownUntil;
  const previousDisabledUntil = params.previous?.disabledUntil;
  // Active cooldown/disable windows are intentionally immutable; log whether this
  // Update reused the existing window instead of extending it.
  const windowReused =
    windowType === "disabled"
      ? typeof previousDisabledUntil === "number" &&
        Number.isFinite(previousDisabledUntil) &&
        previousDisabledUntil > params.now &&
        previousDisabledUntil === params.next.disabledUntil
      : typeof previousCooldownUntil === "number" &&
        Number.isFinite(previousCooldownUntil) &&
        previousCooldownUntil > params.now &&
        previousCooldownUntil === params.next.cooldownUntil;
  const safeProfileId = redactIdentifier(params.profileId, { len: 12 });
  const safeRunId = sanitizeForConsole(params.runId) ?? "-";
  const safeProvider = sanitizeForConsole(params.provider) ?? "-";

  observationLog.warn("auth profile failure state updated", {
    consoleMessage:
      `auth profile failure state updated: runId=${safeRunId} profile=${safeProfileId} provider=${safeProvider} ` +
      `reason=${params.reason} window=${windowType} reused=${String(windowReused)}`,
    cooldownUntil: params.next.cooldownUntil,
    disabledReason: params.next.disabledReason,
    disabledUntil: params.next.disabledUntil,
    errorCount: params.next.errorCount,
    event: "auth_profile_failure_state_updated",
    failureCounts: params.next.failureCounts,
    previousCooldownUntil,
    previousDisabledReason: params.previous?.disabledReason,
    previousDisabledUntil,
    previousErrorCount: params.previous?.errorCount,
    profileId: safeProfileId,
    provider: params.provider,
    reason: params.reason,
    runId: params.runId,
    tags: ["error_handling", "auth_profiles", windowType],
    windowReused,
    windowType,
  });
}
