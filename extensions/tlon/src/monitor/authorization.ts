import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { TlonSettingsStore } from "../settings.js";

interface ChannelAuthorization {
  mode?: "restricted" | "open";
  allowedShips?: string[];
}

export function resolveChannelAuthorization(
  cfg: OpenClawConfig,
  channelNest: string,
  settings?: TlonSettingsStore,
): { mode: "restricted" | "open"; allowedShips: string[] } {
  const tlonConfig = cfg.channels?.tlon as
    | {
        authorization?: { channelRules?: Record<string, ChannelAuthorization> };
        defaultAuthorizedShips?: string[];
      }
    | undefined;

  const fileRules = tlonConfig?.authorization?.channelRules ?? {};
  const settingsRules = settings?.channelRules ?? {};
  const rule = settingsRules[channelNest] ?? fileRules[channelNest];
  const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];

  return {
    allowedShips: rule?.allowedShips ?? defaultShips,
    mode: rule?.mode ?? "restricted",
  };
}
