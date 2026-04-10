import type { OpenClawConfig } from "../config/config.js";
import {
  expectedIntegrityForUpdate,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import { installPluginFromClawHub } from "./clawhub.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromNpmSpec,
  resolvePluginInstallDir,
} from "./install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";
import { installPluginFromMarketplace } from "./marketplace.js";

export interface PluginUpdateLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export interface PluginUpdateOutcome {
  pluginId: string;
  status: PluginUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
}

export interface PluginUpdateSummary {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
}

export interface PluginUpdateIntegrityDriftParams {
  pluginId: string;
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
}

export interface PluginChannelSyncSummary {
  switchedToBundled: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
}

export interface PluginChannelSyncResult {
  config: OpenClawConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
}

function formatNpmInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  result: { error: string; code?: string };
}): string {
  if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
  }
  return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}

function formatMarketplaceInstallFailure(params: {
  pluginId: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  phase: "check" | "update";
  error: string;
}): string {
  return (
    `Failed to ${params.phase} ${params.pluginId}: ` +
    `${params.error} (marketplace plugin ${params.marketplacePlugin} from ${params.marketplaceSource}).`
  );
}

function formatClawHubInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (ClawHub ${params.spec}).`;
}

interface InstallIntegrityDrift {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: {
    resolvedSpec?: string;
    version?: string;
  };
}

function pathsEqual(
  left: string | undefined,
  right: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!left || !right) {
    return false;
  }
  return resolveUserPath(left, env) === resolveUserPath(right, env);
}

function buildLoadPathHelpers(existing: string[], env: NodeJS.ProcessEnv = process.env) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (resolved.has(normalized)) {
      return;
    }
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (!resolved.has(normalized)) {
      return;
    }
    paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
    removePath,
  };
}

function replacePluginIdInList(
  entries: string[] | undefined,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (!entries || entries.length === 0 || fromId === toId) {
    return entries;
  }
  const next: string[] = [];
  for (const entry of entries) {
    const value = entry === fromId ? toId : entry;
    if (!next.includes(value)) {
      next.push(value);
    }
  }
  return next;
}

function migratePluginConfigId(cfg: OpenClawConfig, fromId: string, toId: string): OpenClawConfig {
  if (fromId === toId) {
    return cfg;
  }

  const installs = cfg.plugins?.installs;
  const entries = cfg.plugins?.entries;
  const slots = cfg.plugins?.slots;
  const allow = replacePluginIdInList(cfg.plugins?.allow, fromId, toId);
  const deny = replacePluginIdInList(cfg.plugins?.deny, fromId, toId);

  const nextInstalls = installs ? { ...installs } : undefined;
  if (nextInstalls && fromId in nextInstalls) {
    const record = nextInstalls[fromId];
    if (record && !(toId in nextInstalls)) {
      nextInstalls[toId] = record;
    }
    delete nextInstalls[fromId];
  }

  const nextEntries = entries ? { ...entries } : undefined;
  if (nextEntries && fromId in nextEntries) {
    const entry = nextEntries[fromId];
    if (entry) {
      nextEntries[toId] = nextEntries[toId]
        ? {
            ...entry,
            ...nextEntries[toId],
          }
        : entry;
    }
    delete nextEntries[fromId];
  }

  const nextSlots =
    slots?.memory === fromId
      ? {
          ...slots,
          memory: toId,
        }
      : slots;

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow,
      deny,
      entries: nextEntries,
      installs: nextInstalls,
      slots: nextSlots,
    },
  };
}

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: InstallIntegrityDrift) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      actualIntegrity: drift.actualIntegrity,
      dryRun: params.dryRun,
      expectedIntegrity: drift.expectedIntegrity,
      pluginId: params.pluginId,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      spec: drift.spec,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return true;
  };
}

export async function updateNpmInstalledPlugins(params: {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  dryRun?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        message: `Skipping "${pluginId}" (already updated).`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    const record = installs[pluginId];
    if (!record) {
      outcomes.push({
        message: `No install record for "${pluginId}".`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    if (record.source !== "npm" && record.source !== "marketplace" && record.source !== "clawhub") {
      outcomes.push({
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    const effectiveSpec =
      record.source === "npm" ? (params.specOverrides?.[pluginId] ?? record.spec) : record.spec;
    const expectedIntegrity =
      record.source === "npm" && effectiveSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;

    if (record.source === "npm" && !effectiveSpec) {
      outcomes.push({
        message: `Skipping "${pluginId}" (missing npm spec).`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    if (record.source === "clawhub" && !record.clawhubPackage) {
      outcomes.push({
        message: `Skipping "${pluginId}" (missing ClawHub package metadata).`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    if (
      record.source === "marketplace" &&
      (!record.marketplaceSource || !record.marketplacePlugin)
    ) {
      outcomes.push({
        message: `Skipping "${pluginId}" (missing marketplace source metadata).`,
        pluginId,
        status: "skipped",
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
    } catch (error) {
      outcomes.push({
        message: `Invalid install path for "${pluginId}": ${String(error)}`,
        pluginId,
        status: "error",
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath);

    if (params.dryRun) {
      let probe:
        | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
        | Awaited<ReturnType<typeof installPluginFromClawHub>>
        | Awaited<ReturnType<typeof installPluginFromMarketplace>>;
      try {
        probe =
          record.source === "npm"
            ? await installPluginFromNpmSpec({
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                dryRun: true,
                expectedIntegrity,
                expectedPluginId: pluginId,
                logger,
                mode: "update",
                onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                  dryRun: true,
                  logger,
                  onIntegrityDrift: params.onIntegrityDrift,
                  pluginId,
                }),
                spec: effectiveSpec!,
              })
            : record.source === "clawhub"
              ? await installPluginFromClawHub({
                  baseUrl: record.clawhubUrl,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  dryRun: true,
                  expectedPluginId: pluginId,
                  logger,
                  mode: "update",
                  spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                })
              : await installPluginFromMarketplace({
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  dryRun: true,
                  expectedPluginId: pluginId,
                  logger,
                  marketplace: record.marketplaceSource!,
                  mode: "update",
                  plugin: record.marketplacePlugin!,
                });
      } catch (error) {
        outcomes.push({
          message: `Failed to check ${pluginId}: ${String(error)}`,
          pluginId,
          status: "error",
        });
        continue;
      }
      if (!probe.ok) {
        outcomes.push({
          message:
            record.source === "npm"
              ? formatNpmInstallFailure({
                  phase: "check",
                  pluginId,
                  result: probe,
                  spec: effectiveSpec!,
                })
              : record.source === "clawhub"
                ? formatClawHubInstallFailure({
                    pluginId,
                    spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                    phase: "check",
                    error: probe.error,
                  })
                : formatMarketplaceInstallFailure({
                    pluginId,
                    marketplaceSource: record.marketplaceSource!,
                    marketplacePlugin: record.marketplacePlugin!,
                    phase: "check",
                    error: probe.error,
                  }),
          pluginId,
          status: "error",
        });
        continue;
      }

      const nextVersion = probe.version ?? "unknown";
      const currentLabel = currentVersion ?? "unknown";
      if (currentVersion && probe.version && currentVersion === probe.version) {
        outcomes.push({
          currentVersion: currentVersion ?? undefined,
          message: `${pluginId} is up to date (${currentLabel}).`,
          nextVersion: probe.version ?? undefined,
          pluginId,
          status: "unchanged",
        });
      } else {
        outcomes.push({
          currentVersion: currentVersion ?? undefined,
          message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`,
          nextVersion: probe.version ?? undefined,
          pluginId,
          status: "updated",
        });
      }
      continue;
    }

    let result:
      | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
      | Awaited<ReturnType<typeof installPluginFromClawHub>>
      | Awaited<ReturnType<typeof installPluginFromMarketplace>>;
    try {
      result =
        record.source === "npm"
          ? await installPluginFromNpmSpec({
              dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
              expectedIntegrity,
              expectedPluginId: pluginId,
              logger,
              mode: "update",
              onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                dryRun: false,
                logger,
                onIntegrityDrift: params.onIntegrityDrift,
                pluginId,
              }),
              spec: effectiveSpec!,
            })
          : record.source === "clawhub"
            ? await installPluginFromClawHub({
                baseUrl: record.clawhubUrl,
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                logger,
                mode: "update",
                spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
              })
            : await installPluginFromMarketplace({
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                logger,
                marketplace: record.marketplaceSource!,
                mode: "update",
                plugin: record.marketplacePlugin!,
              });
    } catch (error) {
      outcomes.push({
        message: `Failed to update ${pluginId}: ${String(error)}`,
        pluginId,
        status: "error",
      });
      continue;
    }
    if (!result.ok) {
      outcomes.push({
        message:
          record.source === "npm"
            ? formatNpmInstallFailure({
                phase: "update",
                pluginId,
                result: result,
                spec: effectiveSpec!,
              })
            : record.source === "clawhub"
              ? formatClawHubInstallFailure({
                  pluginId,
                  spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                  phase: "update",
                  error: result.error,
                })
              : formatMarketplaceInstallFailure({
                  pluginId,
                  marketplaceSource: record.marketplaceSource!,
                  marketplacePlugin: record.marketplacePlugin!,
                  phase: "update",
                  error: result.error,
                }),
        pluginId,
        status: "error",
      });
      continue;
    }

    const resolvedPluginId = result.pluginId;
    if (resolvedPluginId !== pluginId) {
      next = migratePluginConfigId(next, pluginId, resolvedPluginId);
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    if (record.source === "npm") {
      next = recordPluginInstall(next, {
        installPath: result.targetDir,
        pluginId: resolvedPluginId,
        source: "npm",
        spec: effectiveSpec,
        version: nextVersion,
        ...buildNpmResolutionInstallFields(result.npmResolution),
      });
    } else if (record.source === "clawhub") {
      const clawhubResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromClawHub>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        clawhubChannel: clawhubResult.clawhub.clawhubChannel,
        clawhubFamily: clawhubResult.clawhub.clawhubFamily,
        clawhubPackage: clawhubResult.clawhub.clawhubPackage,
        clawhubUrl: clawhubResult.clawhub.clawhubUrl,
        installPath: result.targetDir,
        integrity: clawhubResult.clawhub.integrity,
        pluginId: resolvedPluginId,
        resolvedAt: clawhubResult.clawhub.resolvedAt,
        source: "clawhub",
        spec: effectiveSpec ?? record.spec ?? `clawhub:${record.clawhubPackage!}`,
        version: nextVersion,
      });
    } else {
      const marketplaceResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromMarketplace>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        installPath: result.targetDir,
        marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
        marketplacePlugin: record.marketplacePlugin,
        marketplaceSource: record.marketplaceSource,
        pluginId: resolvedPluginId,
        source: "marketplace",
        version: nextVersion,
      });
    }
    changed = true;

    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    if (currentVersion && nextVersion && currentVersion === nextVersion) {
      outcomes.push({
        currentVersion: currentVersion ?? undefined,
        message: `${pluginId} already at ${currentLabel}.`,
        nextVersion: nextVersion ?? undefined,
        pluginId,
        status: "unchanged",
      });
    } else {
      outcomes.push({
        currentVersion: currentVersion ?? undefined,
        message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`,
        nextVersion: nextVersion ?? undefined,
        pluginId,
        status: "updated",
      });
    }
  }

  return { changed, config: next, outcomes };
}

export async function syncPluginsForUpdateChannel(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginUpdateLogger;
}): Promise<PluginChannelSyncResult> {
  const env = params.env ?? process.env;
  const summary: PluginChannelSyncSummary = {
    errors: [],
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
  };
  const bundled = resolveBundledPluginSources({
    env,
    workspaceDir: params.workspaceDir,
  });
  if (bundled.size === 0) {
    return { changed: false, config: params.config, summary };
  }

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
  const installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        installPath: bundledInfo.localPath,
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") {
        continue;
      }
      if (!pathsEqual(record.sourcePath, bundledInfo.localPath, env)) {
        continue;
      }
      // Keep explicit bundled installs on release channels. Replacing them with
      // Npm installs can reintroduce duplicate-id shadowing and packaging drift.
      loadHelpers.addPath(bundledInfo.localPath);
      const alreadyBundled =
        record.source === "path" &&
        pathsEqual(record.sourcePath, bundledInfo.localPath, env) &&
        pathsEqual(record.installPath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        installPath: bundledInfo.localPath,
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      changed = true;
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { changed, config: next, summary };
}
