import type { ResolvedBrowserProfile } from "./config.js";

export type BrowserProfileMode = "local-managed" | "local-existing-session" | "remote-cdp";

export interface BrowserProfileCapabilities {
  mode: BrowserProfileMode;
  isRemote: boolean;
  /** Profile uses the Chrome DevTools MCP server (existing-session driver). */
  usesChromeMcp: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
}

export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  if (profile.driver === "existing-session") {
    return {
      isRemote: false,
      mode: "local-existing-session",
      supportsJsonTabEndpoints: false,
      supportsManagedTabLimit: false,
      supportsPerTabWs: false,
      supportsReset: false,
      usesChromeMcp: true,
      usesPersistentPlaywright: false,
    };
  }

  if (!profile.cdpIsLoopback) {
    return {
      isRemote: true,
      mode: "remote-cdp",
      supportsJsonTabEndpoints: false,
      supportsManagedTabLimit: false,
      supportsPerTabWs: false,
      supportsReset: false,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
    };
  }

  return {
    isRemote: false,
    mode: "local-managed",
    supportsJsonTabEndpoints: true,
    supportsManagedTabLimit: true,
    supportsPerTabWs: true,
    supportsReset: true,
    usesChromeMcp: false,
    usesPersistentPlaywright: false,
  };
}

export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-existing-session") {
    return "ai";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  return !params.wsUrl || Boolean(params.ref) || Boolean(params.element);
}

export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  return !params.wsUrl;
}
