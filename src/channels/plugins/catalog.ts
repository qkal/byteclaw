import fs from "node:fs";
import path from "node:path";
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import type { OpenClawPackageManifest } from "../../plugins/manifest.js";
import type { PluginPackageChannel, PluginPackageInstall } from "../../plugins/manifest.js";
import type { PluginOrigin } from "../../plugins/types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../../utils.js";
import { resolveChannelExposure } from "./exposure.js";
import type { ChannelMeta } from "./types.js";

export interface ChannelUiMetaEntry {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
}

export interface ChannelUiCatalog {
  entries: ChannelUiMetaEntry[];
  order: string[];
  labels: Record<string, string>;
  detailLabels: Record<string, string>;
  systemImages: Record<string, string>;
  byId: Record<string, ChannelUiMetaEntry>;
}

export interface ChannelPluginCatalogEntry {
  id: string;
  pluginId?: string;
  origin?: PluginOrigin;
  meta: ChannelMeta;
  install: {
    npmSpec: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
}

interface CatalogOptions {
  workspaceDir?: string;
  catalogPaths?: string[];
  officialCatalogPaths?: string[];
  env?: NodeJS.ProcessEnv;
  excludeWorkspace?: boolean;
}

const ORIGIN_PRIORITY: Record<PluginOrigin, number> = {
  bundled: 3,
  config: 0,
  global: 2,
  workspace: 1,
};

const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;

type ExternalCatalogEntry = {
  name?: string;
  version?: string;
  description?: string;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");

type ManifestKey = typeof MANIFEST_KEY;

function parseCatalogEntries(raw: unknown): ExternalCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
  }
  if (!isRecord(raw)) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is ExternalCatalogEntry => isRecord(entry));
}

function splitEnvPaths(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[;,]/g)
    .flatMap((chunk) => chunk.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveDefaultCatalogPaths(env: NodeJS.ProcessEnv): string[] {
  const configDir = resolveConfigDir(env);
  return [
    path.join(configDir, "mpm", "plugins.json"),
    path.join(configDir, "mpm", "catalog.json"),
    path.join(configDir, "plugins", "catalog.json"),
  ];
}

function resolveExternalCatalogPaths(options: CatalogOptions): string[] {
  if (options.catalogPaths && options.catalogPaths.length > 0) {
    return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }
  const env = options.env ?? process.env;
  for (const key of ENV_CATALOG_PATHS) {
    const raw = env[key];
    if (raw && raw.trim()) {
      return splitEnvPaths(raw);
    }
  }
  return resolveDefaultCatalogPaths(env);
}

function loadExternalCatalogEntries(options: CatalogOptions): ExternalCatalogEntry[] {
  const paths = resolveExternalCatalogPaths(options).map((rawPath) =>
    resolveUserPath(rawPath, options.env ?? process.env),
  );
  return loadCatalogEntriesFromPaths(paths);
}

function loadCatalogEntriesFromPaths(paths: Iterable<string>): ExternalCatalogEntry[] {
  const entries: ExternalCatalogEntry[] = [];
  for (const resolvedPath of paths) {
    if (!fs.existsSync(resolvedPath)) {
      continue;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
      entries.push(...parseCatalogEntries(payload));
    } catch {
      // Ignore invalid catalog files.
    }
  }
  return entries;
}

function resolveOfficialCatalogPaths(options: CatalogOptions): string[] {
  if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
    return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
  }

  const packageRoots = [
    resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
  ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);

  const candidates = packageRoots.map((packageRoot) =>
    path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH),
  );

  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
    candidates.push(path.join(execDir, "channel-catalog.json"));
  }

  return candidates.filter((entry, index, all) => entry && all.indexOf(entry) === index);
}

function loadOfficialCatalogEntries(options: CatalogOptions): ChannelPluginCatalogEntry[] {
  return loadCatalogEntriesFromPaths(resolveOfficialCatalogPaths(options))
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
}

