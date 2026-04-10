import type { ResolvedBrowserProfile } from "./config.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";

export function resolveIdleProfileStopOutcome(profile: ResolvedBrowserProfile): {
  stopped: boolean;
  closePlaywright: boolean;
} {
  const capabilities = getBrowserProfileCapabilities(profile);
  if (profile.attachOnly || capabilities.isRemote) {
    return {
      closePlaywright: true,
      stopped: true,
    };
  }
  return {
    closePlaywright: false,
    stopped: false,
  };
}

export async function closePlaywrightBrowserConnectionForProfile(cdpUrl?: string): Promise<void> {
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection(cdpUrl ? { cdpUrl } : undefined);
  } catch {
    // Ignore
  }
}
