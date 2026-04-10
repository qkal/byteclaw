import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoInstallSpec } from "../../test/helpers/bundled-plugin-paths.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "./plugin-install-path-warnings.js";

async function detectMatrixCustomPathIssue(sourcePath: string | ((pluginPath: string) => string)) {
  return withTempHome(async (home) => {
    const pluginPath = path.join(home, "matrix-plugin");
    await fs.mkdir(pluginPath, { recursive: true });
    const resolvedSourcePath =
      typeof sourcePath === "function" ? sourcePath(pluginPath) : sourcePath;
    const issue = await detectPluginInstallPathIssue({
      install: {
        installPath: pluginPath,
        source: "path",
        sourcePath: resolvedSourcePath,
      },
      pluginId: "matrix",
    });

    return { issue, pluginPath };
  });
}

const MATRIX_REPO_INSTALL_COMMAND = `openclaw plugins install ${repoInstallSpec("matrix")}`;

describe("plugin install path warnings", () => {
  it("ignores non-path installs and blank path candidates", async () => {
    expect(
      await detectPluginInstallPathIssue({
        install: null,
        pluginId: "matrix",
      }),
    ).toBeNull();
    expect(
      await detectPluginInstallPathIssue({
        install: {
          installPath: " ",
          source: "npm",
          sourcePath: " ",
        },
        pluginId: "matrix",
      }),
    ).toBeNull();
  });

  it("detects stale custom plugin install paths", async () => {
    const issue = await detectPluginInstallPathIssue({
      install: {
        installPath: "/tmp/openclaw-matrix-missing",
        source: "path",
        sourcePath: "/tmp/openclaw-matrix-missing",
      },
      pluginId: "matrix",
    });

    expect(issue).toEqual({
      kind: "missing-path",
      path: "/tmp/openclaw-matrix-missing",
      pluginId: "matrix",
    });
    expect(
      formatPluginInstallPathIssue({
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        issue: issue!,
        pluginLabel: "Matrix",
        repoInstallCommand: MATRIX_REPO_INSTALL_COMMAND,
      }),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
      `If you are running from a repo checkout, you can also use "${MATRIX_REPO_INSTALL_COMMAND}".`,
    ]);
  });

  it("uses the second candidate path when the first one is stale", async () => {
    const { issue, pluginPath } = await detectMatrixCustomPathIssue("/tmp/openclaw-matrix-missing");
    expect(issue).toEqual({
      kind: "custom-path",
      path: pluginPath,
      pluginId: "matrix",
    });
  });

  it("detects active custom plugin install paths", async () => {
    const { issue, pluginPath } = await detectMatrixCustomPathIssue(
      (resolvedPluginPath) => resolvedPluginPath,
    );
    expect(issue).toEqual({
      kind: "custom-path",
      path: pluginPath,
      pluginId: "matrix",
    });
  });

  it("applies custom command formatting in warning messages", () => {
    expect(
      formatPluginInstallPathIssue({
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        formatCommand: (command) => `<${command}>`,
        issue: {
          kind: "custom-path",
          path: "/tmp/matrix-plugin",
          pluginId: "matrix",
        },
        pluginLabel: "Matrix",
        repoInstallCommand: MATRIX_REPO_INSTALL_COMMAND,
      }),
    ).toEqual([
      "Matrix is installed from a custom path: /tmp/matrix-plugin",
      "Main updates will not automatically replace that plugin with the repo's default Matrix package.",
      'Reinstall with "<openclaw plugins install @openclaw/matrix>" when you want to return to the standard Matrix plugin.',
      `If you are intentionally running from a repo checkout, reinstall that checkout explicitly with "<${MATRIX_REPO_INSTALL_COMMAND}>" after updates.`,
    ]);
  });

  it("omits repo checkout guidance when no bundled source hint exists", () => {
    expect(
      formatPluginInstallPathIssue({
        defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
        issue: {
          kind: "missing-path",
          path: "/tmp/openclaw-matrix-missing",
          pluginId: "matrix",
        },
        pluginLabel: "Matrix",
        repoInstallCommand: null,
      }),
    ).toEqual([
      "Matrix is installed from a custom path that no longer exists: /tmp/openclaw-matrix-missing",
      'Reinstall with "openclaw plugins install @openclaw/matrix".',
    ]);
  });
});
