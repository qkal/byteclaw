import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { expectSingleNpmInstallIgnoreScriptsCall } from "../test-utils/exec-assertions.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  installPluginFromFile,
  installPluginFromPath,
} from "./install.js";
import { createSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

const suiteTempRootTracker = createSuiteTempRootTracker("openclaw-plugin-install-path");

async function packToArchive(params: {
  pkgDir: string;
  outDir: string;
  outName: string;
  flatRoot?: boolean;
}) {
  const dest = path.join(params.outDir, params.outName);
  fs.rmSync(dest, { force: true });
  const entries = params.flatRoot ? fs.readdirSync(params.pkgDir) : [path.basename(params.pkgDir)];
  await tar.c(
    {
      cwd: params.flatRoot ? params.pkgDir : path.dirname(params.pkgDir),
      file: dest,
      gzip: true,
    },
    entries,
  );
  return dest;
}

function setupBundleInstallFixture(params: {
  bundleFormat: "codex" | "claude" | "cursor";
  name: string;
}) {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  const manifestDir = path.join(
    pluginDir,
    params.bundleFormat === "codex"
      ? ".codex-plugin"
      : params.bundleFormat === "cursor"
        ? ".cursor-plugin"
        : ".claude-plugin",
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({
      description: `${params.bundleFormat} bundle fixture`,
      name: params.name,
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    }),
    "utf8",
  );
  if (params.bundleFormat === "cursor") {
    fs.mkdirSync(path.join(pluginDir, ".cursor", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".cursor", "commands", "review.md"),
      "---\ndescription: fixture\n---\n",
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(pluginDir, "skills", "SKILL.md"),
    "---\ndescription: fixture\n---\n",
    "utf8",
  );
  return { extensionsDir: path.join(stateDir, "extensions"), pluginDir };
}

function setupDualFormatInstallFixture(params: { bundleFormat: "codex" | "claude" }) {
  const caseDir = suiteTempRootTracker.makeTempDir();
  const stateDir = path.join(caseDir, "state");
  const pluginDir = path.join(caseDir, "plugin-src");
  fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills"), { recursive: true });
  const manifestDir = path.join(
    pluginDir,
    params.bundleFormat === "codex" ? ".codex-plugin" : ".claude-plugin",
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      dependencies: { "left-pad": "1.3.0" },
      name: "@openclaw/native-dual",
      openclaw: { extensions: ["./dist/index.js"] },
      version: "0.0.1",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      configSchema: { properties: {}, type: "object" },
      id: "native-dual",
      skills: ["skills"],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginDir, "dist", "index.js"), "export {};", "utf8");
  fs.writeFileSync(path.join(pluginDir, "skills", "SKILL.md"), "---\ndescription: fixture\n---\n");
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify({
      name: "Bundle Fallback",
      ...(params.bundleFormat === "codex" ? { skills: "skills" } : {}),
    }),
    "utf8",
  );
  return { extensionsDir: path.join(stateDir, "extensions"), pluginDir };
}

async function installFromFileWithWarnings(params: {
  extensionsDir: string;
  filePath: string;
  dangerouslyForceUnsafeInstall?: boolean;
}) {
  const warnings: string[] = [];
  const result = await installPluginFromFile({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    extensionsDir: params.extensionsDir,
    filePath: params.filePath,
    logger: {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
    },
  });
  return { result, warnings };
}

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

