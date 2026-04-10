import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./types.js";

type ReadBundleJsonResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

export interface BundleServerRuntimeSupport {
  hasSupportedServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
}

export function readBundleJsonObject(params: {
  rootDir: string;
  relativePath: string;
  onOpenFailure?: (
    failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>,
  ) => ReadBundleJsonResult;
}): ReadBundleJsonResult {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
    rootPath: params.rootDir,
  });
  if (!opened.ok) {
    return params.onOpenFailure?.(opened) ?? { ok: true, raw: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf8")) as unknown;
    if (!isRecord(raw)) {
      return { error: `${params.relativePath} must contain a JSON object`, ok: false };
    }
    return { ok: true, raw };
  } catch (error) {
    return { error: `failed to parse ${params.relativePath}: ${String(error)}`, ok: false };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function resolveBundleJsonOpenFailure(params: {
  failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>;
  relativePath: string;
  allowMissing?: boolean;
}): ReadBundleJsonResult {
  return matchBoundaryFileOpenFailure(params.failure, {
    fallback: (failure) => ({
      error: `unable to read ${params.relativePath}: ${failure.reason}`,
      ok: false,
    }),
    path: () => {
      if (params.allowMissing) {
        return { ok: true, raw: {} };
      }
      return { error: `unable to read ${params.relativePath}: path`, ok: false };
    },
  });
}

export function inspectBundleServerRuntimeSupport<TConfig>(params: {
  loaded: { config: TConfig; diagnostics: string[] };
  resolveServers: (config: TConfig) => Record<string, Record<string, unknown>>;
}): BundleServerRuntimeSupport {
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  let hasSupportedServer = false;
  for (const [serverName, server] of Object.entries(params.resolveServers(params.loaded.config))) {
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      hasSupportedServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    diagnostics: params.loaded.diagnostics,
    hasSupportedServer,
    supportedServerNames,
    unsupportedServerNames,
  };
}

export function loadEnabledBundleConfig<TConfig, TDiagnostic>(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  createEmptyConfig: () => TConfig;
  loadBundleConfig: (params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  }) => { config: TConfig; diagnostics: string[] };
  createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): { config: TConfig; diagnostics: TDiagnostic[] } {
  const registry = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  const diagnostics: TDiagnostic[] = [];
  let merged = params.createEmptyConfig();

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      config: normalizedPlugins,
      id: record.id,
      origin: record.origin,
      rootConfig: params.cfg,
    });
    if (!activationState.activated) {
      continue;
    }

    const loaded = params.loadBundleConfig({
      bundleFormat: record.bundleFormat,
      pluginId: record.id,
      rootDir: record.rootDir,
    });
    merged = applyMergePatch(merged, loaded.config) as TConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push(params.createDiagnostic(record.id, message));
    }
  }

  return { config: merged, diagnostics };
}
