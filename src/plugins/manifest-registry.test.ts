import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  clearPluginManifestRegistryCache,
  loadPluginManifestRegistry,
} from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs: string[] = [];

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-registry", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
}

function writeTextFile(rootDir: string, relativePath: string, value: string) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf8");
}

function setupBundleFixture(params: {
  bundleDir: string;
  dirs?: readonly string[];
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.bundleDir, relativeDir));
  }
  for (const [relativePath, value] of Object.entries(params.textFiles ?? {})) {
    writeTextFile(params.bundleDir, relativePath, value);
  }
  if (params.manifestRelativePath && params.manifest) {
    writeTextFile(params.bundleDir, params.manifestRelativePath, JSON.stringify(params.manifest));
  }
}

function createPluginCandidate(params: {
  idHint: string;
  rootDir: string;
  sourceName?: string;
  origin: "bundled" | "global" | "workspace" | "config";
  format?: "openclaw" | "bundle";
  bundleFormat?: "codex" | "claude" | "cursor";
  packageManifest?: OpenClawPackageManifest;
  packageDir?: string;
  bundledManifest?: PluginCandidate["bundledManifest"];
  bundledManifestPath?: string;
}): PluginCandidate {
  return {
    bundleFormat: params.bundleFormat,
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
    format: params.format,
    idHint: params.idHint,
    origin: params.origin,
    packageDir: params.packageDir,
    packageManifest: params.packageManifest,
    rootDir: params.rootDir,
    source: path.join(params.rootDir, params.sourceName ?? "index.ts"),
  };
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistry({
    cache: false,
    candidates,
  });
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_VERSION: undefined,
    VITEST: "true",
    ...overrides,
  };
}

function countDuplicateWarnings(registry: ReturnType<typeof loadPluginManifestRegistry>): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "warn" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

function hasPluginIdMismatchWarning(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
): boolean {
  return registry.diagnostics.some((diagnostic) =>
    diagnostic.message.includes("plugin id mismatch"),
  );
}

function expectRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
  fragment: string,
) {
  expect(registry.diagnostics.some((diag) => diag.message.includes(fragment))).toBe(true);
}

function prepareLinkedManifestFixture(params: { id: string; mode: "symlink" | "hardlink" }): {
  rootDir: string;
  linked: boolean;
} {
  const rootDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
  const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf8");
  fs.writeFileSync(
    outsideManifest,
    JSON.stringify({ configSchema: { type: "object" }, id: params.id }),
    "utf8",
  );

  try {
    if (params.mode === "symlink") {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } else {
      fs.linkSync(outsideManifest, linkedManifest);
    }
    return { linked: true, rootDir };
  } catch (error) {
    if (params.mode === "symlink") {
      return { linked: false, rootDir };
    }
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      return { linked: false, rootDir };
    }
    throw error;
  }
}

function loadSingleCandidateRegistry(params: {
  idHint: string;
  rootDir: string;
  origin: "bundled" | "global" | "workspace" | "config";
}) {
  return loadRegistry([
    createPluginCandidate({
      idHint: params.idHint,
      origin: params.origin,
      rootDir: params.rootDir,
    }),
  ]);
}

function loadRegistryForMinHostVersionCase(params: {
  rootDir: string;
  minHostVersion: string;
  env?: NodeJS.ProcessEnv;
}) {
  return loadPluginManifestRegistry({
    cache: false,
    ...(params.env ? { env: params.env } : {}),
    candidates: [
      createPluginCandidate({
        idHint: "synology-chat",
        origin: "global",
        packageDir: params.rootDir,
        packageManifest: {
          install: {
            minHostVersion: params.minHostVersion,
            npmSpec: "@openclaw/synology-chat",
          },
        },
        rootDir: params.rootDir,
      }),
    ],
  });
}

function hasUnsafeManifestDiagnostic(registry: ReturnType<typeof loadPluginManifestRegistry>) {
  return registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path"));
}