beforeEach(() => {
  resetGlobalHookRunner();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("installPluginFromPath", () => {
  it("runs before_install for plain file plugins with file provenance metadata", async () => {
    const handler = vi.fn().mockReturnValue({
      findings: [
        {
          file: "payload.js",
          line: 1,
          message: "Review single-file plugin before install",
          ruleId: "manual-review",
          severity: "warn",
        },
      ],
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ handler, hookName: "before_install" }]));

    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf8");

    const result = await installPluginFromFile({
      extensionsDir,
      filePath: sourcePath,
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      builtinScan: {
        status: "ok",
      },
      origin: "plugin-file",
      plugin: {
        contentType: "file",
        extensions: ["payload.js"],
        pluginId: "payload",
      },
      request: {
        kind: "plugin-file",
        mode: "install",
        requestedSpecifier: sourcePath,
      },
      sourcePath,
      sourcePathKind: "file",
      targetName: "payload",
      targetType: "plugin",
    });
    expect(handler.mock.calls[0]?.[1]).toEqual({
      origin: "plugin-file",
      requestKind: "plugin-file",
      targetType: "plugin",
    });
  });

  it("blocks plain file installs when the scanner finds dangerous code patterns", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "eval('danger');\n", "utf8");

    const { result, warnings } = await installFromFileWithWarnings({
      extensionsDir,
      filePath: sourcePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED);
      expect(result.error).toContain('Plugin file "payload" installation blocked');
    }
    expect(warnings.some((w) => w.includes("dangerous code pattern"))).toBe(true);
  });

  it("allows plain file installs with dangerous code patterns when forced unsafe install is set", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    fs.mkdirSync(extensionsDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "eval('danger');\n", "utf8");

    const { result, warnings } = await installFromFileWithWarnings({
      dangerouslyForceUnsafeInstall: true,
      extensionsDir,
      filePath: sourcePath,
    });

    expect(result.ok).toBe(true);
    expect(
      warnings.some((warning) =>
        warning.includes(
          "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
        ),
      ),
    ).toBe(true);
  });

  it("blocks hardlink alias overwrites when installing a plain file plugin", async () => {
    const baseDir = suiteTempRootTracker.makeTempDir();
    const extensionsDir = path.join(baseDir, "extensions");
    const outsideDir = path.join(baseDir, "outside");
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const sourcePath = path.join(baseDir, "payload.js");
    fs.writeFileSync(sourcePath, "console.log('SAFE');\n", "utf8");
    const victimPath = path.join(outsideDir, "victim.js");
    fs.writeFileSync(victimPath, "ORIGINAL", "utf8");

    const targetPath = path.join(extensionsDir, "payload.js");
    fs.linkSync(victimPath, targetPath);

    const result = await installPluginFromPath({
      extensionsDir,
      mode: "update",
      path: sourcePath,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.toLowerCase()).toMatch(/hardlink|path alias escape/);
    expect(fs.readFileSync(victimPath, "utf8")).toBe("ORIGINAL");
  });

  it("installs Claude bundles from an archive path", async () => {
    const { pluginDir, extensionsDir } = setupBundleInstallFixture({
      bundleFormat: "claude",
      name: "Claude Sample",
    });
    const archivePath = path.join(suiteTempRootTracker.makeTempDir(), "claude-bundle.tgz");

    await packToArchive({
      outDir: path.dirname(archivePath),
      outName: path.basename(archivePath),
      pkgDir: pluginDir,
    });

    const result = await installPluginFromPath({
      extensionsDir,
      path: archivePath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("claude-sample");
    expect(fs.existsSync(path.join(result.targetDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("prefers native package installs over bundle installs for dual-format archives", async () => {
    const { pluginDir, extensionsDir } = setupDualFormatInstallFixture({
      bundleFormat: "claude",
    });
    const archivePath = path.join(suiteTempRootTracker.makeTempDir(), "dual-format.tgz");

    await packToArchive({
      outDir: path.dirname(archivePath),
      outName: path.basename(archivePath),
      pkgDir: pluginDir,
    });

    const run = vi.mocked(runCommandWithTimeout);
    run.mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "exit",
    });

    const result = await installPluginFromPath({
      extensionsDir,
      path: archivePath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("native-dual");
    expect(result.targetDir).toBe(path.join(extensionsDir, "native-dual"));
    expectSingleNpmInstallIgnoreScriptsCall({
      calls: run.mock.calls as [unknown, { cwd?: string } | undefined][],
      expectedTargetDir: result.targetDir,
    });
  });
});
