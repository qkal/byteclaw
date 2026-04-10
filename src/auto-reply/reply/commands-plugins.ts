import fs from "node:fs";
import { buildNpmInstallRecordFields } from "../../cli/npm-resolution.js";
import {
  buildPreferredClawHubSpec,
  createPluginInstallLogger,
  decidePreferredClawHubFallback,
  resolveFileNpmSpecToLocalPath,
} from "../../cli/plugins-command-helpers.js";
import { persistPluginInstall } from "../../cli/plugins-install-persist.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveArchiveKind } from "../../infra/archive.js";
import { parseClawHubPluginSpec } from "../../infra/clawhub.js";
import { installPluginFromClawHub } from "../../plugins/clawhub.js";
import { installPluginFromNpmSpec, installPluginFromPath } from "../../plugins/install.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import type { PluginRecord } from "../../plugins/registry.js";
import {
  type PluginStatusReport,
  buildAllPluginInspectReports,
  buildPluginDiagnosticsReport,
  buildPluginInspectReport,
  buildPluginSnapshotReport,
  formatPluginCompatibilityNotice,
} from "../../plugins/status.js";
import { setPluginEnabledInConfig } from "../../plugins/toggle-config.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parsePluginsCommand } from "./plugins-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildPluginInspectJson(params: {
  id: string;
  config: OpenClawConfig;
  report: PluginStatusReport;
}): {
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>;
  compatibilityWarnings: {
    code: string;
    severity: string;
    message: string;
  }[];
  install: PluginInstallRecord | null;
} | null {
  const inspect = buildPluginInspectReport({
    config: params.config,
    id: params.id,
    report: params.report,
  });
  if (!inspect) {
    return null;
  }
  return {
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      message: formatPluginCompatibilityNotice(warning),
      severity: warning.severity,
    })),
    inspect,
    install: params.config.plugins?.installs?.[inspect.plugin.id] ?? null,
  };
}

function buildAllPluginInspectJson(params: {
  config: OpenClawConfig;
  report: PluginStatusReport;
}): {
  inspect: ReturnType<typeof buildAllPluginInspectReports>[number];
  compatibilityWarnings: {
    code: string;
    severity: string;
    message: string;
  }[];
  install: PluginInstallRecord | null;
}[] {
  return buildAllPluginInspectReports({
    config: params.config,
    report: params.report,
  }).map((inspect) => ({
    compatibilityWarnings: inspect.compatibility.map((warning) => ({
      code: warning.code,
      message: formatPluginCompatibilityNotice(warning),
      severity: warning.severity,
    })),
    inspect,
    install: params.config.plugins?.installs?.[inspect.plugin.id] ?? null,
  }));
}

function formatPluginLabel(plugin: PluginRecord): string {
  if (!plugin.name || plugin.name === plugin.id) {
    return plugin.id;
  }
  return `${plugin.name} (${plugin.id})`;
}

function formatPluginsList(report: PluginStatusReport): string {
  if (report.plugins.length === 0) {
    return `🔌 No plugins found for workspace ${report.workspaceDir ?? "(unknown workspace)"}.`;
  }

  const loaded = report.plugins.filter((plugin) => plugin.status === "loaded").length;
  const lines = [
    `🔌 Plugins (${loaded}/${report.plugins.length} loaded)`,
    ...report.plugins.map((plugin) => {
      const format = plugin.bundleFormat
        ? `${plugin.format ?? "openclaw"}/${plugin.bundleFormat}`
        : (plugin.format ?? "openclaw");
      return `- ${formatPluginLabel(plugin)} [${plugin.status}] ${format}`;
    }),
  ];
  return lines.join("\n");
}

function findPlugin(report: PluginStatusReport, rawName: string): PluginRecord | undefined {
  const target = normalizeOptionalLowercaseString(rawName);
  if (!target) {
    return undefined;
  }
  return report.plugins.find(
    (plugin) =>
      normalizeOptionalLowercaseString(plugin.id) === target ||
      normalizeOptionalLowercaseString(plugin.name) === target,
  );
}

function looksLikeLocalPluginInstallSpec(raw: string): boolean {
  return (
    raw.startsWith(".") ||
    raw.startsWith("~") ||
    raw.startsWith("/") ||
    raw.endsWith(".ts") ||
    raw.endsWith(".js") ||
    raw.endsWith(".mjs") ||
    raw.endsWith(".cjs") ||
    raw.endsWith(".tgz") ||
    raw.endsWith(".tar.gz") ||
    raw.endsWith(".tar") ||
    raw.endsWith(".zip")
  );
}