function expectUnsafeWorkspaceManifestRejected(params: {
  id: string;
  mode: "symlink" | "hardlink";
}) {
  const fixture = prepareLinkedManifestFixture({ id: params.id, mode: params.mode });
  if (!fixture.linked) {
    return;
  }
  const registry = loadSingleCandidateRegistry({
    idHint: params.id,
    origin: "workspace",
    rootDir: fixture.rootDir,
  });
  expect(registry.plugins).toHaveLength(0);
  expect(hasUnsafeManifestDiagnostic(registry)).toBe(true);
}

function createDuplicateCandidateRegistry(params: {
  pluginId: string;
  duplicateOrigin: "global" | "workspace";
}) {
  const bundledDir = makeTempDir();
  const duplicateDir = makeTempDir();
  const manifest = { configSchema: { type: "object" }, id: params.pluginId };
  writeManifest(bundledDir, manifest);
  writeManifest(duplicateDir, manifest);

  return loadPluginManifestRegistry({
    cache: false,
    candidates: [
      createPluginCandidate({
        idHint: params.pluginId,
        origin: "bundled",
        rootDir: bundledDir,
      }),
      createPluginCandidate({
        idHint: params.pluginId,
        origin: params.duplicateOrigin,
        rootDir: duplicateDir,
      }),
    ],
  });
}

function createManifestPluginRoot(params: {
  baseDir: string;
  pluginId: string;
  name: string;
  relativePath?: string;
}) {
  const pluginRoot = path.join(
    params.baseDir,
    ...(params.relativePath ? [params.relativePath] : []),
  );
  mkdirSafe(pluginRoot);
  writeManifest(pluginRoot, {
    configSchema: { type: "object" },
    id: params.pluginId,
    name: params.name,
  });
  fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {}", "utf8");
  return pluginRoot;
}

function loadBundleRegistry(params: {
  idHint: string;
  bundleFormat: "codex" | "claude" | "cursor";
  setup: (bundleDir: string) => void;
}) {
  const bundleDir = makeTempDir();
  params.setup(bundleDir);
  return loadRegistry([
    createPluginCandidate({
      bundleFormat: params.bundleFormat,
      format: "bundle",
      idHint: params.idHint,
      origin: "global",
      rootDir: bundleDir,
    }),
  ]);
}

function expectPluginRoot(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
  pluginId: string,
) {
  const plugin = registry.plugins.find((entry) => entry.id === pluginId);
  expect(plugin).toBeDefined();
  return plugin?.rootDir ?? "";
}

