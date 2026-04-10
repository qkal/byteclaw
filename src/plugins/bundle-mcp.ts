import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import {
  inspectBundleServerRuntimeSupport,
  loadEnabledBundleConfig,
  readBundleJsonObject,
  resolveBundleJsonOpenFailure,
} from "./bundle-config-shared.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
  normalizeBundlePathList,
} from "./bundle-manifest.js";
import type { PluginBundleFormat } from "./types.js";

export type BundleMcpServerConfig = Record<string, unknown>;

export interface BundleMcpConfig {
  mcpServers: Record<string, BundleMcpServerConfig>;
}

export interface BundleMcpDiagnostic {
  pluginId: string;
  message: string;
}

export interface EnabledBundleMcpConfigResult {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
}
export interface BundleMcpRuntimeSupport {
  hasSupportedStdioServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
}

const MANIFEST_PATH_BY_FORMAT: Record<PluginBundleFormat, string> = {
  claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  codex: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  cursor: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
};
const CLAUDE_PLUGIN_ROOT_PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";

function resolveBundleMcpConfigPaths(params: {
  raw: Record<string, unknown>;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): string[] {
  const declared = normalizeBundlePathList(params.raw.mcpServers);
  const defaults = fs.existsSync(path.join(params.rootDir, ".mcp.json")) ? [".mcp.json"] : [];
  if (params.bundleFormat === "claude") {
    return mergeBundlePathLists(defaults, declared);
  }
  return mergeBundlePathLists(defaults, declared);
}

export function extractMcpServerMap(raw: unknown): Record<string, BundleMcpServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.mcpServers)
    ? raw.mcpServers
    : isRecord(raw.servers)
      ? raw.servers
      : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleMcpServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

function isExplicitRelativePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
}

function expandBundleRootPlaceholders(value: string, rootDir: string): string {
  if (!value.includes(CLAUDE_PLUGIN_ROOT_PLACEHOLDER)) {
    return value;
  }
  return value.split(CLAUDE_PLUGIN_ROOT_PLACEHOLDER).join(rootDir);
}

function normalizeBundlePath(targetPath: string): string {
  return path.normalize(path.resolve(targetPath));
}

function normalizeExpandedAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : value;
}

function absolutizeBundleMcpServer(params: {
  rootDir: string;
  baseDir: string;
  server: BundleMcpServerConfig;
}): BundleMcpServerConfig {
  const next: BundleMcpServerConfig = { ...params.server };

  if (typeof next.cwd !== "string" && typeof next.workingDirectory !== "string") {
    next.cwd = params.baseDir;
  }

  const { command } = next;
  if (typeof command === "string") {
    const expanded = expandBundleRootPlaceholders(command, params.rootDir);
    next.command = isExplicitRelativePath(expanded)
      ? path.resolve(params.baseDir, expanded)
      : normalizeExpandedAbsolutePath(expanded);
  }

  const { cwd } = next;
  if (typeof cwd === "string") {
    const expanded = expandBundleRootPlaceholders(cwd, params.rootDir);
    next.cwd = path.isAbsolute(expanded) ? expanded : path.resolve(params.baseDir, expanded);
  }

  const { workingDirectory } = next;
  if (typeof workingDirectory === "string") {
    const expanded = expandBundleRootPlaceholders(workingDirectory, params.rootDir);
    next.workingDirectory = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(params.baseDir, expanded);
  }

  if (Array.isArray(next.args)) {
    next.args = next.args.map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const expanded = expandBundleRootPlaceholders(entry, params.rootDir);
      if (!isExplicitRelativePath(expanded)) {
        return normalizeExpandedAbsolutePath(expanded);
      }
      return path.resolve(params.baseDir, expanded);
    });
  }

  if (isRecord(next.env)) {
    next.env = Object.fromEntries(
      Object.entries(next.env).map(([key, value]) => [
        key,
        typeof value === "string"
          ? normalizeExpandedAbsolutePath(expandBundleRootPlaceholders(value, params.rootDir))
          : value,
      ]),
    );
  }

  return next;
}

function loadBundleFileBackedMcpConfig(params: {
  rootDir: string;
  relativePath: string;
}): BundleMcpConfig {
  const rootDir = normalizeBundlePath(params.rootDir);
  const absolutePath = path.resolve(rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
    rootPath: rootDir,
  });
  if (!opened.ok) {
    return { mcpServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { mcpServers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf8")) as unknown;
    const servers = extractMcpServerMap(raw);
    const baseDir = normalizeBundlePath(path.dirname(absolutePath));
    return {
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([serverName, server]) => [
          serverName,
          absolutizeBundleMcpServer({ baseDir, rootDir, server }),
        ]),
      ),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

function loadBundleInlineMcpConfig(params: {
  raw: Record<string, unknown>;
  baseDir: string;
}): BundleMcpConfig {
  if (!isRecord(params.raw.mcpServers)) {
    return { mcpServers: {} };
  }
  const baseDir = normalizeBundlePath(params.baseDir);
  const servers = extractMcpServerMap(params.raw.mcpServers);
  return {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([serverName, server]) => [
        serverName,
        absolutizeBundleMcpServer({ baseDir, rootDir: baseDir, server }),
      ]),
    ),
  };
}

function loadBundleMcpConfig(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): { config: BundleMcpConfig; diagnostics: string[] } {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  const manifestLoaded = readBundleJsonObject({
    onOpenFailure: (failure) =>
      resolveBundleJsonOpenFailure({
        allowMissing: params.bundleFormat === "claude",
        failure,
        relativePath: manifestRelativePath,
      }),
    relativePath: manifestRelativePath,
    rootDir: params.rootDir,
  });
  if (!manifestLoaded.ok) {
    return { config: { mcpServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleMcpConfig = { mcpServers: {} };
  const filePaths = resolveBundleMcpConfigPaths({
    bundleFormat: params.bundleFormat,
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
  });
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      loadBundleFileBackedMcpConfig({
        relativePath,
        rootDir: params.rootDir,
      }),
    ) as BundleMcpConfig;
  }

  merged = applyMergePatch(
    merged,
    loadBundleInlineMcpConfig({
      baseDir: params.rootDir,
      raw: manifestLoaded.raw,
    }),
  ) as BundleMcpConfig;

  return { config: merged, diagnostics: [] };
}

export function inspectBundleMcpRuntimeSupport(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): BundleMcpRuntimeSupport {
  const support = inspectBundleServerRuntimeSupport({
    loaded: loadBundleMcpConfig(params),
    resolveServers: (config) => config.mcpServers,
  });
  return {
    diagnostics: support.diagnostics,
    hasSupportedStdioServer: support.hasSupportedServer,
    supportedServerNames: support.supportedServerNames,
    unsupportedServerNames: support.unsupportedServerNames,
  };
}

export function loadEnabledBundleMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EnabledBundleMcpConfigResult {
  return loadEnabledBundleConfig({
    cfg: params.cfg,
    createDiagnostic: (pluginId, message) => ({ message, pluginId }),
    createEmptyConfig: () => ({ mcpServers: {} }),
    loadBundleConfig: loadBundleMcpConfig,
    workspaceDir: params.workspaceDir,
  });
}
