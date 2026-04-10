import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "../../test/helpers/bundled-plugin-paths.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  createPluginLoaderJitiCacheKey,
  isBundledPluginExtensionPath,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  normalizeJitiAliasTargetPath,
  resolveExtensionApiAlias,
  resolvePluginLoaderJitiConfig,
  resolvePluginLoaderJitiTryNative,
  resolvePluginRuntimeModulePath,
  resolvePluginSdkAliasFile,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

type CreateJiti = typeof import("jiti").createJiti;

let createJitiPromise: Promise<CreateJiti> | undefined;

async function getCreateJiti() {
  createJitiPromise ??= import("jiti").then(({ createJiti }) => createJiti);
  return createJitiPromise;
}

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-sdk-alias-root", fixtureTempDirs);
let tempDirIndex = 0;

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  mkdirSafeDir(dir);
  return dir;
}

function withCwd<T>(cwd: string, run: () => T): T {
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  try {
    return run();
  } finally {
    cwdSpy.mockRestore();
  }
}

function createPluginSdkAliasFixture(params?: {
  srcFile?: string;
  distFile?: string;
  srcBody?: string;
  distBody?: string;
  packageExports?: Record<string, unknown>;
  trustedRootIndicators?: boolean;
  trustedRootIndicatorMode?: "bin+marker" | "cli-entry-only" | "none";
}) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugin-sdk", params?.srcFile ?? "index.ts");
  const distFile = path.join(root, "dist", "plugin-sdk", params?.distFile ?? "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  const trustedRootIndicatorMode =
    params?.trustedRootIndicatorMode ??
    (params?.trustedRootIndicators === false ? "none" : "bin+marker");
  const packageJson: Record<string, unknown> = {
    name: "openclaw",
    type: "module",
  };
  if (trustedRootIndicatorMode === "bin+marker") {
    packageJson.bin = {
      openclaw: "openclaw.mjs",
    };
  }
  if (params?.packageExports || trustedRootIndicatorMode === "cli-entry-only") {
    const trustedExports: Record<string, unknown> =
      trustedRootIndicatorMode === "cli-entry-only"
        ? { "./cli-entry": { default: "./dist/cli-entry.js" } }
        : {};
    packageJson.exports = {
      "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
      ...trustedExports,
      ...params?.packageExports,
    };
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
  if (trustedRootIndicatorMode === "bin+marker") {
    fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf8");
  }
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf8");
  return { distFile, root, srcFile };
}

function createExtensionApiAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "extensionAPI.ts");
  const distFile = path.join(root, "dist", "extensionAPI.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(srcFile, params?.srcBody ?? "export {};\n", "utf8");
  fs.writeFileSync(distFile, params?.distBody ?? "export {};\n", "utf8");
  return { distFile, root, srcFile };
}

function createPluginRuntimeAliasFixture(params?: { srcBody?: string; distBody?: string }) {
  const root = makeTempDir();
  const srcFile = path.join(root, "src", "plugins", "runtime", "index.ts");
  const distFile = path.join(root, "dist", "plugins", "runtime", "index.js");
  mkdirSafeDir(path.dirname(srcFile));
  mkdirSafeDir(path.dirname(distFile));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    srcFile,
    params?.srcBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf8",
  );
  fs.writeFileSync(
    distFile,
    params?.distBody ?? "export const createPluginRuntime = () => ({});\n",
    "utf8",
  );
  return { distFile, root, srcFile };
}

function createPluginSdkAliasTargetFixture() {
  const fixture = createPluginSdkAliasFixture({
    distFile: "channel-runtime.js",
    packageExports: {
      "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
    },
    srcFile: "channel-runtime.ts",
  });
  const sourceRootAlias = path.join(fixture.root, "src", "plugin-sdk", "root-alias.cjs");
  const distRootAlias = path.join(fixture.root, "dist", "plugin-sdk", "root-alias.cjs");
  fs.writeFileSync(sourceRootAlias, "module.exports = {};\n", "utf8");
  fs.writeFileSync(distRootAlias, "module.exports = {};\n", "utf8");
  return { distRootAlias, fixture, sourceRootAlias };
}

