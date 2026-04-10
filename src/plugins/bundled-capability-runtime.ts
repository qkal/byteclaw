import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledPluginRepoEntryPath } from "./bundled-plugin-metadata.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import type { PluginLoadOptions } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import {
  type PluginSdkResolutionPreference,
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import type { OpenClawPluginDefinition, OpenClawPluginModule } from "./types.js";

const log = createSubsystemLogger("plugins");

function applyVitestCapabilityAliasOverrides(params: {
  aliasMap: Record<string, string>;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  env?: PluginLoadOptions["env"];
}): Record<string, string> {
  if (!params.env?.VITEST || params.pluginSdkResolution !== "dist") {
    return params.aliasMap;
  }

  const {
    "openclaw/plugin-sdk": _ignoredLegacyRootAlias,
    "@openclaw/plugin-sdk": _ignoredScopedRootAlias,
    ...scopedAliasMap
  } = params.aliasMap;
  return {
    ...scopedAliasMap,
    // Capability contract loads only need a narrow SDK slice. Keep those
    // Helpers on a tiny source graph so Vitest does not pull the dist chunk
    // Bundle that also drags Matrix/WhatsApp code into these tests.
    "openclaw/plugin-sdk/llm-task": fileURLToPath(
      new URL("capability-runtime-vitest-shims/llm-task.ts", import.meta.url),
    ),
    "@openclaw/plugin-sdk/llm-task": fileURLToPath(
      new URL("capability-runtime-vitest-shims/llm-task.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/config-runtime": fileURLToPath(
      new URL("capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
    ),
    "@openclaw/plugin-sdk/config-runtime": fileURLToPath(
      new URL("capability-runtime-vitest-shims/config-runtime.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/media-runtime": fileURLToPath(
      new URL("capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
    ),
    "@openclaw/plugin-sdk/media-runtime": fileURLToPath(
      new URL("capability-runtime-vitest-shims/media-runtime.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/provider-onboard": fileURLToPath(
      new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
    ),
    "@openclaw/plugin-sdk/provider-onboard": fileURLToPath(
      new URL("../plugin-sdk/provider-onboard.ts", import.meta.url),
    ),
    "openclaw/plugin-sdk/speech-core": fileURLToPath(
      new URL("capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
    ),
    "@openclaw/plugin-sdk/speech-core": fileURLToPath(
      new URL("capability-runtime-vitest-shims/speech-core.ts", import.meta.url),
    ),
  };
}

export function buildBundledCapabilityRuntimeConfig(
  pluginIds: readonly string[],
  env?: PluginLoadOptions["env"],
): PluginLoadOptions["config"] {
  const enablementCompat = withBundledPluginEnablementCompat({
    config: undefined,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    env,
    pluginIds,
  });
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const definition = resolved as OpenClawPluginDefinition;
    return {
      definition,
      register: definition.register ?? definition.activate,
    };
  }
  return {};
}

function createCapabilityPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  source: string;
  rootDir?: string;
  workspaceDir?: string;
}): PluginRecord {
  return {
    channelIds: [],
    cliBackendIds: [],
    cliCommands: [],
    commands: [],
    configSchema: true,
    description: params.description,
    enabled: true,
    gatewayMethods: [],
    hookCount: 0,
    hookNames: [],
    httpRoutes: 0,
    id: params.id,
    imageGenerationProviderIds: [],
    mediaUnderstandingProviderIds: [],
    memoryEmbeddingProviderIds: [],
    musicGenerationProviderIds: [],
    name: params.name ?? params.id,
    origin: "bundled",
    providerIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    rootDir: params.rootDir,
    services: [],
    source: params.source,
    speechProviderIds: [],
    status: "loaded",
    toolNames: [],
    version: params.version,
    videoGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    workspaceDir: params.workspaceDir,
  };
}

function recordCapabilityLoadError(
  registry: PluginRegistry,
  record: PluginRecord,
  message: string,
): void {
  record.status = "error";
  record.error = message;
  registry.plugins.push(record);
  registry.diagnostics.push({
    level: "error",
    message: `failed to load plugin: ${message}`,
    pluginId: record.id,
    source: record.source,
  });
  log.error(`[plugins] ${record.id} failed to load from ${record.source}: ${message}`);
}

export function loadBundledCapabilityRuntimeRegistry(params: {
  pluginIds: readonly string[];
  env?: PluginLoadOptions["env"];
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const env = params.env ?? process.env;
  const pluginIds = new Set(params.pluginIds);
  const registry = createEmptyPluginRegistry();
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

  const getJiti = (modulePath: string) => {
    const tryNative =
      shouldPreferNativeJiti(modulePath) && !(env?.VITEST && params.pluginSdkResolution === "dist");
    const aliasMap = applyVitestCapabilityAliasOverrides({
      aliasMap: buildPluginLoaderAliasMap(
        modulePath,
        process.argv[1],
        import.meta.url,
        params.pluginSdkResolution,
      ),
      env,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    const cacheKey = JSON.stringify({
      aliasMap: Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
      tryNative,
    });
    const cached = jitiLoaders.get(cacheKey);
    if (cached) {
      return cached;
    }
    const loader = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    });
    jitiLoaders.set(cacheKey, loader);
    return loader;
  };

  const discovery = discoverOpenClawPlugins({
    cache: false,
    env,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    candidates: discovery.candidates,
    config: buildBundledCapabilityRuntimeConfig(params.pluginIds, env),
    diagnostics: discovery.diagnostics,
    env,
  });
  registry.diagnostics.push(...manifestRegistry.diagnostics);

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const seenPluginIds = new Set<string>();
  const repoRoot = process.cwd();

  for (const candidate of discovery.candidates) {
    const manifest = manifestByRoot.get(candidate.rootDir);
    if (!manifest || manifest.origin !== "bundled" || !pluginIds.has(manifest.id)) {
      continue;
    }
    if (seenPluginIds.has(manifest.id)) {
      continue;
    }
    seenPluginIds.add(manifest.id);

    const record = createCapabilityPluginRecord({
      description: manifest.description,
      id: manifest.id,
      name: manifest.name,
      rootDir: candidate.rootDir,
      source:
        env?.VITEST && params.pluginSdkResolution === "dist"
          ? (resolveBundledPluginRepoEntryPath({
              pluginId: manifest.id,
              preferBuilt: true,
              rootDir: repoRoot,
            }) ?? candidate.source)
          : candidate.source,
      version: manifest.version,
      workspaceDir: candidate.workspaceDir,
    });

    const opened = openBoundaryFileSync({
      absolutePath: record.source,
      boundaryLabel: record.source === candidate.source ? "plugin root" : "repo root",
      rejectHardlinks: false,
      rootPath: record.source === candidate.source ? candidate.rootDir : repoRoot,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      recordCapabilityLoadError(
        registry,
        record,
        "plugin entry path escapes plugin root or fails alias checks",
      );
      continue;
    }

    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = getJiti(safeSource)(safeSource) as OpenClawPluginModule;
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const {register} = resolved;
    if (typeof register !== "function") {
      record.status = "disabled";
      record.error = "plugin export missing register(api)";
      registry.plugins.push(record);
      continue;
    }

    try {
      const captured = createCapturedPluginRegistration();
      void register(captured.api);
      record.cliBackendIds.push(...captured.cliBackends.map((entry) => entry.id));
      record.providerIds.push(...captured.providers.map((entry) => entry.id));
      record.speechProviderIds.push(...captured.speechProviders.map((entry) => entry.id));
      record.realtimeTranscriptionProviderIds.push(
        ...captured.realtimeTranscriptionProviders.map((entry) => entry.id),
      );
      record.realtimeVoiceProviderIds.push(
        ...captured.realtimeVoiceProviders.map((entry) => entry.id),
      );
      record.mediaUnderstandingProviderIds.push(
        ...captured.mediaUnderstandingProviders.map((entry) => entry.id),
      );
      record.imageGenerationProviderIds.push(
        ...captured.imageGenerationProviders.map((entry) => entry.id),
      );
      record.videoGenerationProviderIds.push(
        ...captured.videoGenerationProviders.map((entry) => entry.id),
      );
      record.musicGenerationProviderIds.push(
        ...captured.musicGenerationProviders.map((entry) => entry.id),
      );
      record.webFetchProviderIds.push(...captured.webFetchProviders.map((entry) => entry.id));
      record.webSearchProviderIds.push(...captured.webSearchProviders.map((entry) => entry.id));
      record.memoryEmbeddingProviderIds.push(
        ...captured.memoryEmbeddingProviders.map((entry) => entry.id),
      );
      record.toolNames.push(...captured.tools.map((entry) => entry.name));

      registry.cliBackends?.push(
        ...captured.cliBackends.map((backend) => ({
          backend,
          pluginId: record.id,
          pluginName: record.name,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.providers.push(
        ...captured.providers.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.speechProviders.push(
        ...captured.speechProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.realtimeTranscriptionProviders.push(
        ...captured.realtimeTranscriptionProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.realtimeVoiceProviders.push(
        ...captured.realtimeVoiceProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.mediaUnderstandingProviders.push(
        ...captured.mediaUnderstandingProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.imageGenerationProviders.push(
        ...captured.imageGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.videoGenerationProviders.push(
        ...captured.videoGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.musicGenerationProviders.push(
        ...captured.musicGenerationProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.webFetchProviders.push(
        ...captured.webFetchProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.webSearchProviders.push(
        ...captured.webSearchProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.memoryEmbeddingProviders.push(
        ...captured.memoryEmbeddingProviders.map((provider) => ({
          pluginId: record.id,
          pluginName: record.name,
          provider,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.tools.push(
        ...captured.tools.map((tool) => ({
          factory: () => tool,
          names: [tool.name],
          optional: false,
          pluginId: record.id,
          pluginName: record.name,
          rootDir: record.rootDir,
          source: record.source,
        })),
      );
      registry.plugins.push(record);
    } catch (error) {
      recordCapabilityLoadError(registry, record, String(error));
    }
  }

  return registry;
}
