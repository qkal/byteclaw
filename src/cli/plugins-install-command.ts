import fs from "node:fs";
import { collectChannelDoctorStaleConfigMutations } from "../commands/doctor/shared/channel-doctor.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, readConfigFileSnapshot } from "../config/config.js";
import { installHooksFromNpmSpec, installHooksFromPath } from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { parseClawHubPluginSpec } from "../infra/clawhub.js";
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";
import { type BundledPluginSource, findBundledPluginSource } from "../plugins/bundled-sources.js";
import { formatClawHubSpecifier, installPluginFromClawHub } from "../plugins/clawhub.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../plugins/install.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import {
  installPluginFromMarketplace,
  resolveMarketplaceInstallShortcut,
} from "../plugins/marketplace.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { looksLikeLocalInstallSpec } from "./install-spec.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  type PluginInstallRequestContext,
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import {
  resolveBundledInstallPlanBeforeNpm,
  resolveBundledInstallPlanForNpmFailure,
} from "./plugin-install-plan.js";
import {
  buildPreferredClawHubSpec,
  createHookPackInstallLogger,
  createPluginInstallLogger,
  decidePreferredClawHubFallback,
  formatPluginInstallWithHookFallbackError,
} from "./plugins-command-helpers.js";
import { persistHookPackInstall, persistPluginInstall } from "./plugins-install-persist.js";

function resolveInstallMode(force?: boolean): "install" | "update" {
  return force ? "update" : "install";
}

function resolveInstallSafetyOverrides(overrides: InstallSafetyOverrides): InstallSafetyOverrides {
  return {
    dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall,
  };
}

async function installBundledPluginSource(params: {
  config: OpenClawConfig;
  rawSpec: string;
  bundledSource: BundledPluginSource;
  warning: string;
}) {
  const existing = params.config.plugins?.load?.paths ?? [];
  const mergedPaths = [...new Set([...existing, params.bundledSource.localPath])];
  await persistPluginInstall({
    config: {
      ...params.config,
      plugins: {
        ...params.config.plugins,
        load: {
          ...params.config.plugins?.load,
          paths: mergedPaths,
        },
      },
    },
    install: {
      installPath: params.bundledSource.localPath,
      source: "path",
      sourcePath: params.bundledSource.localPath,
      spec: params.rawSpec,
    },
    pluginId: params.bundledSource.pluginId,
    warningMessage: params.warning,
  });
}

async function tryInstallHookPackFromLocalPath(params: {
  config: OpenClawConfig;
  resolvedPath: string;
  installMode: "install" | "update";
  safetyOverrides?: InstallSafetyOverrides;
  link?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.link) {
    const stat = fs.statSync(params.resolvedPath);
    if (!stat.isDirectory()) {
      return {
        error: "Linked hook pack paths must be directories.",
        ok: false,
      };
    }

    const probe = await installHooksFromPath({
      ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
      dryRun: true,
      path: params.resolvedPath,
    });
    if (!probe.ok) {
      return probe;
    }

    const existing = params.config.hooks?.internal?.load?.extraDirs ?? [];
    const merged = [...new Set([...existing, params.resolvedPath])];
    await persistHookPackInstall({
      config: {
        ...params.config,
        hooks: {
          ...params.config.hooks,
          internal: {
            ...params.config.hooks?.internal,
            enabled: true,
            load: {
              ...params.config.hooks?.internal?.load,
              extraDirs: merged,
            },
          },
        },
      },
      hookPackId: probe.hookPackId,
      hooks: probe.hooks,
      install: {
        installPath: params.resolvedPath,
        source: "path",
        sourcePath: params.resolvedPath,
        version: probe.version,
      },
      successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
    logger: createHookPackInstallLogger(),
    mode: params.installMode,
    path: params.resolvedPath,
  });
  if (!result.ok) {
    return result;
  }

  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  await persistHookPackInstall({
    config: params.config,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: {
      installPath: result.targetDir,
      source,
      sourcePath: params.resolvedPath,
      version: result.version,
    },
  });
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  config: OpenClawConfig;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await installHooksFromNpmSpec({
    logger: createHookPackInstallLogger(),
    mode: params.installMode,
    spec: params.spec,
  });
  if (!result.ok) {
    return result;
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    config: params.config,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
  });
  return { ok: true };
}