function writePluginEntry(root: string, relativePath: string) {
  const pluginEntry = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(pluginEntry), { recursive: true });
  fs.writeFileSync(pluginEntry, 'export const plugin = "demo";\n', "utf8");
  return pluginEntry;
}

function createUserInstalledPluginSdkAliasFixture() {
  const { fixture, sourceRootAlias } = createPluginSdkAliasTargetFixture();
  const externalPluginRoot = path.join(makeTempDir(), ".openclaw", "extensions", "demo");
  const externalPluginEntry = path.join(externalPluginRoot, "index.ts");
  mkdirSafeDir(externalPluginRoot);
  fs.writeFileSync(externalPluginEntry, 'export const plugin = "demo";\n', "utf8");
  return { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias };
}

function resolvePluginSdkAlias(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const run = () =>
    resolvePluginSdkAliasFile({
      argv1: params.argv1,
      distFile: params.distFile,
      modulePath: params.modulePath,
      srcFile: params.srcFile,
    });
  return params.env ? withEnv(params.env, run) : run();
}

function resolvePluginRuntimeModule(params: {
  modulePath: string;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const run = () =>
    resolvePluginRuntimeModulePath({
      argv1: params.argv1,
      modulePath: params.modulePath,
    });
  return params.env ? withEnv(params.env, run) : run();
}

function expectResolvedFixturePath(params: {
  resolved: string | null;
  fixture: { srcFile: string; distFile: string };
  expected: "src" | "dist";
}) {
  expect(params.resolved).toBe(
    params.expected === "dist" ? params.fixture.distFile : params.fixture.srcFile,
  );
}

function expectPluginSdkAliasTargets(
  aliases: Record<string, string | undefined>,
  params: {
    rootAliasPath: string;
    channelRuntimePath?: string;
  },
) {
  expect(fs.realpathSync(aliases["openclaw/plugin-sdk"] ?? "")).toBe(
    fs.realpathSync(params.rootAliasPath),
  );
  expect(fs.realpathSync(aliases["@openclaw/plugin-sdk"] ?? "")).toBe(
    fs.realpathSync(params.rootAliasPath),
  );
  if (params.channelRuntimePath) {
    expect(fs.realpathSync(aliases["openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(params.channelRuntimePath),
    );
    expect(fs.realpathSync(aliases["@openclaw/plugin-sdk/channel-runtime"] ?? "")).toBe(
      fs.realpathSync(params.channelRuntimePath),
    );
  }
}

function expectPluginSdkAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  srcFile: string;
  distFile: string;
  modulePath: (root: string) => string;
  argv1?: (root: string) => string;
  env?: NodeJS.ProcessEnv;
  expected: "src" | "dist";
}) {
  const resolved = resolvePluginSdkAlias({
    argv1: params.argv1?.(params.fixture.root),
    distFile: params.distFile,
    env: params.env,
    modulePath: params.modulePath(params.fixture.root),
    srcFile: params.srcFile,
  });
  expectResolvedFixturePath({
    expected: params.expected,
    fixture: params.fixture,
    resolved,
  });
}

function expectExtensionApiAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  modulePath: (root: string) => string;
  argv1?: (root: string) => string;
  env?: NodeJS.ProcessEnv;
  expected: "src" | "dist";
}) {
  const resolved = withEnv(params.env ?? {}, () =>
    resolveExtensionApiAlias({
      argv1: params.argv1?.(params.fixture.root),
      modulePath: params.modulePath(params.fixture.root),
    }),
  );
  expectResolvedFixturePath({
    expected: params.expected,
    fixture: params.fixture,
    resolved,
  });
}

function expectExportedSubpaths(params: {
  fixture: { root: string };
  modulePath: string;
  expected: readonly string[];
  cwd?: string;
}) {
  const run = () =>
    listPluginSdkExportedSubpaths({
      modulePath: params.modulePath,
    });
  const subpaths = params.cwd ? withCwd(params.cwd, run) : run();
  expect(subpaths).toEqual(params.expected);
}

function expectCwdFallbackPluginSdkAliasResolution(params: {
  fixture: { root: string; srcFile: string; distFile: string };
  expected: "src" | "dist" | null;
}) {
  const resolved = withCwd(params.fixture.root, () =>
    resolvePluginSdkAlias({
      distFile: "channel-runtime.js",
      env: { NODE_ENV: undefined },
      modulePath: "/tmp/tsx-cache/openclaw-loader.js",
      srcFile: "channel-runtime.ts",
    }),
  );
  if (params.expected === null) {
    expect(resolved).toBeNull();
    return;
  }
  expectResolvedFixturePath({
    expected: params.expected,
    fixture: params.fixture,
    resolved,
  });
}