async function installPluginFromPluginsCommand(params: {
  raw: string;
  config: OpenClawConfig;
}): Promise<{ ok: true; pluginId: string } | { ok: false; error: string }> {
  const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
  if (fileSpec && !fileSpec.ok) {
    return { error: fileSpec.error, ok: false };
  }
  const normalized = fileSpec && fileSpec.ok ? fileSpec.path : params.raw;
  const resolved = resolveUserPath(normalized);

  if (fs.existsSync(resolved)) {
    const result = await installPluginFromPath({
      logger: createPluginInstallLogger(),
      path: resolved,
    });
    if (!result.ok) {
      return { error: result.error, ok: false };
    }
    clearPluginManifestRegistryCache();
    const source: "archive" | "path" = resolveArchiveKind(resolved) ? "archive" : "path";
    await persistPluginInstall({
      config: params.config,
      install: {
        installPath: result.targetDir,
        source,
        sourcePath: resolved,
        version: result.version,
      },
      pluginId: result.pluginId,
    });
    return { ok: true, pluginId: result.pluginId };
  }

  if (looksLikeLocalPluginInstallSpec(params.raw)) {
    return { error: `Path not found: ${resolved}`, ok: false };
  }

  const clawhubSpec = parseClawHubPluginSpec(params.raw);
  if (clawhubSpec) {
    const result = await installPluginFromClawHub({
      logger: createPluginInstallLogger(),
      spec: params.raw,
    });
    if (!result.ok) {
      return { error: result.error, ok: false };
    }
    clearPluginManifestRegistryCache();
    await persistPluginInstall({
      config: params.config,
      install: {
        clawhubChannel: result.clawhub.clawhubChannel,
        clawhubFamily: result.clawhub.clawhubFamily,
        clawhubPackage: result.clawhub.clawhubPackage,
        clawhubUrl: result.clawhub.clawhubUrl,
        installPath: result.targetDir,
        integrity: result.clawhub.integrity,
        resolvedAt: result.clawhub.resolvedAt,
        source: "clawhub",
        spec: params.raw,
        version: result.version,
      },
      pluginId: result.pluginId,
    });
    return { ok: true, pluginId: result.pluginId };
  }

  const preferredClawHubSpec = buildPreferredClawHubSpec(params.raw);
  if (preferredClawHubSpec) {
    const clawhubResult = await installPluginFromClawHub({
      logger: createPluginInstallLogger(),
      spec: preferredClawHubSpec,
    });
    if (clawhubResult.ok) {
      clearPluginManifestRegistryCache();
      await persistPluginInstall({
        config: params.config,
        install: {
          clawhubChannel: clawhubResult.clawhub.clawhubChannel,
          clawhubFamily: clawhubResult.clawhub.clawhubFamily,
          clawhubPackage: clawhubResult.clawhub.clawhubPackage,
          clawhubUrl: clawhubResult.clawhub.clawhubUrl,
          installPath: clawhubResult.targetDir,
          integrity: clawhubResult.clawhub.integrity,
          resolvedAt: clawhubResult.clawhub.resolvedAt,
          source: "clawhub",
          spec: preferredClawHubSpec,
          version: clawhubResult.version,
        },
        pluginId: clawhubResult.pluginId,
      });
      return { ok: true, pluginId: clawhubResult.pluginId };
    }
    if (decidePreferredClawHubFallback(clawhubResult) !== "fallback_to_npm") {
      return { error: clawhubResult.error, ok: false };
    }
  }

  const result = await installPluginFromNpmSpec({
    logger: createPluginInstallLogger(),
    spec: params.raw,
  });
  if (!result.ok) {
    return { error: result.error, ok: false };
  }
  clearPluginManifestRegistryCache();
  const installRecord = buildNpmInstallRecordFields({
    installPath: result.targetDir,
    resolution: result.npmResolution,
    spec: params.raw,
    version: result.version,
  });
  await persistPluginInstall({
    config: params.config,
    install: installRecord,
    pluginId: result.pluginId,
  });
  return { ok: true, pluginId: result.pluginId };
}

