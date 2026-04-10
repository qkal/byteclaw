import os from "node:os";
import path from "node:path";
import { type OpenClawPluginConfigSchema, buildPluginConfigSchema, z } from "../api.js";

export const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
export const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

export type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
export type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export interface MemoryWikiPluginConfig {
  vaultMode?: WikiVaultMode;
  vault?: {
    path?: string;
    renderMode?: WikiRenderMode;
  };
  obsidian?: {
    enabled?: boolean;
    useOfficialCli?: boolean;
    vaultName?: string;
    openAfterWrites?: boolean;
  };
  bridge?: {
    enabled?: boolean;
    readMemoryArtifacts?: boolean;
    indexDreamReports?: boolean;
    indexDailyNotes?: boolean;
    indexMemoryRoot?: boolean;
    followMemoryEvents?: boolean;
  };
  unsafeLocal?: {
    allowPrivateMemoryCoreAccess?: boolean;
    paths?: string[];
  };
  ingest?: {
    autoCompile?: boolean;
    maxConcurrentJobs?: number;
    allowUrlIngest?: boolean;
  };
  search?: {
    backend?: WikiSearchBackend;
    corpus?: WikiSearchCorpus;
  };
  context?: {
    includeCompiledDigestPrompt?: boolean;
  };
  render?: {
    preserveHumanBlocks?: boolean;
    createBacklinks?: boolean;
    createDashboards?: boolean;
  };
}

export interface ResolvedMemoryWikiConfig {
  vaultMode: WikiVaultMode;
  vault: {
    path: string;
    renderMode: WikiRenderMode;
  };
  obsidian: {
    enabled: boolean;
    useOfficialCli: boolean;
    vaultName?: string;
    openAfterWrites: boolean;
  };
  bridge: {
    enabled: boolean;
    readMemoryArtifacts: boolean;
    indexDreamReports: boolean;
    indexDailyNotes: boolean;
    indexMemoryRoot: boolean;
    followMemoryEvents: boolean;
  };
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: boolean;
    paths: string[];
  };
  ingest: {
    autoCompile: boolean;
    maxConcurrentJobs: number;
    allowUrlIngest: boolean;
  };
  search: {
    backend: WikiSearchBackend;
    corpus: WikiSearchCorpus;
  };
  context: {
    includeCompiledDigestPrompt: boolean;
  };
  render: {
    preserveHumanBlocks: boolean;
    createBacklinks: boolean;
    createDashboards: boolean;
  };
}

export const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
export const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
export const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
export const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

const MemoryWikiConfigSource = z.strictObject({
  bridge: z
    .strictObject({
      enabled: z.boolean().optional(),
      followMemoryEvents: z.boolean().optional(),
      indexDailyNotes: z.boolean().optional(),
      indexDreamReports: z.boolean().optional(),
      indexMemoryRoot: z.boolean().optional(),
      readMemoryArtifacts: z.boolean().optional(),
    })
    .optional(),
  context: z
    .strictObject({
      includeCompiledDigestPrompt: z.boolean().optional(),
    })
    .optional(),
  ingest: z
    .strictObject({
      allowUrlIngest: z.boolean().optional(),
      autoCompile: z.boolean().optional(),
      maxConcurrentJobs: z.number().int().min(1).optional(),
    })
    .optional(),
  obsidian: z
    .strictObject({
      enabled: z.boolean().optional(),
      openAfterWrites: z.boolean().optional(),
      useOfficialCli: z.boolean().optional(),
      vaultName: z.string().optional(),
    })
    .optional(),
  render: z
    .strictObject({
      createBacklinks: z.boolean().optional(),
      createDashboards: z.boolean().optional(),
      preserveHumanBlocks: z.boolean().optional(),
    })
    .optional(),
  search: z
    .strictObject({
      backend: z.enum(WIKI_SEARCH_BACKENDS).optional(),
      corpus: z.enum(WIKI_SEARCH_CORPORA).optional(),
    })
    .optional(),
  unsafeLocal: z
    .strictObject({
      allowPrivateMemoryCoreAccess: z.boolean().optional(),
      paths: z.array(z.string()).optional(),
    })
    .optional(),
  vault: z
    .strictObject({
      path: z.string().optional(),
      renderMode: z.enum(WIKI_RENDER_MODES).optional(),
    })
    .optional(),
  vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
});

const memoryWikiConfigSchemaBase = buildPluginConfigSchema(MemoryWikiConfigSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { data: resolveMemoryWikiConfig(undefined), success: true };
    }
    const result = MemoryWikiConfigSource.safeParse(value);
    if (result.success) {
      return { data: resolveMemoryWikiConfig(result.data), success: true };
    }
    return {
      error: {
        issues: result.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.filter((segment): segment is string | number => {
            const kind = typeof segment;
            return kind === "string" || kind === "number";
          }),
        })),
      },
      success: false,
    };
  },
});

export const memoryWikiConfigSchema: OpenClawPluginConfigSchema = memoryWikiConfigSchemaBase;

function expandHomePath(inputPath: string, homedir: string): string {
  if (inputPath === "~") {
    return homedir;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir, inputPath.slice(2));
  }
  return inputPath;
}

export function resolveDefaultMemoryWikiVaultPath(homedir = os.homedir()): string {
  return path.join(homedir, ".openclaw", "wiki", "main");
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string },
): ResolvedMemoryWikiConfig {
  const homedir = options?.homedir ?? os.homedir();
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});

  return {
    bridge: {
      enabled: safeConfig.bridge?.enabled ?? false,
      followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true,
      indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
      indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
      indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
      readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
    },
    context: {
      includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false,
    },
    ingest: {
      allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true,
      autoCompile: safeConfig.ingest?.autoCompile ?? true,
      maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
    },
    obsidian: {
      enabled: safeConfig.obsidian?.enabled ?? false,
      useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
      ...(safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {}),
      openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false,
    },
    render: {
      createBacklinks: safeConfig.render?.createBacklinks ?? true,
      createDashboards: safeConfig.render?.createDashboards ?? true,
      preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
    },
    search: {
      backend: safeConfig.search?.backend ?? DEFAULT_WIKI_SEARCH_BACKEND,
      corpus: safeConfig.search?.corpus ?? DEFAULT_WIKI_SEARCH_CORPUS,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
      paths: safeConfig.unsafeLocal?.paths ?? [],
    },
    vault: {
      path: expandHomePath(
        safeConfig.vault?.path ?? resolveDefaultMemoryWikiVaultPath(homedir),
        homedir,
      ),
      renderMode: safeConfig.vault?.renderMode ?? DEFAULT_WIKI_RENDER_MODE,
    },
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
  };
}