afterAll(() => {
  cleanupTrackedTempDirs(fixtureTempDirs);
});

describe("plugin sdk alias helpers", () => {
  it.each([
    {
      buildFixture: () => createPluginSdkAliasFixture(),
      distFile: "index.js",
      expected: "dist" as const,
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      name: "prefers dist plugin-sdk alias when loader runs from dist",
      srcFile: "index.ts",
    },
    {
      buildFixture: () => createPluginSdkAliasFixture(),
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      name: "prefers src plugin-sdk alias when loader runs from src in non-production",
      srcFile: "index.ts",
    },
    {
      buildFixture: () => {
        const fixture = createPluginSdkAliasFixture();
        fs.rmSync(fixture.distFile);
        return fixture;
      },
      distFile: "index.js",
      env: { NODE_ENV: "production", VITEST: undefined },
      expected: "src" as const,
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      name: "falls back to src plugin-sdk alias when dist is missing in production",
      srcFile: "index.ts",
    },
    {
      buildFixture: () =>
        createPluginSdkAliasFixture({
          distBody: "module.exports = {};\n",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          srcFile: "root-alias.cjs",
        }),
      distFile: "root-alias.cjs",
      expected: "dist" as const,
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      name: "prefers dist root-alias shim when loader runs from dist",
      srcFile: "root-alias.cjs",
    },
    {
      buildFixture: () =>
        createPluginSdkAliasFixture({
          distBody: "module.exports = {};\n",
          distFile: "root-alias.cjs",
          srcBody: "module.exports = {};\n",
          srcFile: "root-alias.cjs",
        }),
      distFile: "root-alias.cjs",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      name: "prefers src root-alias shim when loader runs from src in non-production",
      srcFile: "root-alias.cjs",
    },
    {
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      buildFixture: () =>
        createPluginSdkAliasFixture({
          packageExports: {
            "./plugin-sdk/index": { default: "./dist/plugin-sdk/index.js" },
          },
        }),
      distFile: "index.js",
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      name: "resolves plugin-sdk alias from package root when loader runs from transpiler cache path",
      srcFile: "index.ts",
    },
  ])("$name", ({ buildFixture, modulePath, argv1, srcFile, distFile, env, expected }) => {
    const fixture = buildFixture();
    expectPluginSdkAliasResolution({
      argv1,
      distFile,
      env,
      expected,
      fixture,
      modulePath,
      srcFile,
    });
  });

  it.each([
    {
      expected: "dist" as const,
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      name: "prefers dist extension-api alias when loader runs from dist",
    },
    {
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: (root: string) => path.join(root, "src", "plugins", "loader.ts"),
      name: "prefers src extension-api alias when loader runs from src in non-production",
    },
    {
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      name: "resolves extension-api alias from package root when loader runs from transpiler cache path",
    },
  ])("$name", ({ modulePath, argv1, env, expected }) => {
    const fixture = createExtensionApiAliasFixture();
    expectExtensionApiAliasResolution({
      argv1,
      env,
      expected,
      fixture,
      modulePath,
    });
  });

  it.each([
    {
      env: { NODE_ENV: "production", VITEST: undefined },
      expectedFirst: "dist" as const,
      name: "prefers dist candidates first for production src runtime",
    },
    {
      env: { NODE_ENV: undefined },
      expectedFirst: "src" as const,
      name: "prefers src candidates first for non-production src runtime",
    },
  ])("$name", ({ env, expectedFirst }) => {
    const fixture = createPluginSdkAliasFixture();
    const candidates = withEnv(env ?? {}, () =>
      listPluginSdkAliasCandidates({
        distFile: "index.js",
        modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
        srcFile: "index.ts",
      }),
    );
    const first = expectedFirst === "dist" ? fixture.distFile : fixture.srcFile;
    const second = expectedFirst === "dist" ? fixture.srcFile : fixture.distFile;
    expect(candidates.indexOf(first)).toBeLessThan(candidates.indexOf(second));
  });

  it("derives plugin-sdk subpaths from package exports", () => {
    const fixture = createPluginSdkAliasFixture({
      packageExports: {
        "./plugin-sdk/..\\..\\evil": { default: "./dist/plugin-sdk/evil.js" },
        "./plugin-sdk/.hidden": { default: "./dist/plugin-sdk/hidden.js" },
        "./plugin-sdk/C:temp": { default: "./dist/plugin-sdk/drive.js" },
        "./plugin-sdk/compat": { default: "./dist/plugin-sdk/compat.js" },
        "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
        "./plugin-sdk/nested/value": { default: "./dist/plugin-sdk/nested/value.js" },
      },
    });
    const subpaths = listPluginSdkExportedSubpaths({
      modulePath: path.join(fixture.root, "src", "plugins", "loader.ts"),
    });
    expect(subpaths).toEqual(["compat", "core"]);
  });

  it.each([
    {
      expected: [],
      fixture: () =>
        createPluginSdkAliasFixture({
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
          },
          trustedRootIndicators: false,
        }),
      name: "does not derive plugin-sdk subpaths from cwd fallback when package root is not an OpenClaw root",
    },
    {
      expected: ["channel-runtime", "core"],
      fixture: () =>
        createPluginSdkAliasFixture({
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
            "./plugin-sdk/core": { default: "./dist/plugin-sdk/core.js" },
          },
          trustedRootIndicatorMode: "cli-entry-only",
        }),
      name: "derives plugin-sdk subpaths via cwd fallback when trusted root indicator is cli-entry export",
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    expectExportedSubpaths({
      cwd: fixture.root,
      expected,
      fixture,
      modulePath: "/tmp/tsx-cache/openclaw-loader.js",
    });
  });

  it("builds plugin-sdk aliases from the module being loaded, not the loader location", () => {
    const { fixture, sourceRootAlias, distRootAlias } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const sourceAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry),
    );
    expectPluginSdkAliasTargets(sourceAliases, {
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
      rootAliasPath: sourceRootAlias,
    });

    const distPluginEntry = writePluginEntry(
      fixture.root,
      bundledDistPluginFile("demo", "index.js"),
    );

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(distPluginEntry),
    );
    expectPluginSdkAliasTargets(distAliases, {
      channelRuntimePath: path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js"),
      rootAliasPath: distRootAlias,
    });
  });

  it("applies explicit dist resolution to plugin-sdk subpath aliases too", () => {
    const { fixture, distRootAlias } = createPluginSdkAliasTargetFixture();
    const sourcePluginEntry = writePluginEntry(
      fixture.root,
      bundledPluginFile("demo", "src/index.ts"),
    );

    const distAliases = withEnv({ NODE_ENV: undefined }, () =>
      buildPluginLoaderAliasMap(sourcePluginEntry, undefined, undefined, "dist"),
    );

    expectPluginSdkAliasTargets(distAliases, {
      channelRuntimePath: path.join(fixture.root, "dist", "plugin-sdk", "channel-runtime.js"),
      rootAliasPath: distRootAlias,
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via the running openclaw argv hint", () => {
    const { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias } =
      createUserInstalledPluginSdkAliasFixture();

    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(externalPluginEntry, path.join(fixture.root, "openclaw.mjs")),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
      rootAliasPath: sourceRootAlias,
    });
  });

  it("resolves plugin-sdk aliases for user-installed plugins via moduleUrl hint", () => {
    const { externalPluginEntry, externalPluginRoot, fixture, sourceRootAlias } =
      createUserInstalledPluginSdkAliasFixture();

    // Simulate loader.ts passing its own import.meta.url as the moduleUrl hint.
    // This covers installations where argv1 does not resolve to the openclaw root
    // (e.g. single-binary distributions or custom process launchers).
    // Use openclaw.mjs which is created by createPluginSdkAliasFixture (bin+marker mode).
    // Use fixture.root as cwd so process.cwd() fallback also resolves to fixture, not the
    // Real openclaw repo root in the test runner environment.
    const loaderModuleUrl = pathToFileURL(path.join(fixture.root, "openclaw.mjs")).href;

    // Use externalPluginRoot as cwd so process.cwd() fallback cannot accidentally
    // Resolve to the fixture root — only the moduleUrl hint can bridge the gap.
    // Pass "" for argv1: undefined would trigger the STARTUP_ARGV1 default (the vitest
    // Runner binary, inside the openclaw repo), which resolves before moduleUrl is checked.
    // An empty string is falsy so resolveTrustedOpenClawRootFromArgvHint returns null,
    // Meaning only the moduleUrl hint can bridge the gap.
    const aliases = withCwd(externalPluginRoot, () =>
      withEnv({ NODE_ENV: undefined }, () =>
        buildPluginLoaderAliasMap(
          externalPluginEntry,
          "", // Explicitly disable argv1 (empty string bypasses STARTUP_ARGV1 default)
          loaderModuleUrl,
        ),
      ),
    );

    expectPluginSdkAliasTargets(aliases, {
      channelRuntimePath: path.join(fixture.root, "src", "plugin-sdk", "channel-runtime.ts"),
      rootAliasPath: sourceRootAlias,
    });
  });

  it.each([
    {
      expected: null,
      fixture: () =>
        createPluginSdkAliasFixture({
          distFile: "channel-runtime.js",
          packageExports: {
            "./plugin-sdk/channel-runtime": { default: "./dist/plugin-sdk/channel-runtime.js" },
          },
          srcFile: "channel-runtime.ts",
          trustedRootIndicators: false,
        }),
      name: "does not resolve plugin-sdk alias files from cwd fallback when package root is not an OpenClaw root",
    },
  ] as const)("$name", ({ fixture: buildFixture, expected }) => {
    const fixture = buildFixture();
    expectCwdFallbackPluginSdkAliasResolution({
      expected,
      fixture,
    });
  });

  it("configures the plugin loader jiti boundary to prefer native dist modules", () => {
    const options = buildPluginLoaderJitiOptions({});

    expect(options.tryNative).toBe(true);
    expect(options.interopDefault).toBe(true);
    expect(options.extensions).toContain(".js");
    expect(options.extensions).toContain(".ts");
    expect("alias" in options).toBe(false);
  });

  it("uses transpiled Jiti loads for source TypeScript plugin entries", () => {
    expect(shouldPreferNativeJiti("/repo/dist/plugins/runtime/index.js")).toBe(true);
    expect(
      shouldPreferNativeJiti(`/repo/${bundledPluginFile("discord", "src/channel.runtime.ts")}`),
    ).toBe(false);
  });

  it("disables native Jiti loads under Bun even for built JavaScript entries", () => {
    const originalVersions = process.versions;
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: {
        ...originalVersions,
        bun: "1.2.0",
      },
    });

    try {
      expect(shouldPreferNativeJiti("/repo/dist/plugins/runtime/index.js")).toBe(false);
      expect(shouldPreferNativeJiti(`/repo/${bundledDistPluginFile("browser", "index.js")}`)).toBe(
        false,
      );
    } finally {
      Object.defineProperty(process, "versions", {
        configurable: true,
        value: originalVersions,
      });
    }
  });

  it("disables native Jiti loads on Windows even for built JavaScript entries", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      expect(shouldPreferNativeJiti("/repo/dist/plugins/runtime/index.js")).toBe(false);
      expect(shouldPreferNativeJiti(`/repo/${bundledDistPluginFile("browser", "index.js")}`)).toBe(
        false,
      );
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("keeps plugin loader dist shortcuts off on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      expect(
        resolvePluginLoaderJitiTryNative(`/repo/${bundledDistPluginFile("browser", "index.js")}`, {
          preferBuiltDist: true,
        }),
      ).toBe(false);
      expect(
        resolvePluginLoaderJitiTryNative(`/repo/${bundledDistPluginFile("browser", "helper.ts")}`, {
          preferBuiltDist: true,
        }),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("allows plugin loader dist shortcuts on non-Windows hosts", () => {
    expect(
      resolvePluginLoaderJitiTryNative(`/repo/${bundledDistPluginFile("browser", "index.js")}`, {
        preferBuiltDist: true,
      }),
    ).toBe(true);
    expect(
      resolvePluginLoaderJitiTryNative(`/repo/${bundledDistPluginFile("browser", "helper.ts")}`, {
        preferBuiltDist: true,
      }),
    ).toBe(true);
  });

  it("keeps plugin loader Jiti cache keys stable across alias insertion order", () => {
    expect(
      createPluginLoaderJitiCacheKey({
        aliasMap: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
        tryNative: true,
      }),
    ).toBe(
      createPluginLoaderJitiCacheKey({
        aliasMap: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
        tryNative: true,
      }),
    );
  });

  it("returns plugin loader Jiti config with stable cache keys", () => {
    const first = resolvePluginLoaderJitiConfig({
      argv1: "/repo/openclaw.mjs",
      modulePath: `/repo/${bundledDistPluginFile("browser", "index.js")}`,
      moduleUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      preferBuiltDist: true,
    });
    const second = resolvePluginLoaderJitiConfig({
      argv1: "/repo/openclaw.mjs",
      modulePath: `/repo/${bundledDistPluginFile("browser", "index.js")}`,
      moduleUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      preferBuiltDist: true,
    });

    expect(second).toEqual(first);
  });

  it("detects bundled plugin extension paths across source and dist roots", () => {
    expect(
      isBundledPluginExtensionPath({
        modulePath: "/repo/extensions/demo/api.js",
        openClawPackageRoot: "/repo",
      }),
    ).toBe(true);
    expect(
      isBundledPluginExtensionPath({
        modulePath: "/repo/dist/extensions/demo/api.js",
        openClawPackageRoot: "/repo",
      }),
    ).toBe(true);
    expect(
      isBundledPluginExtensionPath({
        modulePath: "/repo/vendor/demo/api.js",
        openClawPackageRoot: "/repo",
      }),
    ).toBe(false);
  });

  it("normalizes Windows alias targets before handing them to Jiti", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });

    try {
      expect(normalizeJitiAliasTargetPath(String.raw`C:\repo\dist\plugin-sdk\root-alias.cjs`)).toBe(
        "C:/repo/dist/plugin-sdk/root-alias.cjs",
      );
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("loads source runtime shims through the non-native Jiti boundary", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), bundledPluginRoot("discord"));
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafeDir(copiedSourceDir);
    mkdirSafeDir(copiedPluginSdkDir);
    const jitiBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(jitiBaseFile, "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "@openclaw/plugin-sdk/infra-runtime";

export const syntheticRuntimeMarker = {
  resolveOutboundSendDep,
};
`,
      "utf8",
    );
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "infra-runtime.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf8",
    );
    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const jitiBaseUrl = pathToFileURL(jitiBaseFile).href;

    const createJiti = await getCreateJiti();
    const withoutAlias = createJiti(jitiBaseUrl, {
      ...buildPluginLoaderJitiOptions({}),
      tryNative: false,
    });
    expect(() => withoutAlias(copiedChannelRuntime)).toThrow();

    const withAlias = createJiti(jitiBaseUrl, {
      ...buildPluginLoaderJitiOptions({
        "@openclaw/plugin-sdk/infra-runtime": copiedChannelRuntimeShim,
        "openclaw/plugin-sdk/infra-runtime": copiedChannelRuntimeShim,
      }),
      tryNative: false,
    });
    expect(withAlias(copiedChannelRuntime)).toMatchObject({
      syntheticRuntimeMarker: {
        resolveOutboundSendDep: expect.any(Function),
      },
    });
  }, 240_000);

  it.each([
    {
      expected: "dist" as const,
      modulePath: (root: string) => path.join(root, "dist", "plugins", "loader.js"),
      name: "prefers dist plugin runtime module when loader runs from dist",
    },
    {
      argv1: (root: string) => path.join(root, "openclaw.mjs"),
      env: { NODE_ENV: undefined },
      expected: "src" as const,
      modulePath: () => "/tmp/tsx-cache/openclaw-loader.js",
      name: "resolves plugin runtime module from package root when loader runs from transpiler cache path",
    },
  ])("$name", ({ modulePath, argv1, env, expected }) => {
    const fixture = createPluginRuntimeAliasFixture();
    const resolved = resolvePluginRuntimeModule({
      argv1: argv1?.(fixture.root),
      env,
      modulePath: modulePath(fixture.root),
    });
    expect(resolved).toBe(expected === "dist" ? fixture.distFile : fixture.srcFile);
  });
});
