import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type PluginSdkAliasCandidateKind = "dist" | "src";
export type PluginSdkResolutionPreference = "auto" | "dist" | "src";

export interface LoaderModuleResolveParams {
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}

interface PluginSdkPackageJson {
  exports?: Record<string, unknown>;
  bin?: string | Record<string, unknown>;
}

const STARTUP_ARGV1 = process.argv[1];

export function normalizeJitiAliasTargetPath(targetPath: string): string {
  return process.platform === "win32" ? targetPath.replace(/\\/g, "/") : targetPath;
}

function resolveLoaderModulePath(params: LoaderModuleResolveParams = {}): string {
  return params.modulePath ?? fileURLToPath(params.moduleUrl ?? import.meta.url);
}

function readPluginSdkPackageJson(packageRoot: string): PluginSdkPackageJson | null {
  try {
    const pkgRaw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    return JSON.parse(pkgRaw) as PluginSdkPackageJson;
  } catch {
    return null;
  }
}

function isSafePluginSdkSubpathSegment(subpath: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function listPluginSdkSubpathsFromPackageJson(pkg: PluginSdkPackageJson): string[] {
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .filter((subpath) => isSafePluginSdkSubpathSegment(subpath))
    .toSorted();
}

function hasTrustedOpenClawRootIndicator(params: {
  packageRoot: string;
  packageJson: PluginSdkPackageJson;
}): boolean {
  const packageExports = params.packageJson.exports ?? {};
  const hasPluginSdkRootExport = Object.hasOwn(packageExports, "./plugin-sdk");
  if (!hasPluginSdkRootExport) {
    return false;
  }
  const hasCliEntryExport = Object.hasOwn(packageExports, "./cli-entry");
  const hasOpenClawBin =
    (typeof params.packageJson.bin === "string" &&
      normalizeLowercaseStringOrEmpty(params.packageJson.bin).includes("openclaw")) ||
    (typeof params.packageJson.bin === "object" &&
      params.packageJson.bin !== null &&
      typeof params.packageJson.bin.openclaw === "string");
  const hasOpenClawEntrypoint = fs.existsSync(path.join(params.packageRoot, "openclaw.mjs"));
  return hasCliEntryExport || hasOpenClawBin || hasOpenClawEntrypoint;
}

function readPluginSdkSubpathsFromPackageRoot(packageRoot: string): string[] | null {
  const pkg = readPluginSdkPackageJson(packageRoot);
  if (!pkg) {
    return null;
  }
  if (!hasTrustedOpenClawRootIndicator({ packageJson: pkg, packageRoot })) {
    return null;
  }
  const subpaths = listPluginSdkSubpathsFromPackageJson(pkg);
  return subpaths.length > 0 ? subpaths : null;
}

function resolveTrustedOpenClawRootFromArgvHint(params: {
  argv1?: string;
  cwd: string;
}): string | null {
  if (!params.argv1) {
    return null;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: params.argv1,
    cwd: params.cwd,
  });
  if (!packageRoot) {
    return null;
  }
  const packageJson = readPluginSdkPackageJson(packageRoot);
  if (!packageJson) {
    return null;
  }
  return hasTrustedOpenClawRootIndicator({ packageJson, packageRoot }) ? packageRoot : null;
}

function findNearestPluginSdkPackageRoot(startDir: string, maxDepth = 12): string | null {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const subpaths = readPluginSdkSubpathsFromPackageRoot(cursor);
    if (subpaths) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

export function resolveLoaderPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  const fromModulePath = resolveOpenClawPackageRootSync({ cwd });
  if (fromModulePath) {
    return fromModulePath;
  }
  const argv1 = params.argv1 ?? process.argv[1];
  const moduleUrl = params.moduleUrl ?? (params.modulePath ? undefined : import.meta.url);
  return resolveOpenClawPackageRootSync({
    cwd,
    ...(argv1 ? { argv1 } : {}),
    ...(moduleUrl ? { moduleUrl } : {}),
  });
}

function resolveLoaderPluginSdkPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  const fromCwd = resolveOpenClawPackageRootSync({ cwd });
  const fromExplicitHints =
    resolveTrustedOpenClawRootFromArgvHint({ argv1: params.argv1, cwd }) ??
    (params.moduleUrl
      ? resolveOpenClawPackageRootSync({
          cwd,
          moduleUrl: params.moduleUrl,
        })
      : null);
  return (
    fromCwd ??
    fromExplicitHints ??
    findNearestPluginSdkPackageRoot(path.dirname(params.modulePath)) ??
    (params.cwd ? findNearestPluginSdkPackageRoot(params.cwd) : null) ??
    findNearestPluginSdkPackageRoot(process.cwd())
  );
}

