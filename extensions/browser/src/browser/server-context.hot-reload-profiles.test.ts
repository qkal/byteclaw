import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.types.js";

interface TestProfileConfig { cdpPort?: number; cdpUrl?: string; color?: string }
interface TestConfig {
  browser: {
    enabled: true;
    color: string;
    headless: true;
    defaultProfile: string;
    profiles: Record<string, TestProfileConfig>;
  };
}

const mockState = vi.hoisted(
  () =>
    ({
      cachedConfig: null as TestConfig | null,
      cfgProfiles: {} as Record<string, TestProfileConfig>,
    }) satisfies {
      cfgProfiles: Record<string, TestProfileConfig>;
      cachedConfig: TestConfig | null;
    },
);

function buildConfig(): TestConfig {
  return {
    browser: {
      color: "#FF4500",
      defaultProfile: "openclaw",
      enabled: true,
      headless: true,
      profiles: { ...mockState.cfgProfiles },
    },
  };
}

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({
      loadConfig: () => buildConfig(),
    }),
    getRuntimeConfigSnapshot: () => null,
    loadConfig: () => {
      // Simulate stale loadConfig that doesn't see updates unless cache cleared
      if (!mockState.cachedConfig) {
        mockState.cachedConfig = buildConfig();
      }
      return mockState.cachedConfig;
    },
    writeConfigFile: vi.fn(async () => {}),
  };
});

vi.mock("./config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => buildConfig(),
}));

const { loadConfig } = await import("../config/config.js");
const { resolveBrowserConfig, resolveProfile } = await import("./config.js");
const { refreshResolvedBrowserConfigFromDisk, resolveBrowserProfileWithHotReload } =
  await import("./resolved-config-refresh.js");

describe("server-context hot-reload profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.cfgProfiles = {
      openclaw: { cdpPort: 18_800, color: "#FF4500" },
    };
    mockState.cachedConfig = null; // Clear simulated cache
  });

  it("forProfile hot-reloads newly added profiles from config", async () => {
    // Start with only openclaw profile
    // 1. Prime the cache by calling loadConfig() first
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);

    // Verify cache is primed (without desktop)
    expect(cfg.browser?.profiles?.desktop).toBeUndefined();
    const state = {
      port: 18_791,
      profiles: new Map(),
      resolved,
      server: null,
    };

    // Initially, "desktop" profile should not exist
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        name: "desktop",
        refreshConfigFromDisk: true,
      }),
    ).toBeNull();

    // 2. Simulate adding a new profile to config (like user editing openclaw.json)
    mockState.cfgProfiles.desktop = { cdpUrl: "http://127.0.0.1:9222", color: "#0066CC" };

    // 3. Verify without clearConfigCache, loadConfig() still returns stale cached value
    const staleCfg = loadConfig();
    expect(staleCfg.browser?.profiles?.desktop).toBeUndefined(); // Cache is stale!

    // 4. Hot-reload should read fresh config for the lookup (createConfigIO().loadConfig()),
    // Without flushing the global loadConfig cache.
    const profile = resolveBrowserProfileWithHotReload({
      current: state,
      name: "desktop",
      refreshConfigFromDisk: true,
    });
    expect(profile?.name).toBe("desktop");
    expect(profile?.cdpUrl).toBe("http://127.0.0.1:9222");

    // 5. Verify the new profile was merged into the cached state
    expect(state.resolved.profiles.desktop).toBeDefined();

    // 6. Verify GLOBAL cache was NOT cleared - subsequent simple loadConfig() still sees STALE value
    // This confirms the fix: we read fresh config for the specific profile lookup without flushing the global cache
    const stillStaleCfg = loadConfig();
    expect(stillStaleCfg.browser?.profiles?.desktop).toBeUndefined();
  });

  it("forProfile still throws for profiles that don't exist in fresh config", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      port: 18_791,
      profiles: new Map(),
      resolved,
      server: null,
    };

    // Profile that doesn't exist anywhere should still throw
    expect(
      resolveBrowserProfileWithHotReload({
        current: state,
        name: "nonexistent",
        refreshConfigFromDisk: true,
      }),
    ).toBeNull();
  });

  it("forProfile refreshes existing profile config after loadConfig cache updates", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      port: 18_791,
      profiles: new Map(),
      resolved,
      server: null,
    };

    mockState.cfgProfiles.openclaw = { cdpPort: 19_999, color: "#FF4500" };
    mockState.cachedConfig = null;

    const after = resolveBrowserProfileWithHotReload({
      current: state,
      name: "openclaw",
      refreshConfigFromDisk: true,
    });
    expect(after?.cdpPort).toBe(19_999);
    expect(state.resolved.profiles.openclaw?.cdpPort).toBe(19_999);
  });

  it("listProfiles refreshes config before enumerating profiles", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const state = {
      port: 18_791,
      profiles: new Map(),
      resolved,
      server: null,
    };

    mockState.cfgProfiles.desktop = { cdpPort: 19_999, color: "#0066CC" };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      mode: "cached",
      refreshConfigFromDisk: true,
    });
    expect(Object.keys(state.resolved.profiles)).toContain("desktop");
  });

  it("marks existing runtime state for reconcile when profile invariants change", async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    const openclawProfile = resolveProfile(resolved, "openclaw");
    expect(openclawProfile).toBeTruthy();
    const state: BrowserServerState = {
      port: 18_791,
      profiles: new Map([
        [
          "openclaw",
          {
            lastTargetId: "tab-1",
            profile: openclawProfile!,
            reconcile: null,
            running: { pid: 123 } as never,
          },
        ],
      ]),
      resolved,
      server: null,
    };

    mockState.cfgProfiles.openclaw = { cdpPort: 19_999, color: "#FF4500" };
    mockState.cachedConfig = null;

    refreshResolvedBrowserConfigFromDisk({
      current: state,
      mode: "cached",
      refreshConfigFromDisk: true,
    });

    const runtime = state.profiles.get("openclaw");
    expect(runtime).toBeTruthy();
    expect(runtime?.profile.cdpPort).toBe(19_999);
    expect(runtime?.lastTargetId).toBeNull();
    expect(runtime?.reconcile?.reason).toContain("cdpPort");
  });
});