function expectCachedPluginRoot(params: {
  first: ReturnType<typeof loadPluginManifestRegistry>;
  second: ReturnType<typeof loadPluginManifestRegistry>;
  pluginId: string;
  firstRoot: string;
  secondRoot: string;
}) {
  expect(fs.realpathSync(expectPluginRoot(params.first, params.pluginId))).toBe(
    fs.realpathSync(params.firstRoot),
  );
  expect(fs.realpathSync(expectPluginRoot(params.second, params.pluginId))).toBe(
    fs.realpathSync(params.secondRoot),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginManifestRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifestRegistry", () => {
  it("emits duplicate warning for truly distinct plugins with same id", () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const manifest = { configSchema: { type: "object" }, id: "test-plugin" };
    writeManifest(dirA, manifest);
    writeManifest(dirB, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "test-plugin",
        origin: "bundled",
        rootDir: dirA,
      }),
      createPluginCandidate({
        idHint: "test-plugin",
        origin: "global",
        rootDir: dirB,
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(1);
  });

  it("reports explicit installed globals as the effective duplicate winner", () => {
    const bundledDir = makeTempDir();
    const globalDir = makeTempDir();
    const manifest = { configSchema: { type: "object" }, id: "zalouser" };
    writeManifest(bundledDir, manifest);
    writeManifest(globalDir, manifest);

    const registry = loadPluginManifestRegistry({
      cache: false,
      candidates: [
        createPluginCandidate({
          idHint: "zalouser",
          origin: "bundled",
          rootDir: bundledDir,
        }),
        createPluginCandidate({
          idHint: "zalouser",
          origin: "global",
          rootDir: globalDir,
        }),
      ],
      config: {
        plugins: {
          installs: {
            zalouser: {
              installPath: globalDir,
              source: "npm",
            },
          },
        },
      },
    });

    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("bundled plugin will be overridden by global plugin"),
      ),
    ).toBe(true);
  });

  it("preserves provider auth env metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      configSchema: { type: "object" },
      enabledByDefault: true,
      id: "openai",
      providerAuthAliases: {
        "openai-codex": "openai",
      },
      providerAuthChoices: [
        {
          assistantPriority: 10,
          assistantVisibility: "visible",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          method: "api-key",
          provider: "openai",
        },
      ],
      providerAuthEnvVars: {
        openai: ["OPENAI_API_KEY"],
      },
      providers: ["openai", "openai-codex"],
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      origin: "bundled",
      rootDir: dir,
    });

    expect(registry.plugins[0]?.providerAuthEnvVars).toEqual({
      openai: ["OPENAI_API_KEY"],
    });
    expect(registry.plugins[0]?.providerAuthAliases).toEqual({
      "openai-codex": "openai",
    });
    expect(registry.plugins[0]?.enabledByDefault).toBe(true);
    expect(registry.plugins[0]?.providerAuthChoices).toEqual([
      {
        assistantPriority: 10,
        assistantVisibility: "visible",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        method: "api-key",
        provider: "openai",
      },
    ]);
  });

  it("preserves channel env metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      channelEnvVars: {
        slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
      },
      channels: ["slack"],
      configSchema: { type: "object" },
      id: "slack",
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "slack",
      origin: "bundled",
      rootDir: dir,
    });

    expect(registry.plugins[0]?.channelEnvVars).toEqual({
      slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
    });
  });

  it("preserves channel config metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      channelConfigs: {
        matrix: {
          description: "Matrix config",
          label: "Matrix",
          preferOver: ["matrix-legacy"],
          schema: {
            properties: {
              homeserver: { type: "string" },
            },
            type: "object",
          },
          uiHints: {
            homeserver: {
              label: "Homeserver",
            },
          },
        },
      },
      channels: ["matrix"],
      configSchema: { type: "object" },
      id: "matrix",
    });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "matrix",
        origin: "workspace",
        rootDir: dir,
      }),
    ]);

    expect(registry.plugins[0]?.channelConfigs).toEqual({
      matrix: {
        description: "Matrix config",
        label: "Matrix",
        preferOver: ["matrix-legacy"],
        schema: {
          properties: {
            homeserver: { type: "string" },
          },
          type: "object",
        },
        uiHints: {
          homeserver: {
            label: "Homeserver",
          },
        },
      },
    });
  });

  it("hydrates bundled channel config metadata onto manifest records", () => {
    const dir = makeTempDir();
    const registry = loadRegistry([
      createPluginCandidate({
        bundledManifest: {
          channelConfigs: {
            telegram: {
              schema: { type: "object" },
            },
          },
          channels: ["telegram"],
          configSchema: { type: "object" },
          id: "telegram",
        },
        bundledManifestPath: path.join(dir, "openclaw.plugin.json"),
        idHint: "telegram",
        origin: "bundled",
        rootDir: dir,
      }),
    ]);

    expect(registry.plugins[0]?.channelConfigs?.telegram).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({
          type: "object",
        }),
      }),
    );
  });

  it("preserves manifest-owned config contracts from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      configContracts: {
        compatibilityMigrationPaths: ["models.bedrockDiscovery"],
        compatibilityRuntimePaths: ["tools.web.search.apiKey"],
        dangerousFlags: [{ equals: "approve-all", path: "permissionMode" }],
        secretInputs: {
          bundledDefaultEnabled: false,
          paths: [{ expected: "string", path: "mcpServers.*.env.*" }],
        },
      },
      configSchema: { type: "object" },
      id: "acpx",
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "acpx",
      origin: "bundled",
      rootDir: dir,
    });

    expect(registry.plugins[0]?.configContracts).toEqual({
      compatibilityMigrationPaths: ["models.bedrockDiscovery"],
      compatibilityRuntimePaths: ["tools.web.search.apiKey"],
      dangerousFlags: [{ equals: "approve-all", path: "permissionMode" }],
      secretInputs: {
        bundledDefaultEnabled: false,
        paths: [{ expected: "string", path: "mcpServers.*.env.*" }],
      },
    });
  });

  it("resolves contract plugin ids by compatibility runtime path", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      configContracts: {
        compatibilityRuntimePaths: ["tools.web.search.apiKey"],
      },
      configSchema: { type: "object" },
      contracts: {
        webSearchProviders: ["brave"],
      },
      id: "brave",
    });

    const otherDir = makeTempDir();
    writeManifest(otherDir, {
      configSchema: { type: "object" },
      contracts: {
        webSearchProviders: ["gemini"],
      },
      id: "google",
    });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "brave",
        origin: "bundled",
        rootDir: dir,
      }),
      createPluginCandidate({
        idHint: "google",
        origin: "bundled",
        rootDir: otherDir,
      }),
    ]);

    expect(
      registry.plugins
        .filter(
          (plugin) =>
            (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
            (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(
              "tools.web.search.apiKey",
            ),
        )
        .map((plugin) => plugin.id),
    ).toEqual(["brave"]);
  });
  it("does not promote legacy top-level capability fields into contracts", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      configSchema: { type: "object" },
      id: "openai",
      imageGenerationProviders: ["openai"],
      mediaUnderstandingProviders: ["openai", "openai-codex"],
      providers: ["openai", "openai-codex"],
      speechProviders: ["openai"],
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      origin: "bundled",
      rootDir: dir,
    });

    expect(registry.plugins[0]?.contracts).toBeUndefined();
  });
  it.each([
    {
      env: { OPENCLAW_VERSION: "2026.3.21" } as NodeJS.ProcessEnv,
      expectWarn: false,
      expectedMessage: "plugin requires OpenClaw >=2026.3.22, but this host is 2026.3.21",
      minHostVersion: ">=2026.3.22",
      name: "skips plugins whose minHostVersion is newer than the current host",
    },
    {
      expectWarn: false,
      expectedMessage: "plugin manifest invalid | openclaw.install.minHostVersion must use",
      minHostVersion: "2026.3.22",
      name: "rejects invalid minHostVersion metadata",
    },
    {
      env: { OPENCLAW_VERSION: "unknown" } as NodeJS.ProcessEnv,
      expectWarn: true,
      expectedMessage: "host version could not be determined",
      minHostVersion: ">=2026.3.22",
      name: "warns distinctly when host version cannot be determined",
    },
  ] as const)("$name", ({ minHostVersion, env, expectedMessage, expectWarn }) => {
    const dir = makeTempDir();
    writeManifest(dir, { configSchema: { type: "object" }, id: "synology-chat" });

    const registry = loadRegistryForMinHostVersionCase({
      minHostVersion,
      rootDir: dir,
      ...(env ? { env } : {}),
    });

    expect(registry.plugins).toEqual([]);
    expectRegistryDiagnosticContains(registry, expectedMessage);
    if (expectWarn) {
      expect(registry.diagnostics.some((diag) => diag.level === "warn")).toBe(true);
    }
  });

  it.each([
    {
      expectedMessage: "global plugin will be overridden by bundled plugin",
      name: "reports bundled plugins as the duplicate winner for auto-discovered globals",
      registry: () =>
        createDuplicateCandidateRegistry({
          duplicateOrigin: "global",
          pluginId: "feishu",
        }),
    },
    {
      expectedMessage: "workspace plugin will be overridden by bundled plugin",
      name: "reports bundled plugins as the duplicate winner for workspace duplicates",
      registry: () =>
        createDuplicateCandidateRegistry({
          duplicateOrigin: "workspace",
          pluginId: "shadowed",
        }),
    },
  ] as const)("$name", ({ registry: buildRegistry, expectedMessage }) => {
    const registry = buildRegistry();
    expectRegistryDiagnosticContains(registry, expectedMessage);
  });

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makeTempDir();
    const manifest = { configSchema: { type: "object" }, id: "feishu" };
    writeManifest(realDir, manifest);

    // Create a symlink pointing to the same directory
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      // On systems where symlinks are not supported (e.g. restricted Windows),
      // Skip this test gracefully.
      return;
    }

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "feishu",
        origin: "bundled",
        rootDir: realDir,
      }),
      createPluginCandidate({
        idHint: "feishu",
        origin: "bundled",
        rootDir: symlinkPath,
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("suppresses duplicate warning when candidates have identical rootDir paths", () => {
    const dir = makeTempDir();
    const manifest = { configSchema: { type: "object" }, id: "same-path-plugin" };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "same-path-plugin",
        origin: "bundled",
        rootDir: dir,
        sourceName: "a.ts",
      }),
      createPluginCandidate({
        idHint: "same-path-plugin",
        origin: "global",
        rootDir: dir,
        sourceName: "b.ts",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("does not warn for id hint mismatches when manifest id is authoritative", () => {
    const dir = makeTempDir();
    writeManifest(dir, { configSchema: { type: "object" }, id: "openai" });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "totally-different",
        origin: "bundled",
        rootDir: dir,
      }),
    ]);

    expect(hasPluginIdMismatchWarning(registry)).toBe(false);
  });

  it.each([
    {
      bundleFormat: "codex" as const,
      expected: {
        bundleCapabilities: expect.arrayContaining(["hooks", "skills"]),
        bundleFormat: "codex",
        format: "bundle",
        hooks: ["hooks"],
        id: "sample-bundle",
        skills: ["skills"],
      },
      idHint: "sample-bundle",
      name: "loads Codex bundle manifests into the registry",
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".codex-plugin", "skills", "hooks"],
          manifest: {
            description: "Bundle fixture",
            hooks: "hooks",
            name: "Sample Bundle",
            skills: "skills",
          },
          manifestRelativePath: ".codex-plugin/plugin.json",
        });
      },
    },
    {
      bundleFormat: "claude" as const,
      expected: {
        bundleCapabilities: expect.arrayContaining(["skills", "commands", "settings"]),
        bundleFormat: "claude",
        format: "bundle",
        id: "claude-sample",
        settingsFiles: ["settings.json"],
        skills: ["skill-packs/starter", "commands-pack"],
      },
      idHint: "claude-sample",
      name: "loads Claude bundle manifests with command roots and settings files",
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".claude-plugin", "skill-packs/starter", "commands-pack"],
          manifest: {
            commands: "commands-pack",
            name: "Claude Sample",
            skills: ["skill-packs/starter"],
          },
          manifestRelativePath: ".claude-plugin/plugin.json",
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
    },
    {
      bundleFormat: "claude" as const,
      expected: {
        bundleCapabilities: expect.arrayContaining(["skills", "commands", "settings"]),
        bundleFormat: "claude",
        format: "bundle",
        settingsFiles: ["settings.json"],
        skills: ["commands"],
      },
      idHint: "manifestless-claude",
      name: "loads manifestless Claude bundles into the registry",
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: ["commands"],
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
    },
    {
      bundleFormat: "cursor" as const,
      expected: {
        bundleCapabilities: expect.arrayContaining([
          "skills",
          "commands",
          "rules",
          "hooks",
          "mcpServers",
        ]),
        bundleFormat: "cursor",
        format: "bundle",
        id: "cursor-sample",
        skills: ["skills", ".cursor/commands"],
      },
      idHint: "cursor-sample",
      name: "loads Cursor bundle manifests into the registry",
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules"],
          manifest: {
            mcpServers: "./.mcp.json",
            name: "Cursor Sample",
          },
          manifestRelativePath: ".cursor-plugin/plugin.json",
          textFiles: {
            ".cursor/hooks.json": '{"hooks":[]}',
            ".mcp.json": '{"servers":{}}',
          },
        });
      },
    },
  ] as const)("$name", ({ idHint, bundleFormat, setup, expected }) => {
    const registry = loadBundleRegistry({
      bundleFormat,
      idHint,
      setup,
    });

    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject(expected);
  });

  it("prefers higher-precedence origins for the same physical directory (config > workspace > global > bundled)", () => {
    const dir = makeTempDir();
    mkdirSafe(path.join(dir, "sub"));
    const manifest = { configSchema: { type: "object" }, id: "precedence-plugin" };
    writeManifest(dir, manifest);

    // Use a different-but-equivalent path representation without requiring symlinks.
    const altDir = path.join(dir, "sub", "..");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "precedence-plugin",
        origin: "bundled",
        rootDir: dir,
      }),
      createPluginCandidate({
        idHint: "precedence-plugin",
        origin: "config",
        rootDir: altDir,
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateWarnings(registry)).toBe(0);
    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.origin).toBe("config");
  });

  it("rejects manifest paths that escape plugin root via symlink", () => {
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-symlink", mode: "symlink" });
  });

  it("rejects manifest paths that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-hardlink", mode: "hardlink" });
  });

  it("allows bundled manifest paths that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = prepareLinkedManifestFixture({ id: "bundled-hardlink", mode: "hardlink" });
    if (!fixture.linked) {
      return;
    }

    const registry = loadSingleCandidateRegistry({
      idHint: "bundled-hardlink",
      origin: "bundled",
      rootDir: fixture.rootDir,
    });
    expect(registry.plugins.some((entry) => entry.id === "bundled-hardlink")).toBe(true);
    expect(hasUnsafeManifestDiagnostic(registry)).toBe(false);
  });

  it("does not reuse cached bundled plugin roots across env changes", () => {
    const bundledA = makeTempDir();
    const bundledB = makeTempDir();
    const matrixA = createManifestPluginRoot({
      baseDir: bundledA,
      name: "Matrix A",
      pluginId: "matrix",
      relativePath: "matrix",
    });
    const matrixB = createManifestPluginRoot({
      baseDir: bundledB,
      name: "Matrix B",
      pluginId: "matrix",
      relativePath: "matrix",
    });

    const first = loadPluginManifestRegistry({
      cache: true,
      env: hermeticEnv({
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
      }),
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      env: hermeticEnv({
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
      }),
    });

    expectCachedPluginRoot({
      first,
      firstRoot: matrixA,
      pluginId: "matrix",
      second,
      secondRoot: matrixB,
    });
  });

  it("does not reuse cached load-path manifests across env home changes", () => {
    const homeA = makeTempDir();
    const homeB = makeTempDir();
    const demoA = createManifestPluginRoot({
      baseDir: homeA,
      name: "Demo A",
      pluginId: "demo",
      relativePath: path.join("plugins", "demo"),
    });
    const demoB = createManifestPluginRoot({
      baseDir: homeB,
      name: "Demo B",
      pluginId: "demo",
      relativePath: path.join("plugins", "demo"),
    });

    const config = {
      plugins: {
        load: {
          paths: ["~/plugins/demo"],
        },
      },
    };

    const first = loadPluginManifestRegistry({
      cache: true,
      config,
      env: hermeticEnv({
        HOME: homeA,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeA, ".state"),
      }),
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      config,
      env: hermeticEnv({
        HOME: homeB,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeB, ".state"),
      }),
    });

    expectCachedPluginRoot({
      first,
      firstRoot: demoA,
      pluginId: "demo",
      second,
      secondRoot: demoB,
    });
  });

  it("does not reuse cached manifests across host version changes", () => {
    const dir = makeTempDir();
    writeManifest(dir, { configSchema: { type: "object" }, id: "synology-chat" });
    fs.writeFileSync(path.join(dir, "index.ts"), "export default {}", "utf8");
    const candidates = [
      createPluginCandidate({
        idHint: "synology-chat",
        origin: "global",
        packageDir: dir,
        packageManifest: {
          install: {
            minHostVersion: ">=2026.3.22",
            npmSpec: "@openclaw/synology-chat",
          },
        },
        rootDir: dir,
      }),
    ];

    const olderHost = loadPluginManifestRegistry({
      cache: true,
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.21",
      }),
    });
    const newerHost = loadPluginManifestRegistry({
      cache: true,
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.22",
      }),
    });

    expect(olderHost.plugins).toEqual([]);
    expect(
      olderHost.diagnostics.some((diag) => diag.message.includes("this host is 2026.3.21")),
    ).toBe(true);
    expect(newerHost.plugins.some((plugin) => plugin.id === "synology-chat")).toBe(true);
    expect(
      newerHost.diagnostics.some((diag) => diag.message.includes("this host is 2026.3.21")),
    ).toBe(false);
  });
});
