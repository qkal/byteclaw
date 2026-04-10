import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

interface RuntimeDepEntry {
  name: string;
  version: string;
  pluginIds: string[];
}

interface RuntimeDepConflict {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function dependencySentinelPath(depName: string): string {
  return path.join("node_modules", ...depName.split("/"), "package.json");
}

function collectRuntimeDeps(packageJson: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function collectBundledPluginRuntimeDeps(params: { extensionsDir: string }): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const packageJsonPath = path.join(params.extensionsDir, pluginId, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
        if (typeof rawVersion !== "string" || rawVersion.trim() === "") {
          continue;
        }
        const version = rawVersion.trim();
        const byVersion = versionMap.get(name) ?? new Map<string, Set<string>>();
        const pluginIds = byVersion.get(version) ?? new Set<string>();
        pluginIds.add(pluginId);
        byVersion.set(version, pluginIds);
        versionMap.set(name, byVersion);
      }
    } catch {
      // Ignore malformed plugin manifests; doctor will surface those separately.
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
          version,
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      pluginIdsByVersion,
      versions,
    });
  }

  return {
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

export function scanBundledPluginRuntimeDeps(params: { packageRoot: string }): {
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { conflicts: [], missing: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { conflicts: [], missing: [] };
  }
  const { deps, conflicts } = collectBundledPluginRuntimeDeps({ extensionsDir });
  const missing = deps.filter(
    (dep) => !fs.existsSync(path.join(params.packageRoot, dependencySentinelPath(dep.name))),
  );
  return { conflicts, missing };
}

function createNestedNpmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

function installBundledRuntimeDeps(params: {
  packageRoot: string;
  missingSpecs: string[];
  env: NodeJS.ProcessEnv;
}) {
  const result = spawnSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-save",
      "--package-lock=false",
      "--ignore-scripts",
      "--legacy-peer-deps",
      ...params.missingSpecs,
    ],
    {
      cwd: params.packageRoot,
      encoding: "utf8",
      env: createNestedNpmInstallEnv(params.env),
      shell: false,
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(output || "npm install failed");
  }
}

export async function maybeRepairBundledPluginRuntimeDeps(params: {
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
  installDeps?: (params: { packageRoot: string; missingSpecs: string[] }) => void;
}): Promise<void> {
  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
  if (!packageRoot) {
    return;
  }

  const { missing, conflicts } = scanBundledPluginRuntimeDeps({ packageRoot });
  if (conflicts.length > 0) {
    const conflictLines = conflicts.flatMap((conflict) => [
      `- ${conflict.name}: ${conflict.versions.join(", ")}`,
      ...conflict.versions.flatMap((version) => {
        const pluginIds = conflict.pluginIdsByVersion.get(version) ?? [];
        return pluginIds.length > 0 ? [`  - ${version}: ${pluginIds.join(", ")}`] : [];
      }),
    ]);
    note(
      [
        "Bundled plugin runtime deps use conflicting versions.",
        ...conflictLines,
        `Update bundled plugins and rerun ${formatCliCommand("openclaw doctor")}.`,
      ].join("\n"),
      "Bundled plugins",
    );
  }

  if (missing.length === 0) {
    return;
  }

  const missingSpecs = missing.map((dep) => `${dep.name}@${dep.version}`);
  note(
    [
      "Bundled plugin runtime deps are missing.",
      ...missing.map((dep) => `- ${dep.name}@${dep.version} (used by ${dep.pluginIds.join(", ")})`),
      `Fix: run ${formatCliCommand("openclaw doctor --fix")} to install them.`,
    ].join("\n"),
    "Bundled plugins",
  );

  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      initialValue: true,
      message: "Install missing bundled plugin runtime deps now?",
    }));
  if (!shouldRepair) {
    return;
  }

  try {
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDeps({
          env: params.env ?? process.env,
          missingSpecs: installParams.missingSpecs,
          packageRoot: installParams.packageRoot,
        }));
    install({ missingSpecs, packageRoot });
    note(`Installed bundled plugin deps: ${missingSpecs.join(", ")}`, "Bundled plugins");
  } catch (error) {
    params.runtime.error(`Failed to install bundled plugin runtime deps: ${String(error)}`);
  }
}