function toChannelMeta(params: {
  channel: NonNullable<OpenClawPackageManifest["channel"]>;
  id: string;
}): ChannelMeta | null {
  const label = params.channel.label?.trim();
  if (!label) {
    return null;
  }
  const selectionLabel = params.channel.selectionLabel?.trim() || label;
  const detailLabel = params.channel.detailLabel?.trim();
  const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
  const blurb = params.channel.blurb?.trim() || "";
  const systemImage = params.channel.systemImage?.trim();
  const exposure = resolveChannelExposure(params.channel);

  return {
    id: params.id,
    label,
    selectionLabel,
    ...(detailLabel ? { detailLabel } : {}),
    docsPath,
    docsLabel: normalizeOptionalString(params.channel.docsLabel),
    blurb,
    ...(params.channel.aliases ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.preferOver ? { preferOver: params.channel.preferOver } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(params.channel.selectionDocsPrefix
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(params.channel.selectionExtras ? { selectionExtras: params.channel.selectionExtras } : {}),
    ...(systemImage ? { systemImage } : {}),
    ...(params.channel.markdownCapable !== undefined
      ? { markdownCapable: params.channel.markdownCapable }
      : {}),
    exposure,
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
  };
}

function resolveInstallInfo(params: {
  install?: PluginPackageInstall;
  packageName?: string;
  packageDir?: string;
  workspaceDir?: string;
}): ChannelPluginCatalogEntry["install"] | null {
  const npmSpec = params.install?.npmSpec?.trim() ?? params.packageName?.trim();
  if (!npmSpec) {
    return null;
  }
  let localPath = normalizeOptionalString(params.install?.localPath);
  if (!localPath && params.workspaceDir && params.packageDir) {
    localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
  }
  const defaultChoice = params.install?.defaultChoice ?? (localPath ? "local" : "npm");
  return {
    npmSpec,
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
  };
}

function buildCatalogEntryFromManifest(params: {
  pluginId?: string;
  packageName?: string;
  packageDir?: string;
  origin?: PluginOrigin;
  workspaceDir?: string;
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
}): ChannelPluginCatalogEntry | null {
  if (!params.channel) {
    return null;
  }
  const id = params.channel.id?.trim();
  if (!id) {
    return null;
  }
  const meta = toChannelMeta({ channel: params.channel, id });
  if (!meta) {
    return null;
  }
  const install = resolveInstallInfo({
    install: params.install,
    packageDir: params.packageDir,
    packageName: params.packageName,
    workspaceDir: params.workspaceDir,
  });
  if (!install) {
    return null;
  }
  const pluginId = normalizeOptionalString(params.pluginId);
  return {
    id,
    ...(pluginId ? { pluginId } : {}),
    ...(params.origin ? { origin: params.origin } : {}),
    meta,
    install,
  };
}

function buildExternalCatalogEntry(entry: ExternalCatalogEntry): ChannelPluginCatalogEntry | null {
  const manifest = entry[MANIFEST_KEY];
  return buildCatalogEntryFromManifest({
    channel: manifest?.channel,
    install: manifest?.install,
    packageName: entry.name,
  });
}

export function buildChannelUiCatalog(
  plugins: { id: string; meta: ChannelMeta }[],
): ChannelUiCatalog {
  const entries: ChannelUiMetaEntry[] = plugins.map((plugin) => {
    const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
    return {
      detailLabel,
      id: plugin.id,
      label: plugin.meta.label,
      ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
    };
  });
  const order = entries.map((entry) => entry.id);
  const labels: Record<string, string> = {};
  const detailLabels: Record<string, string> = {};
  const systemImages: Record<string, string> = {};
  const byId: Record<string, ChannelUiMetaEntry> = {};
  for (const entry of entries) {
    labels[entry.id] = entry.label;
    detailLabels[entry.id] = entry.detailLabel;
    if (entry.systemImage) {
      systemImages[entry.id] = entry.systemImage;
    }
    byId[entry.id] = entry;
  }
  return { byId, detailLabels, entries, labels, order, systemImages };
}

export function listChannelPluginCatalogEntries(
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry[] {
  const manifestEntries = listChannelCatalogEntries({
    env: options.env,
    workspaceDir: options.workspaceDir,
  });
  const resolved = new Map<string, { entry: ChannelPluginCatalogEntry; priority: number }>();

  for (const candidate of manifestEntries) {
    if (options.excludeWorkspace && candidate.origin === "workspace") {
      continue;
    }
    const entry = buildCatalogEntryFromManifest({
      channel: candidate.channel,
      install: candidate.install,
      origin: candidate.origin,
      packageDir: candidate.rootDir,
      packageName: candidate.packageName,
      pluginId: candidate.pluginId,
      workspaceDir: candidate.workspaceDir ?? options.workspaceDir,
    });
    if (!entry) {
      continue;
    }
    const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  for (const entry of loadOfficialCatalogEntries(options)) {
    const priority = FALLBACK_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  const externalEntries = loadExternalCatalogEntries(options)
    .map((entry) => buildExternalCatalogEntry(entry))
    .filter((entry): entry is ChannelPluginCatalogEntry => Boolean(entry));
  for (const entry of externalEntries) {
    // External catalogs are the supported override seam for shipped fallback
    // Metadata, but discovered plugins should still win when they are present.
    const priority = EXTERNAL_CATALOG_PRIORITY;
    const existing = resolved.get(entry.id);
    if (!existing || priority < existing.priority) {
      resolved.set(entry.id, { entry, priority });
    }
  }

  return [...resolved.values()]
    .map(({ entry }) => entry)
    .toSorted((a, b) => {
      const orderA = a.meta.order ?? 999;
      const orderB = b.meta.order ?? 999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
}

export function getChannelPluginCatalogEntry(
  id: string,
  options: CatalogOptions = {},
): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