export function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginSdkAliasCandidateKind[] {
  if (params.pluginSdkResolution === "dist") {
    return ["dist", "src"];
  }
  if (params.pluginSdkResolution === "src") {
    return ["src", "dist"];
  }
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = normalizedModulePath.includes("/dist/");
  return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}

export function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    isProduction: process.env.NODE_ENV === "production",
    modulePath: params.modulePath,
    pluginSdkResolution: params.pluginSdkResolution,
  });
  const packageRoot = resolveLoaderPluginSdkPackageRoot(params);
  if (packageRoot) {
    const candidateMap = {
      dist: path.join(packageRoot, "dist", "plugin-sdk", params.distFile),
      src: path.join(packageRoot, "src", "plugin-sdk", params.srcFile),
    } as const;
    return orderedKinds.map((kind) => candidateMap[kind]);
  }
  let cursor = path.dirname(params.modulePath);
  const candidates: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const candidateMap = {
      dist: path.join(cursor, "dist", "plugin-sdk", params.distFile),
      src: path.join(cursor, "src", "plugin-sdk", params.srcFile),
    } as const;
    for (const kind of orderedKinds) {
      candidates.push(candidateMap[kind]);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return candidates;
}

export function resolvePluginSdkAliasFile(params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    for (const candidate of listPluginSdkAliasCandidates({
      argv1: params.argv1,
      cwd: params.cwd,
      distFile: params.distFile,
      modulePath,
      moduleUrl: params.moduleUrl,
      pluginSdkResolution: params.pluginSdkResolution,
      srcFile: params.srcFile,
    })) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

const cachedPluginSdkExportedSubpaths = new Map<string, string[]>();
const cachedPluginSdkScopedAliasMaps = new Map<string, Record<string, string>>();
const PLUGIN_SDK_PACKAGE_NAMES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;

export function listPluginSdkExportedSubpaths(
  params: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
  } = {},
): string[] {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveLoaderPluginSdkPackageRoot({
    argv1: params.argv1,
    modulePath,
    moduleUrl: params.moduleUrl,
  });
  if (!packageRoot) {
    return [];
  }
  const cached = cachedPluginSdkExportedSubpaths.get(packageRoot);
  if (cached) {
    return cached;
  }
  const subpaths = readPluginSdkSubpathsFromPackageRoot(packageRoot) ?? [];
  cachedPluginSdkExportedSubpaths.set(packageRoot, subpaths);
  return subpaths;
}

export function resolvePluginSdkScopedAliasMap(
  params: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    pluginSdkResolution?: PluginSdkResolutionPreference;
  } = {},
): Record<string, string> {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveLoaderPluginSdkPackageRoot({
    argv1: params.argv1,
    modulePath,
    moduleUrl: params.moduleUrl,
  });
  if (!packageRoot) {
    return {};
  }
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    isProduction: process.env.NODE_ENV === "production",
    modulePath,
    pluginSdkResolution: params.pluginSdkResolution,
  });
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}`;
  const cached = cachedPluginSdkScopedAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const aliasMap: Record<string, string> = {};
  for (const subpath of listPluginSdkExportedSubpaths({
    argv1: params.argv1,
    modulePath,
    moduleUrl: params.moduleUrl,
    pluginSdkResolution: params.pluginSdkResolution,
  })) {
    const candidateMap = {
      dist: path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`),
      src: path.join(packageRoot, "src", "plugin-sdk", `${subpath}.ts`),
    } as const;
    for (const kind of orderedKinds) {
      const candidate = candidateMap[kind];
      if (fs.existsSync(candidate)) {
        for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
          aliasMap[`${packageName}/${subpath}`] = candidate;
        }
        break;
      }
    }
  }
  cachedPluginSdkScopedAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

