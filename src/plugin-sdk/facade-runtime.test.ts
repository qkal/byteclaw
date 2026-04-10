import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import {
  __testing,
  canLoadActivatedBundledPluginPublicSurface,
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function createBundledPluginDir(prefix: string, marker: string): string {
  const rootDir = createTempDirSync(prefix);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  return rootDir;
}

function createThrowingPluginDir(prefix: string): string {
  const rootDir = createTempDirSync(prefix);
  fs.mkdirSync(path.join(rootDir, "bad"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "bad", "api.js"),
    `throw new Error("plugin load failure");\n`,
    "utf8",
  );
  return rootDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetFacadeRuntimeStateForTest();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  vi.doUnmock("../plugins/manifest-registry.js");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("plugin-sdk facade runtime", () => {
  it("honors bundled plugin dir overrides outside the package root", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-runtime-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-runtime-b-", "override-b");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideA;
    const fromA = __testing.resolveFacadeModuleLocation({
      artifactBasename: "api.js",
      dirName: "demo",
    });
    expect(fromA).toEqual({
      boundaryRoot: overrideA,
      modulePath: path.join(overrideA, "demo", "api.js"),
    });

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideB;
    const fromB = __testing.resolveFacadeModuleLocation({
      artifactBasename: "api.js",
      dirName: "demo",
    });
    expect(fromB).toEqual({
      boundaryRoot: overrideB,
      modulePath: path.join(overrideB, "demo", "api.js"),
    });
  });

  it("returns the same object identity on repeated calls (sentinel consistency)", () => {
    const dir = createBundledPluginDir("openclaw-facade-identity-", "identity-check");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
    const location = {
      boundaryRoot: dir,
      modulePath: path.join(dir, "demo", "api.js"),
    };
    const loader = vi.fn(() => ({ marker: "identity-check" }));

    const first = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      loadModule: loader,
      location,
      trackedPluginId: "demo",
    });
    const second = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      loadModule: loader,
      location,
      trackedPluginId: "demo",
    });
    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createBundledPluginDir("openclaw-facade-circular-", "circular-ok");
    const location = {
      boundaryRoot: dir,
      modulePath: path.join(dir, "demo", "api.js"),
    };
    let reentered: { marker?: string } | undefined;
    const loader = vi.fn(() => {
      reentered = __testing.loadFacadeModuleAtLocationSync<{ marker?: string }>({
        loadModule: loader,
        location,
        trackedPluginId: "demo",
      });
      return { marker: "circular-ok" };
    });

    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      loadModule: loader,
      location,
      trackedPluginId: "demo",
    });

    expect(loaded.marker).toBe("circular-ok");
    expect(reentered).toBe(loaded);
    expect(reentered?.marker).toBe("circular-ok");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("back-fills the sentinel before post-load facade tracking re-enters", () => {
    const dir = createBundledPluginDir("openclaw-facade-post-load-", "post-load-ok");
    const location = {
      boundaryRoot: dir,
      modulePath: path.join(dir, "demo", "api.js"),
    };
    const reentryMarkers: (string | undefined)[] = [];
    const loader = vi.fn(() => ({ marker: "post-load-ok" }));

    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      loadModule: loader,
      location,
      trackedPluginId: () => {
        const reentered = __testing.loadFacadeModuleAtLocationSync<{ marker?: string }>({
          loadModule: loader,
          location,
          trackedPluginId: "demo",
        });
        reentryMarkers.push(reentered.marker);
        return "demo";
      },
    });

    expect(loaded.marker).toBe("post-load-ok");
    expect(reentryMarkers.length).toBeGreaterThan(0);
    expect(reentryMarkers.every((marker) => marker === "post-load-ok")).toBe(true);
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("clears the cache on load failure so retries re-execute", () => {
    const dir = createThrowingPluginDir("openclaw-facade-throw-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        artifactBasename: "api.js",
        dirName: "bad",
      }),
    ).toThrow("plugin load failure");

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    // A second call must also throw (not return a stale empty sentinel).
    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        artifactBasename: "api.js",
        dirName: "bad",
      }),
    ).toThrow("plugin load failure");
  });

  it("blocks runtime-api facade loads for bundled plugins that are not activated", () => {
    const access = __testing.evaluateBundledPluginPublicSurfaceAccess({
      activationSource: createPluginActivationSource({ config: {} }),
      autoEnabledReasons: {},
      config: {},
      manifestRecord: {
        channels: ["discord"],
        enabledByDefault: false,
        id: "discord",
        origin: "bundled",
        rootDir: "/tmp/discord",
      },
      normalizedPluginsConfig: normalizePluginsConfig(),
      params: {
        artifactBasename: "runtime-api.js",
        dirName: "discord",
      },
    });

    expect(access.allowed).toBe(false);
    expect(access.pluginId).toBe("discord");
    expect(access.reason).toBeTruthy();
    expect(() =>
      __testing.throwForBundledPluginPublicSurfaceAccess({
        access,
        request: {
          artifactBasename: "runtime-api.js",
          dirName: "discord",
        },
      }),
    ).toThrow(/Bundled plugin public surface access blocked/);
    expect(access.allowed).toBe(false);
  });

  it("allows runtime-api facade loads when the bundled plugin is explicitly enabled", () => {
    const dir = createTempDirSync("openclaw-facade-runtime-enabled-");
    fs.mkdirSync(path.join(dir, "discord"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "discord", "runtime-api.js"),
      'export const marker = "runtime-api-enabled";\n',
      "utf8",
    );
    const config = {
      plugins: {
        entries: {
          discord: {
            enabled: true,
          },
        },
      },
    } as const;
    const access = __testing.evaluateBundledPluginPublicSurfaceAccess({
      activationSource: createPluginActivationSource({ config }),
      autoEnabledReasons: {},
      config,
      manifestRecord: {
        channels: ["discord"],
        enabledByDefault: false,
        id: "discord",
        origin: "bundled",
        rootDir: "/tmp/discord",
      },
      normalizedPluginsConfig: normalizePluginsConfig(config.plugins),
      params: {
        artifactBasename: "runtime-api.js",
        dirName: "discord",
      },
    });
    const loader = vi.fn(() => ({ marker: "runtime-api-enabled" }));
    const location = {
      boundaryRoot: dir,
      modulePath: path.join(dir, "discord", "runtime-api.js"),
    };

    expect(access.allowed).toBe(true);
    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      loadModule: loader,
      location,
      trackedPluginId: "discord",
    });
    expect(loaded.marker).toBe("runtime-api-enabled");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("resolves a globally-installed plugin whose rootDir basename matches the dirName", () => {
    const lineDir = createTempDirSync("openclaw-facade-global-line-");
    fs.mkdirSync(lineDir, { recursive: true });
    fs.writeFileSync(
      path.join(lineDir, "runtime-api.js"),
      'export const marker = "global-line";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(lineDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        openclaw: {
          channel: { id: "line" },
          extensions: ["./runtime-api.js"],
        },
        version: "0.0.0",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lineDir, "openclaw.plugin.json"),
      JSON.stringify({
        channels: ["line"],
        configSchema: { additionalProperties: false, properties: {}, type: "object" },
        id: "line",
      }),
      "utf8",
    );

    expect(
      __testing.resolveRegistryPluginModuleLocationFromRegistry({
        artifactBasename: "runtime-api.js",
        dirName: "line",
        registry: [
          {
            channels: ["line"],
            id: "line",
            rootDir: lineDir,
          },
        ],
      }),
    ).toEqual({
      boundaryRoot: lineDir,
      modulePath: path.join(lineDir, "runtime-api.js"),
    });
  });

  it("resolves a globally-installed plugin with an encoded scoped rootDir basename", () => {
    const encodedDir = createTempDirSync("openclaw-facade-encoded-line-");
    fs.mkdirSync(encodedDir, { recursive: true });
    fs.writeFileSync(
      path.join(encodedDir, "runtime-api.js"),
      'export const marker = "encoded-global-line";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        openclaw: {
          channel: { id: "line" },
          extensions: ["./runtime-api.js"],
        },
        version: "0.0.0",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "openclaw.plugin.json"),
      JSON.stringify({
        channels: ["line"],
        configSchema: { additionalProperties: false, properties: {}, type: "object" },
        id: "line",
      }),
      "utf8",
    );

    expect(
      __testing.resolveRegistryPluginModuleLocationFromRegistry({
        artifactBasename: "runtime-api.js",
        dirName: "line",
        registry: [
          {
            channels: ["line"],
            id: "line",
            rootDir: encodedDir,
          },
        ],
      }),
    ).toEqual({
      boundaryRoot: encodedDir,
      modulePath: path.join(encodedDir, "runtime-api.js"),
    });
  });

  it("keeps shared runtime-core facades available without plugin activation", () => {
    setRuntimeConfigSnapshot({});

    expect(
      canLoadActivatedBundledPluginPublicSurface({
        artifactBasename: "runtime-api.js",
        dirName: "speech-core",
      }),
    ).toBe(true);
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        artifactBasename: "runtime-api.js",
        dirName: "image-generation-core",
      }),
    ).toBe(true);
    expect(
      canLoadActivatedBundledPluginPublicSurface({
        artifactBasename: "runtime-api.js",
        dirName: "media-understanding-core",
      }),
    ).toBe(true);
  });
});
