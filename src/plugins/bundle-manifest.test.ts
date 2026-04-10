import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  detectBundleManifestFormat,
  loadBundleManifest,
} from "./bundle-manifest.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-bundle-manifest", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

function expectLoadedManifest(rootDir: string, bundleFormat: "codex" | "claude" | "cursor") {
  const result = loadBundleManifest({ bundleFormat, rootDir });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected bundle manifest to load");
  }
  return result.manifest;
}

function writeBundleManifest(
  rootDir: string,
  relativePath: string,
  manifest: Record<string, unknown>,
) {
  writeBundleFixtureFile(rootDir, relativePath, manifest);
}

function writeBundleFixtureFile(rootDir: string, relativePath: string, value: unknown) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(
    path.join(rootDir, relativePath),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function writeBundleFixtureFiles(rootDir: string, files: Readonly<Record<string, unknown>>) {
  Object.entries(files).forEach(([relativePath, value]) => {
    writeBundleFixtureFile(rootDir, relativePath, value);
  });
}

function setupBundleFixture(params: {
  rootDir: string;
  dirs?: readonly string[];
  jsonFiles?: Readonly<Record<string, unknown>>;
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.rootDir, relativeDir));
  }
  writeBundleFixtureFiles(params.rootDir, params.jsonFiles ?? {});
  writeBundleFixtureFiles(params.rootDir, params.textFiles ?? {});
  if (params.manifestRelativePath && params.manifest) {
    writeBundleManifest(params.rootDir, params.manifestRelativePath, params.manifest);
  }
}

function setupClaudeHookFixture(
  rootDir: string,
  kind: "default-hooks" | "custom-hooks" | "no-hooks",
) {
  if (kind === "default-hooks") {
    setupBundleFixture({
      dirs: [".claude-plugin", "hooks"],
      jsonFiles: { "hooks/hooks.json": { hooks: [] } },
      manifest: {
        description: "Claude hooks fixture",
        name: "Hook Plugin",
      },
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      rootDir,
    });
    return;
  }
  if (kind === "custom-hooks") {
    setupBundleFixture({
      dirs: [".claude-plugin", "custom-hooks"],
      manifest: {
        hooks: "custom-hooks",
        name: "Custom Hook Plugin",
      },
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      rootDir,
    });
    return;
  }
  setupBundleFixture({
    dirs: [".claude-plugin", "skills"],
    manifest: { name: "No Hooks" },
    manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
    rootDir,
  });
}

function expectBundleManifest(params: {
  rootDir: string;
  bundleFormat: "codex" | "claude" | "cursor";
  expected: Record<string, unknown>;
}) {
  expect(detectBundleManifestFormat(params.rootDir)).toBe(params.bundleFormat);
  expect(expectLoadedManifest(params.rootDir, params.bundleFormat)).toMatchObject(params.expected);
}