function isAllowedBundledRecoveryIssue(
  issue: { path?: string; message?: string },
  request: PluginInstallRequestContext,
): boolean {
  const pluginId = request.bundledPluginId?.trim();
  if (!pluginId) {
    return false;
  }
  return (
    (issue.path === `channels.${pluginId}` &&
      issue.message === `unknown channel id: ${pluginId}`) ||
    (issue.path === "plugins.load.paths" &&
      typeof issue.message === "string" &&
      issue.message.includes("plugin path not found"))
  );
}

function buildInvalidPluginInstallConfigError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "INVALID_CONFIG";
  return error;
}

async function loadConfigFromSnapshotForInstall(
  request: PluginInstallRequestContext,
): Promise<OpenClawConfig> {
  if (resolvePluginInstallInvalidConfigPolicy(request) !== "allow-bundled-recovery") {
    throw buildInvalidPluginInstallConfigError(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
  }
  const snapshot = await readConfigFileSnapshot();
  const parsed = (snapshot.parsed ?? {}) as Record<string, unknown>;
  if (!snapshot.exists || Object.keys(parsed).length === 0) {
    throw buildInvalidPluginInstallConfigError(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  }
  if (
    snapshot.legacyIssues.length > 0 ||
    snapshot.issues.length === 0 ||
    snapshot.issues.some((issue) => !isAllowedBundledRecoveryIssue(issue, request))
  ) {
    const pluginLabel = request.bundledPluginId ?? "the requested plugin";
    throw buildInvalidPluginInstallConfigError(
      `Config invalid outside the bundled recovery path for ${pluginLabel}; run \`openclaw doctor --fix\` before reinstalling it.`,
    );
  }
  let nextConfig = snapshot.config;
  for (const mutation of await collectChannelDoctorStaleConfigMutations(snapshot.config)) {
    nextConfig = mutation.config;
  }
  return nextConfig;
}

export async function loadConfigForInstall(
  request: PluginInstallRequestContext,
): Promise<OpenClawConfig> {
  try {
    return loadConfig();
  } catch (error) {
    if (extractErrorCode(error) !== "INVALID_CONFIG") {
      throw error;
    }
  }
  return loadConfigFromSnapshotForInstall(request);
}

export async function runPluginInstallCommand(params: {
  raw: string;
  opts: InstallSafetyOverrides & {
    force?: boolean;
    link?: boolean;
    pin?: boolean;
    marketplace?: string;
  };
}) {
  const shorthand = !params.opts.marketplace
    ? await resolveMarketplaceInstallShortcut(params.raw)
    : null;
  if (shorthand?.ok === false) {
    defaultRuntime.error(shorthand.error);
    return defaultRuntime.exit(1);
  }

  const raw = shorthand?.ok ? shorthand.plugin : params.raw;
  const opts = {
    ...params.opts,
    marketplace:
      params.opts.marketplace ?? (shorthand?.ok ? shorthand.marketplaceSource : undefined),
  };
  if (opts.marketplace) {
    if (opts.link) {
      defaultRuntime.error("`--link` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }
    if (opts.pin) {
      defaultRuntime.error("`--pin` is not supported with `--marketplace`.");
      return defaultRuntime.exit(1);
    }
  }
  if (opts.link && opts.force) {
    defaultRuntime.error("`--force` is not supported with `--link`.");
    return defaultRuntime.exit(1);
  }
  const requestResolution = resolvePluginInstallRequestContext({
    marketplace: opts.marketplace,
    rawSpec: raw,
  });
  if (!requestResolution.ok) {
    defaultRuntime.error(requestResolution.error);
    return defaultRuntime.exit(1);
  }
  const { request } = requestResolution;
  const cfg = await loadConfigForInstall(request).catch((error: unknown) => {
    defaultRuntime.error(formatErrorMessage(error));
    return null;
  });
  if (!cfg) {
    return defaultRuntime.exit(1);
  }
  const installMode = resolveInstallMode(opts.force);
  const safetyOverrides = resolveInstallSafetyOverrides(opts);

  if (opts.marketplace) {
    const result = await installPluginFromMarketplace({
      ...safetyOverrides,
      logger: createPluginInstallLogger(),
      marketplace: opts.marketplace,
      mode: installMode,
      plugin: raw,
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
    }

    clearPluginManifestRegistryCache();
    await persistPluginInstall({
      config: cfg,
      install: {
        installPath: result.targetDir,
        marketplaceName: result.marketplaceName,
        marketplacePlugin: result.marketplacePlugin,
        marketplaceSource: result.marketplaceSource,
        source: "marketplace",
        version: result.version,
      },
      pluginId: result.pluginId,
    });
    return;
  }

  const resolved = request.resolvedPath ?? request.normalizedSpec;

  if (fs.existsSync(resolved)) {
    if (opts.link) {
      const existing = cfg.plugins?.load?.paths ?? [];
      const merged = [...new Set([...existing, resolved])];
      const probe = await installPluginFromPath({
        ...safetyOverrides,
        dryRun: true,
        path: resolved,
      });
      if (!probe.ok) {
        const hookFallback = await tryInstallHookPackFromLocalPath({
          config: cfg,
          installMode,
          link: true,
          resolvedPath: resolved,
          safetyOverrides,
        });
        if (hookFallback.ok) {
          return;
        }
        defaultRuntime.error(
          formatPluginInstallWithHookFallbackError(probe.error, hookFallback.error),
        );
        return defaultRuntime.exit(1);
      }

      await persistPluginInstall({
        config: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            load: {
              ...cfg.plugins?.load,
              paths: merged,
            },
          },
        },
        install: {
          installPath: resolved,
          source: "path",
          sourcePath: resolved,
          version: probe.version,
        },
        pluginId: probe.pluginId,
        successMessage: `Linked plugin path: ${shortenHomePath(resolved)}`,
      });
      return;
    }

    const result = await installPluginFromPath({
      ...safetyOverrides,
      logger: createPluginInstallLogger(),
      mode: installMode,
      path: resolved,
    });
    if (!result.ok) {
      const hookFallback = await tryInstallHookPackFromLocalPath({
        config: cfg,
        installMode,
        resolvedPath: resolved,
        safetyOverrides,
      });
      if (hookFallback.ok) {
        return;
      }
      defaultRuntime.error(
        formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
      );
      return defaultRuntime.exit(1);
    }

    clearPluginManifestRegistryCache();
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      config: cfg,
      install: {
        installPath: result.targetDir,
        source,
        sourcePath: resolved,
        version: result.version,
      },
      pluginId: result.pluginId,
    });
    return;
  }

  if (opts.link) {
    defaultRuntime.error("`--link` requires a local path.");
    return defaultRuntime.exit(1);
  }

  if (
    looksLikeLocalInstallSpec(raw, [
      ".ts",
      ".js",
      ".mjs",
      ".cjs",
      ".tgz",
      ".tar.gz",
      ".tar",
      ".zip",
    ])
  ) {
    defaultRuntime.error(`Path not found: ${resolved}`);
    return defaultRuntime.exit(1);
  }

  const bundledPreNpmPlan = resolveBundledInstallPlanBeforeNpm({
    findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
    rawSpec: raw,
  });
  if (bundledPreNpmPlan) {
    await installBundledPluginSource({
      bundledSource: bundledPreNpmPlan.bundledSource,
      config: cfg,
      rawSpec: raw,
      warning: bundledPreNpmPlan.warning,
    });
    return;
  }

  const clawhubSpec = parseClawHubPluginSpec(raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      ...safetyOverrides,
      logger: createPluginInstallLogger(),
      mode: installMode,
      spec: raw,
    });
    if (!result.ok) {
      defaultRuntime.error(result.error);
      return defaultRuntime.exit(1);
    }

    clearPluginManifestRegistryCache();
    await persistPluginInstall({
      config: cfg,
      install: {
        clawhubChannel: result.clawhub.clawhubChannel,
        clawhubFamily: result.clawhub.clawhubFamily,
        clawhubPackage: result.clawhub.clawhubPackage,
        clawhubUrl: result.clawhub.clawhubUrl,
        installPath: result.targetDir,
        integrity: result.clawhub.integrity,
        resolvedAt: result.clawhub.resolvedAt,
        source: "clawhub",
        spec: formatClawHubSpecifier({
          name: result.clawhub.clawhubPackage,
          version: result.clawhub.version,
        }),
        version: result.version,
      },
      pluginId: result.pluginId,
    });
    return;
  }

  const preferredClawHubSpec = buildPreferredClawHubSpec(raw);
  if (preferredClawHubSpec) {
    const clawhubResult = await installPluginFromClawHub({
      ...safetyOverrides,
      logger: createPluginInstallLogger(),
      mode: installMode,
      spec: preferredClawHubSpec,
    });
    if (clawhubResult.ok) {
      clearPluginManifestRegistryCache();
      await persistPluginInstall({
        config: cfg,
        install: {
          clawhubChannel: clawhubResult.clawhub.clawhubChannel,
          clawhubFamily: clawhubResult.clawhub.clawhubFamily,
          clawhubPackage: clawhubResult.clawhub.clawhubPackage,
          clawhubUrl: clawhubResult.clawhub.clawhubUrl,
          installPath: clawhubResult.targetDir,
          integrity: clawhubResult.clawhub.integrity,
          resolvedAt: clawhubResult.clawhub.resolvedAt,
          source: "clawhub",
          spec: formatClawHubSpecifier({
            name: clawhubResult.clawhub.clawhubPackage,
            version: clawhubResult.clawhub.version,
          }),
          version: clawhubResult.version,
        },
        pluginId: clawhubResult.pluginId,
      });
      return;
    }
    if (decidePreferredClawHubFallback(clawhubResult) !== "fallback_to_npm") {
      defaultRuntime.error(clawhubResult.error);
      return defaultRuntime.exit(1);
    }
  }

  const result = await installPluginFromNpmSpec({
    ...safetyOverrides,
    logger: createPluginInstallLogger(),
    mode: installMode,
    spec: raw,
  });
  if (!result.ok) {
    const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
      code: result.code,
      findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      rawSpec: raw,
    });
    if (!bundledFallbackPlan) {
      const hookFallback = await tryInstallHookPackFromNpmSpec({
        config: cfg,
        installMode,
        pin: opts.pin,
        spec: raw,
      });
      if (hookFallback.ok) {
        return;
      }
      defaultRuntime.error(
        formatPluginInstallWithHookFallbackError(result.error, hookFallback.error),
      );
      return defaultRuntime.exit(1);
    }

    await installBundledPluginSource({
      bundledSource: bundledFallbackPlan.bundledSource,
      config: cfg,
      rawSpec: raw,
      warning: bundledFallbackPlan.warning,
    });
    return;
  }

  clearPluginManifestRegistryCache();
  const installRecord = resolvePinnedNpmInstallRecordForCli(
    raw,
    Boolean(opts.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    defaultRuntime.log,
    theme.warn,
  );
  await persistPluginInstall({
    config: cfg,
    install: installRecord,
    pluginId: result.pluginId,
  });
}