async function loadPluginCommandState(
  workspaceDir: string,
  options?: { loadModules?: boolean },
): Promise<
  | {
      ok: true;
      path: string;
      config: OpenClawConfig;
      report: PluginStatusReport;
    }
  | { ok: false; path: string; error: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return {
      error: "Config file is invalid; fix it before using /plugins.",
      ok: false,
      path: snapshot.path,
    };
  }
  const config = structuredClone(snapshot.resolved);
  return {
    config,
    ok: true,
    path: snapshot.path,
    report:
      options?.loadModules === true
        ? buildPluginDiagnosticsReport({ config, workspaceDir })
        : buildPluginSnapshotReport({ config, workspaceDir }),
  };
}

async function loadPluginCommandConfig(): Promise<
  { ok: true; path: string; config: OpenClawConfig } | { ok: false; path: string; error: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    return {
      error: "Config file is invalid; fix it before using /plugins.",
      ok: false,
      path: snapshot.path,
    };
  }
  return {
    config: structuredClone(snapshot.resolved),
    ok: true,
    path: snapshot.path,
  };
}

export const handlePluginsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const pluginsCommand = parsePluginsCommand(params.command.commandBodyNormalized);
  if (!pluginsCommand) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/plugins");
  if (unauthorized) {
    return unauthorized;
  }
  const allowInternalReadOnly =
    (pluginsCommand.action === "list" || pluginsCommand.action === "inspect") &&
    isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnly ? null : rejectNonOwnerCommand(params, "/plugins");
  if (nonOwner) {
    return nonOwner;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    configKey: "plugins",
    label: "/plugins",
  });
  if (disabled) {
    return disabled;
  }
  if (pluginsCommand.action === "error") {
    return {
      reply: { text: `⚠️ ${pluginsCommand.message}` },
      shouldContinue: false,
    };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    allowedScopes: ["operator.admin"],
    label: "/plugins write",
    missingText: "❌ /plugins install|enable|disable requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  if (pluginsCommand.action === "install") {
    const loadedConfig = await loadPluginCommandConfig();
    if (!loadedConfig.ok) {
      return {
        reply: { text: `⚠️ ${loadedConfig.error}` },
        shouldContinue: false,
      };
    }
    const installed = await installPluginFromPluginsCommand({
      config: loadedConfig.config,
      raw: pluginsCommand.spec,
    });
    if (!installed.ok) {
      return {
        reply: { text: `⚠️ ${installed.error}` },
        shouldContinue: false,
      };
    }
    return {
      reply: {
        text: `🔌 Installed plugin "${installed.pluginId}". Restart the gateway to load plugins.`,
      },
      shouldContinue: false,
    };
  }

  const loaded = await loadPluginCommandState(params.workspaceDir, {
    loadModules: pluginsCommand.action !== "list",
  });
  if (!loaded.ok) {
    return {
      reply: { text: `⚠️ ${loaded.error}` },
      shouldContinue: false,
    };
  }

  if (pluginsCommand.action === "list") {
    return {
      reply: { text: formatPluginsList(loaded.report) },
      shouldContinue: false,
    };
  }

  if (pluginsCommand.action === "inspect") {
    if (!pluginsCommand.name) {
      return {
        reply: { text: formatPluginsList(loaded.report) },
        shouldContinue: false,
      };
    }
    if (normalizeOptionalLowercaseString(pluginsCommand.name) === "all") {
      return {
        reply: {
          text: renderJsonBlock("🔌 Plugins", buildAllPluginInspectJson(loaded)),
        },
        shouldContinue: false,
      };
    }
    const payload = buildPluginInspectJson({
      config: loaded.config,
      id: pluginsCommand.name,
      report: loaded.report,
    });
    if (!payload) {
      return {
        reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
        shouldContinue: false,
      };
    }
    return {
      reply: {
        text: renderJsonBlock(`🔌 Plugin "${payload.inspect.plugin.id}"`, {
          ...payload.inspect,
          compatibilityWarnings: payload.compatibilityWarnings,
          install: payload.install,
        }),
      },
      shouldContinue: false,
    };
  }

  const plugin = findPlugin(loaded.report, pluginsCommand.name);
  if (!plugin) {
    return {
      reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` },
      shouldContinue: false,
    };
  }

  const next = setPluginEnabledInConfig(
    structuredClone(loaded.config),
    plugin.id,
    pluginsCommand.action === "enable",
  );
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      reply: {
        text: `⚠️ Config invalid after /plugins ${pluginsCommand.action} (${issue.path}: ${issue.message}).`,
      },
      shouldContinue: false,
    };
  }
  await writeConfigFile(validated.config);

  return {
    reply: {
      text: `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${loaded.path}. Restart the gateway to apply.`,
    },
    shouldContinue: false,
  };
};