export function resolveExtensionApiAlias(params: LoaderModuleResolveParams = {}): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    const packageRoot = resolveLoaderPackageRoot({ ...params, modulePath });
    if (!packageRoot) {
      return null;
    }

    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      isProduction: process.env.NODE_ENV === "production",
      modulePath,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    const candidateMap = {
      dist: path.join(packageRoot, "dist", "extensionAPI.js"),
      src: path.join(packageRoot, "src", "extensionAPI.ts"),
    } as const;
    for (const kind of orderedKinds) {
      const candidate = candidateMap[kind];
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

export function buildPluginLoaderAliasMap(
  modulePath: string,
  argv1: string | undefined = STARTUP_ARGV1,
  moduleUrl?: string,
  pluginSdkResolution: PluginSdkResolutionPreference = "auto",
): Record<string, string> {
  const pluginSdkAlias = resolvePluginSdkAliasFile({
    argv1,
    distFile: "root-alias.cjs",
    modulePath,
    moduleUrl,
    pluginSdkResolution,
    srcFile: "root-alias.cjs",
  });
  const extensionApiAlias = resolveExtensionApiAlias({ modulePath, pluginSdkResolution });
  return {
    ...(extensionApiAlias
      ? { "openclaw/extension-api": normalizeJitiAliasTargetPath(extensionApiAlias) }
      : {}),
    ...(pluginSdkAlias
      ? Object.fromEntries(
          PLUGIN_SDK_PACKAGE_NAMES.map((packageName) => [
            packageName,
            normalizeJitiAliasTargetPath(pluginSdkAlias),
          ]),
        )
      : {}),
    ...Object.fromEntries(
      Object.entries(
        resolvePluginSdkScopedAliasMap({ argv1, modulePath, moduleUrl, pluginSdkResolution }),
      ).map(([key, value]) => [key, normalizeJitiAliasTargetPath(value)]),
    ),
  };
}

export function resolvePluginRuntimeModulePath(
  params: LoaderModuleResolveParams = {},
): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      isProduction: process.env.NODE_ENV === "production",
      modulePath,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    const packageRoot = resolveLoaderPackageRoot({ ...params, modulePath });
    const candidates = packageRoot
      ? orderedKinds.map((kind) =>
          kind === "src"
            ? path.join(packageRoot, "src", "plugins", "runtime", "index.ts")
            : path.join(packageRoot, "dist", "plugins", "runtime", "index.js"),
        )
      : [
          path.join(path.dirname(modulePath), "runtime", "index.ts"),
          path.join(path.dirname(modulePath), "runtime", "index.js"),
        ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

export function buildPluginLoaderJitiOptions(aliasMap: Record<string, string>) {
  return {
    interopDefault: true,
    // Prefer Node's native sync ESM loader for built dist/*.js modules so
    // Bundled plugins and plugin-sdk subpaths stay on the canonical module graph.
    tryNative: true,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(Object.keys(aliasMap).length > 0
      ? {
          alias: aliasMap,
        }
      : {}),
  };
}

function supportsNativeJitiRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun !== "string" && process.platform !== "win32";
}

export function shouldPreferNativeJiti(modulePath: string): boolean {
  if (!supportsNativeJitiRuntime()) {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(path.extname(modulePath))) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".json": {
      return true;
    }
    default: {
      return false;
    }
  }
}

export function resolvePluginLoaderJitiTryNative(
  modulePath: string,
  options?: {
    preferBuiltDist?: boolean;
  },
): boolean {
  return (
    shouldPreferNativeJiti(modulePath) ||
    (supportsNativeJitiRuntime() &&
      options?.preferBuiltDist === true &&
      modulePath.includes(`${path.sep}dist${path.sep}`))
  );
}

export function createPluginLoaderJitiCacheKey(params: {
  tryNative: boolean;
  aliasMap: Record<string, string>;
}): string {
  return JSON.stringify({
    aliasMap: Object.entries(params.aliasMap).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
    tryNative: params.tryNative,
  });
}

export function resolvePluginLoaderJitiConfig(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl: string;
  preferBuiltDist?: boolean;
}): {
  tryNative: boolean;
  aliasMap: Record<string, string>;
  cacheKey: string;
} {
  const tryNative = resolvePluginLoaderJitiTryNative(
    params.modulePath,
    params.preferBuiltDist ? { preferBuiltDist: true } : {},
  );
  const aliasMap = buildPluginLoaderAliasMap(params.modulePath, params.argv1, params.moduleUrl);
  return {
    aliasMap,
    cacheKey: createPluginLoaderJitiCacheKey({
      aliasMap,
      tryNative,
    }),
    tryNative,
  };
}

export function isBundledPluginExtensionPath(params: {
  modulePath: string;
  openClawPackageRoot: string;
  bundledPluginsDir?: string;
}): boolean {
  const normalizedModulePath = path.resolve(params.modulePath);
  const roots = [
    params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : null,
    path.join(params.openClawPackageRoot, "extensions"),
    path.join(params.openClawPackageRoot, "dist", "extensions"),
    path.join(params.openClawPackageRoot, "dist-runtime", "extensions"),
  ].filter((root): root is string => typeof root === "string");
  return roots.some(
    (root) =>
      normalizedModulePath === root || normalizedModulePath.startsWith(`${root}${path.sep}`),
  );
}
