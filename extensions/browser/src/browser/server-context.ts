import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { BrowserProfileNotFoundError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = { lastTargetId: null, profile, reconcile: null, running: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const { listTabs, openTab } = createProfileTabOps({
    getProfileState,
    profile,
    state,
  });

  const { ensureBrowserAvailable, isHttpReachable, isReachable, stopRunningBrowser } =
    createProfileAvailability({
      getProfileState,
      opts,
      profile,
      setProfileRunning,
      state,
    });

  const { ensureTabAvailable, focusTab, closeTab } = createProfileSelectionOps({
    ensureBrowserAvailable,
    getProfileState,
    listTabs,
    openTab,
    profile,
  });

  const { resetProfile } = createProfileResetOps({
    getProfileState,
    isHttpReachable,
    profile,
    resolveOpenClawUserDataDir,
    stopRunningBrowser,
  });

  return {
    closeTab,
    ensureBrowserAvailable,
    ensureTabAvailable,
    focusTab,
    isHttpReachable,
    isReachable,
    listTabs,
    openTab,
    profile,
    resetProfile,
    stopRunningBrowser,
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    const name = profileName ?? current.resolved.defaultProfile;
    const profile = resolveBrowserProfileWithHotReload({
      current,
      name,
      refreshConfigFromDisk,
    });

    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new BrowserProfileNotFoundError(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`,
      );
    }
    return createProfileContext(opts, profile);
  };

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      mode: "cached",
      refreshConfigFromDisk,
    });
    const result: ProfileStatus[] = [];

    for (const name of listKnownProfileNames(current)) {
      const profileState = current.profiles.get(name);
      const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
      if (!profile) {
        continue;
      }
      const capabilities = getBrowserProfileCapabilities(profile);

      let tabCount = 0;
      let running = false;
      const profileCtx = createProfileContext(opts, profile);

      if (capabilities.usesChromeMcp) {
        try {
          running = await profileCtx.isReachable(300);
          if (running) {
            const tabs = await profileCtx.listTabs();
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Chrome MCP not available
        }
      } else if (profileState?.running) {
        running = true;
        try {
          const tabs = await profileCtx.listTabs();
          tabCount = tabs.filter((t) => t.type === "page").length;
        } catch {
          // Browser might not be responsive
        }
      } else {
        // Check if something is listening on the port
        try {
          const reachable = await isChromeReachable(
            profile.cdpUrl,
            200,
            current.resolved.ssrfPolicy,
          );
          if (reachable) {
            running = true;
            const tabs = await profileCtx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Not reachable
        }
      }

      result.push({
        cdpPort: capabilities.usesChromeMcp ? null : profile.cdpPort,
        cdpUrl: capabilities.usesChromeMcp ? null : profile.cdpUrl,
        color: profile.color,
        driver: profile.driver,
        isDefault: name === current.resolved.defaultProfile,
        isRemote: !profile.cdpIsLoopback,
        missingFromConfig: !(name in current.resolved.profiles) || undefined,
        name,
        reconcileReason: profileState?.reconcile?.reason ?? null,
        running,
        tabCount,
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
      });
    }

    return result;
  };

  // Create default profile context for backward compatibility
  const getDefaultContext = () => forProfile();

  const mapTabError = (err: unknown) => {
    const browserMapped = toBrowserErrorResponse(err);
    if (browserMapped) {
      return browserMapped;
    }
    if (err instanceof SsrFBlockedError) {
      return { message: err.message, status: 400 };
    }
    if (err instanceof InvalidBrowserNavigationUrlError) {
      return { message: err.message, status: 400 };
    }
    return null;
  };

  return {
    state,
    forProfile,
    listProfiles,
    // Legacy methods delegate to default profile
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