function expectClaudeHookResolution(params: {
  rootDir: string;
  expectedHooks: readonly string[];
  hasHooksCapability: boolean;
}) {
  const manifest = expectLoadedManifest(params.rootDir, "claude");
  expect(manifest.hooks).toEqual(params.expectedHooks);
  expect(manifest.capabilities.includes("hooks")).toBe(params.hasHooksCapability);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("bundle manifest parsing", () => {
  it.each([
    {
      bundleFormat: "codex" as const,
      expected: {
        bundleFormat: "codex",
        capabilities: expect.arrayContaining(["hooks", "skills", "mcpServers", "apps"]),
        description: "Codex fixture",
        hooks: ["hooks"],
        id: "sample-bundle",
        name: "Sample Bundle",
        skills: ["skills"],
      },
      name: "detects and loads Codex bundle manifests",
      setup: (rootDir: string) => {
        setupBundleFixture({
          dirs: [".codex-plugin", "skills", "hooks"],
          manifest: {
            apps: {
              sample: {
                title: "Sample App",
              },
            },
            description: "Codex fixture",
            hooks: "hooks",
            mcpServers: {
              sample: {
                args: ["server.js"],
                command: "node",
              },
            },
            name: "Sample Bundle",
            skills: "skills",
          },
          manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
          rootDir,
        });
      },
    },
    {
      bundleFormat: "claude" as const,
      expected: {
        bundleFormat: "claude",
        capabilities: expect.arrayContaining([
          "hooks",
          "skills",
          "commands",
          "agents",
          "mcpServers",
          "lspServers",
          "outputStyles",
          "settings",
        ]),
        description: "Claude fixture",
        hooks: ["hooks/hooks.json", "hooks-pack"],
        id: "claude-sample",
        name: "Claude Sample",
        settingsFiles: ["settings.json"],
        skills: ["skill-packs/starter", "commands-pack", "agents-pack", "styles"],
      },
      name: "detects and loads Claude bundle manifests from the component layout",
      setup: (rootDir: string) => {
        setupBundleFixture({
          dirs: [
            ".claude-plugin",
            "skill-packs/starter",
            "commands-pack",
            "agents-pack",
            "hooks-pack",
            "mcp",
            "lsp",
            "styles",
            "hooks",
          ],
          manifest: {
            agents: "agents-pack",
            commands: "commands-pack",
            description: "Claude fixture",
            hooks: "hooks-pack",
            lspServers: "lsp",
            mcpServers: "mcp",
            name: "Claude Sample",
            outputStyles: "styles",
            skills: ["skill-packs/starter"],
          },
          manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
          rootDir,
          textFiles: {
            "hooks/hooks.json": '{"hooks":[]}',
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
    },
    {
      bundleFormat: "cursor" as const,
      expected: {
        bundleFormat: "cursor",
        capabilities: expect.arrayContaining([
          "skills",
          "commands",
          "agents",
          "rules",
          "hooks",
          "mcpServers",
        ]),
        description: "Cursor fixture",
        hooks: [],
        id: "cursor-sample",
        name: "Cursor Sample",
        skills: ["skills", ".cursor/commands"],
      },
      name: "detects and loads Cursor bundle manifests",
      setup: (rootDir: string) => {
        setupBundleFixture({
          dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules", ".cursor/agents"],
          manifest: {
            description: "Cursor fixture",
            mcpServers: "./.mcp.json",
            name: "Cursor Sample",
          },
          manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
          rootDir,
          textFiles: {
            ".cursor/hooks.json": '{"hooks":[]}',
            ".mcp.json": '{"servers":{}}',
          },
        });
      },
    },
    {
      bundleFormat: "claude" as const,
      expected: (rootDir: string) => ({
        capabilities: expect.arrayContaining(["skills", "commands", "settings"]),
        id: path.basename(rootDir).toLowerCase(),
        settingsFiles: ["settings.json"],
        skills: ["skills", "commands"],
      }),
      name: "detects manifestless Claude bundles from the default layout",
      setup: (rootDir: string) => {
        setupBundleFixture({
          dirs: ["commands", "skills"],
          rootDir,
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
    },
  ] as const)("$name", ({ bundleFormat, setup, expected }) => {
    const rootDir = makeTempDir();
    setup(rootDir);

    expectBundleManifest({
      bundleFormat,
      expected: typeof expected === "function" ? expected(rootDir) : expected,
      rootDir,
    });
  });

  it.each([
    {
      bundleFormat: "codex" as const,
      dirs: ["skills", "hooks"],
      expected: {
        bundleFormat: "codex",
        hooks: ["hooks"],
        id: "codex-json5-bundle",
        name: "Codex JSON5 Bundle",
        skills: ["skills"],
      },
      json5Manifest: `{
  // Bundle name can include comments and trailing commas.
  name: "Codex JSON5 Bundle",
  skills: "skills",
  hooks: "hooks",
}`,
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "accepts JSON5 Codex bundle manifests",
    },
    {
      bundleFormat: "claude" as const,
      dirs: [".claude-plugin", "commands-pack", "hooks-pack", "styles"],
      expected: {
        bundleFormat: "claude",
        hooks: ["hooks-pack"],
        id: "claude-json5-bundle",
        name: "Claude JSON5 Bundle",
        skills: ["commands-pack", "styles"],
      },
      json5Manifest: `{
  name: "Claude JSON5 Bundle",
  commands: "commands-pack",
  hooks: "hooks-pack",
  outputStyles: "styles",
}`,
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "accepts JSON5 Claude bundle manifests",
    },
    {
      bundleFormat: "cursor" as const,
      dirs: [".cursor-plugin", "skills", ".cursor/commands"],
      expected: {
        bundleFormat: "cursor",
        hooks: [],
        id: "cursor-json5-bundle",
        name: "Cursor JSON5 Bundle",
        skills: ["skills", ".cursor/commands"],
      },
      json5Manifest: `{
  name: "Cursor JSON5 Bundle",
  commands: ".cursor/commands",
  mcpServers: "./.mcp.json",
}`,
      manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "accepts JSON5 Cursor bundle manifests",
      textFiles: {
        ".mcp.json": "{ servers: {}, }",
      },
    },
  ] as const)(
    "$name",
    ({ bundleFormat, manifestRelativePath, json5Manifest, dirs, textFiles, expected }) => {
      const rootDir = makeTempDir();
      setupBundleFixture({
        dirs: [path.dirname(manifestRelativePath), ...dirs],
        rootDir,
        textFiles: {
          [manifestRelativePath]: json5Manifest,
          ...textFiles,
        },
      });

      expectBundleManifest({
        bundleFormat,
        expected,
        rootDir,
      });
    },
  );

  it.each([
    {
      bundleFormat: "codex" as const,
      manifestRelativePath: CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "rejects JSON5 Codex bundle manifests that parse to non-objects",
    },
    {
      bundleFormat: "claude" as const,
      manifestRelativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "rejects JSON5 Claude bundle manifests that parse to non-objects",
    },
    {
      bundleFormat: "cursor" as const,
      manifestRelativePath: CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
      name: "rejects JSON5 Cursor bundle manifests that parse to non-objects",
    },
  ] as const)("$name", ({ bundleFormat, manifestRelativePath }) => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      dirs: [path.dirname(manifestRelativePath)],
      rootDir,
      textFiles: {
        [manifestRelativePath]: "'still not an object'",
      },
    });

    const result = loadBundleManifest({ bundleFormat, rootDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it.each([
    {
      expectedHooks: ["hooks/hooks.json"],
      hasHooksCapability: true,
      name: "resolves Claude bundle hooks from default and declared paths",
      setupKind: "default-hooks",
    },
    {
      expectedHooks: ["custom-hooks"],
      hasHooksCapability: true,
      name: "resolves Claude bundle hooks from manifest-declared paths only",
      setupKind: "custom-hooks",
    },
    {
      expectedHooks: [],
      hasHooksCapability: false,
      name: "returns empty hooks for Claude bundles with no hooks directory",
      setupKind: "no-hooks",
    },
  ] as const)("$name", ({ setupKind, expectedHooks, hasHooksCapability }) => {
    const rootDir = makeTempDir();
    setupClaudeHookFixture(rootDir, setupKind);
    expectClaudeHookResolution({
      expectedHooks,
      hasHooksCapability,
      rootDir,
    });
  });

  it("does not misclassify native index plugins as manifestless Claude bundles", () => {
    const rootDir = makeTempDir();
    setupBundleFixture({
      dirs: ["commands"],
      rootDir,
      textFiles: { "index.ts": "export default {}" },
    });

    expect(detectBundleManifestFormat(rootDir)).toBeNull();
  });
});
