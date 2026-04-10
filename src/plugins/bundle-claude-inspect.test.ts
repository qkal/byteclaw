import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

/**
 * Integration test: builds a Claude Code bundle plugin fixture on disk
 * and verifies manifest parsing, capability detection, hook resolution,
 * MCP server discovery, and settings detection all work end-to-end.
 */
describe("Claude bundle plugin inspect integration", () => {
  let rootDir: string;
  const tempDirs: string[] = [];

  function writeFixtureText(relativePath: string, value: string) {
    fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(rootDir, relativePath), value, "utf8");
  }

  function writeFixtureJson(relativePath: string, value: unknown) {
    writeFixtureText(relativePath, JSON.stringify(value));
  }

  function writeFixtureEntries(
    entries: Readonly<Record<string, string | Record<string, unknown>>>,
  ) {
    Object.entries(entries).forEach(([relativePath, value]) => {
      if (typeof value === "string") {
        writeFixtureText(relativePath, value);
        return;
      }
      writeFixtureJson(relativePath, value);
    });
  }

  function setupClaudeInspectFixture() {
    for (const relativeDir of [
      ".claude-plugin",
      "skill-packs/demo",
      "extra-commands/cmd",
      "hooks",
      "custom-hooks",
      "agents",
      "output-styles",
    ]) {
      fs.mkdirSync(path.join(rootDir, relativeDir), { recursive: true });
    }

    writeFixtureEntries({
      ".claude-plugin/plugin.json": {
        agents: "agents",
        commands: "extra-commands",
        description: "Integration test fixture for Claude bundle inspection",
        hooks: "custom-hooks",
        lspServers: ".lsp.json",
        mcpServers: ".mcp.json",
        name: "Test Claude Plugin",
        outputStyles: "output-styles",
        skills: ["skill-packs"],
        version: "1.0.0",
      },
      ".lsp.json": {
        lspServers: {
          "typescript-lsp": {
            args: ["--stdio"],
            command: "typescript-language-server",
          },
        },
      },
      ".mcp.json": {
        mcpServers: {
          "test-sse-server": {
            url: "http://localhost:3000/sse",
          },
          "test-stdio-server": {
            args: ["hello"],
            command: "echo",
          },
        },
      },
      "extra-commands/cmd/SKILL.md":
        "---\nname: cmd\ndescription: A command skill\n---\nRun a command.",
      "hooks/hooks.json": '{"hooks":[]}',
      "settings.json": { thinkingLevel: "high" },
      "skill-packs/demo/SKILL.md":
        "---\nname: demo\ndescription: A demo skill\n---\nDo something useful.",
    });
  }

  function expectLoadedClaudeManifest() {
    const result = loadBundleManifest({ bundleFormat: "claude", rootDir });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Claude bundle manifest to load");
    }
    return result.manifest;
  }

  function expectClaudeManifestField(params: {
    field: "skills" | "hooks" | "settingsFiles" | "capabilities";
    includes: readonly string[];
  }) {
    const manifest = expectLoadedClaudeManifest();
    const values = manifest[params.field];
    expect(values).toEqual(expect.arrayContaining([...params.includes]));
  }

  function expectNoDiagnostics(diagnostics: unknown[]) {
    expect(diagnostics).toEqual([]);
  }

  function expectBundleRuntimeSupport(params: {
    actual: {
      supportedServerNames: string[];
      unsupportedServerNames: string[];
      diagnostics: unknown[];
    } & Record<string, unknown>;
    supportedServerNames: readonly string[];
    unsupportedServerNames: readonly string[];
    hasSupportedKey: "hasSupportedStdioServer" | "hasStdioServer";
  }) {
    expect(params.actual[params.hasSupportedKey]).toBe(true);
    expect(params.actual.supportedServerNames).toEqual(
      expect.arrayContaining([...params.supportedServerNames]),
    );
    expect(params.actual.unsupportedServerNames).toEqual([...params.unsupportedServerNames]);
    expectNoDiagnostics(params.actual.diagnostics);
  }

  function inspectClaudeBundleRuntimeSupport(kind: "mcp" | "lsp"): {
    supportedServerNames: string[];
    unsupportedServerNames: string[];
    diagnostics: unknown[];
    hasSupportedStdioServer?: boolean;
    hasStdioServer?: boolean;
  } {
    if (kind === "mcp") {
      return inspectBundleMcpRuntimeSupport({
        bundleFormat: "claude",
        pluginId: "test-claude-plugin",
        rootDir,
      });
    }
    return inspectBundleLspRuntimeSupport({
      bundleFormat: "claude",
      pluginId: "test-claude-plugin",
      rootDir,
    });
  }

  beforeAll(() => {
    rootDir = makeTrackedTempDir("openclaw-claude-bundle", tempDirs);
    setupClaudeInspectFixture();
  });

  afterAll(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("loads the full Claude bundle manifest with all capabilities", () => {
    const m = expectLoadedClaudeManifest();
    expect(m).toMatchObject({
      bundleFormat: "claude",
      description: "Integration test fixture for Claude bundle inspection",
      name: "Test Claude Plugin",
      version: "1.0.0",
    });
  });

  it.each([
    {
      field: "skills" as const,
      includes: ["skill-packs", "extra-commands", "agents", "output-styles"],
      name: "resolves skills from skills, commands, and agents paths",
    },
    {
      field: "hooks" as const,
      includes: ["hooks/hooks.json", "custom-hooks"],
      name: "resolves hooks from default and declared paths",
    },
    {
      field: "settingsFiles" as const,
      includes: ["settings.json"],
      name: "detects settings files",
    },
    {
      field: "capabilities" as const,
      includes: [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ],
      name: "detects all bundle capabilities",
    },
  ] as const)("$name", ({ field, includes }) => {
    expectClaudeManifestField({ field, includes });
  });

  it.each([
    {
      hasSupportedKey: "hasSupportedStdioServer" as const,
      kind: "mcp" as const,
      name: "inspects MCP runtime support with supported and unsupported servers",
      supportedServerNames: ["test-stdio-server"],
      unsupportedServerNames: ["test-sse-server"],
    },
    {
      hasSupportedKey: "hasStdioServer" as const,
      kind: "lsp" as const,
      name: "inspects LSP runtime support with stdio server",
      supportedServerNames: ["typescript-lsp"],
      unsupportedServerNames: [],
    },
  ])("$name", ({ kind, supportedServerNames, unsupportedServerNames, hasSupportedKey }) => {
    expectBundleRuntimeSupport({
      actual: inspectClaudeBundleRuntimeSupport(kind),
      hasSupportedKey,
      supportedServerNames,
      unsupportedServerNames,
    });
  });
});
