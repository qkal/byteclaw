import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectPackageManager as detectPackageManagerImpl } from "./detect-package-manager.js";
import { applyPathPrepend } from "./path-prepend.js";

export type BuildManager = "pnpm" | "bun" | "npm";

export type UpdatePackageManagerRequirement = "allow-fallback" | "require-preferred";

export type UpdatePackageManagerFailureReason =
  | "preferred-manager-unavailable"
  | "pnpm-corepack-enable-failed"
  | "pnpm-corepack-missing"
  | "pnpm-npm-bootstrap-failed";

export type PackageManagerCommandRunner = (
  argv: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type ResolvedBuildManager =
  | {
      kind: "resolved";
      manager: BuildManager;
      preferred: BuildManager;
      fallback: boolean;
      env?: NodeJS.ProcessEnv;
      cleanup?: () => Promise<void>;
    }
  | {
      kind: "missing-required";
      preferred: BuildManager;
      reason: UpdatePackageManagerFailureReason;
    };

export async function detectBuildManager(root: string): Promise<BuildManager> {
  return (await detectPackageManagerImpl(root)) ?? "npm";
}

function managerPreferenceOrder(preferred: BuildManager): BuildManager[] {
  if (preferred === "pnpm") {
    return ["pnpm", "npm", "bun"];
  }
  if (preferred === "bun") {
    return ["bun", "npm", "pnpm"];
  }
  return ["npm", "pnpm", "bun"];
}

function managerVersionArgs(manager: BuildManager): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "--version"];
  }
  if (manager === "bun") {
    return ["bun", "--version"];
  }
  return ["npm", "--version"];
}

async function isManagerAvailable(
  runCommand: PackageManagerCommandRunner,
  manager: BuildManager,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const res = await runCommand(managerVersionArgs(manager), { env, timeoutMs });
    return res.code === 0;
  } catch {
    return false;
  }
}

async function isCommandAvailable(
  runCommand: PackageManagerCommandRunner,
  argv: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    const res = await runCommand(argv, { env, timeoutMs });
    return res.code === 0;
  } catch {
    return false;
  }
}

function cloneCommandEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? process.env)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ) as Record<string, string>;
}

async function enablePnpmViaCorepack(
  runCommand: PackageManagerCommandRunner,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<"enabled" | "missing" | "failed"> {
  if (!(await isCommandAvailable(runCommand, ["corepack", "--version"], timeoutMs, env))) {
    return "missing";
  }
  try {
    const res = await runCommand(["corepack", "enable"], { env, timeoutMs });
    if (res.code !== 0) {
      return "failed";
    }
  } catch {
    return "failed";
  }
  return (await isManagerAvailable(runCommand, "pnpm", timeoutMs, env)) ? "enabled" : "failed";
}

async function bootstrapPnpmViaNpm(params: {
  runCommand: PackageManagerCommandRunner;
  timeoutMs: number;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> } | null> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-pnpm-"));
  const cleanup = async () => {
    await fs.rm(tempRoot, { force: true, recursive: true }).catch(() => {});
  };
  try {
    const installResult = await params.runCommand(
      ["npm", "install", "--prefix", tempRoot, "pnpm@10"],
      {
        env: params.baseEnv,
        timeoutMs: params.timeoutMs,
      },
    );
    if (installResult.code !== 0) {
      await cleanup();
      return null;
    }
    const env = cloneCommandEnv(params.baseEnv);
    applyPathPrepend(env, [path.join(tempRoot, "node_modules", ".bin")]);
    if (!(await isManagerAvailable(params.runCommand, "pnpm", params.timeoutMs, env))) {
      await cleanup();
      return null;
    }
    return { cleanup, env };
  } catch {
    await cleanup();
    return null;
  }
}

export async function resolveUpdateBuildManager(
  runCommand: PackageManagerCommandRunner,
  root: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
  requirement: UpdatePackageManagerRequirement = "allow-fallback",
): Promise<ResolvedBuildManager> {
  const preferred = await detectBuildManager(root);
  if (preferred === "pnpm") {
    if (await isManagerAvailable(runCommand, "pnpm", timeoutMs, baseEnv)) {
      return { fallback: false, kind: "resolved", manager: "pnpm", preferred };
    }

    const corepackStatus = await enablePnpmViaCorepack(runCommand, timeoutMs, baseEnv);
    if (corepackStatus === "enabled") {
      return { fallback: false, kind: "resolved", manager: "pnpm", preferred };
    }

    const npmAvailable = await isManagerAvailable(runCommand, "npm", timeoutMs, baseEnv);
    if (npmAvailable) {
      const pnpmBootstrap = await bootstrapPnpmViaNpm({
        baseEnv,
        runCommand,
        timeoutMs,
      });
      if (pnpmBootstrap) {
        return {
          cleanup: pnpmBootstrap.cleanup,
          env: pnpmBootstrap.env,
          fallback: false,
          kind: "resolved",
          manager: "pnpm",
          preferred,
        };
      }
      if (requirement === "require-preferred") {
        return { kind: "missing-required", preferred, reason: "pnpm-npm-bootstrap-failed" };
      }
    }

    if (requirement === "require-preferred") {
      if (corepackStatus === "missing") {
        return { kind: "missing-required", preferred, reason: "pnpm-corepack-missing" };
      }
      if (corepackStatus === "failed") {
        return { kind: "missing-required", preferred, reason: "pnpm-corepack-enable-failed" };
      }
      return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
    }
  }

  for (const manager of managerPreferenceOrder(preferred)) {
    if (await isManagerAvailable(runCommand, manager, timeoutMs, baseEnv)) {
      return { fallback: manager !== preferred, kind: "resolved", manager, preferred };
    }
  }

  if (requirement === "require-preferred") {
    return { kind: "missing-required", preferred, reason: "preferred-manager-unavailable" };
  }

  return { fallback: preferred !== "npm", kind: "resolved", manager: "npm", preferred };
}

export function managerScriptArgs(manager: BuildManager, script: string, args: string[] = []) {
  if (manager === "pnpm") {
    return ["pnpm", script, ...args];
  }
  if (manager === "bun") {
    return ["bun", "run", script, ...args];
  }
  if (args.length > 0) {
    return ["npm", "run", script, "--", ...args];
  }
  return ["npm", "run", script];
}

export function managerInstallArgs(manager: BuildManager, opts?: { compatFallback?: boolean }) {
  if (manager === "pnpm") {
    return ["pnpm", "install"];
  }
  if (manager === "bun") {
    return ["bun", "install"];
  }
  if (opts?.compatFallback) {
    return ["npm", "install", "--no-package-lock", "--legacy-peer-deps"];
  }
  return ["npm", "install"];
}

export function managerInstallIgnoreScriptsArgs(manager: BuildManager): string[] | null {
  if (manager === "pnpm") {
    return ["pnpm", "install", "--ignore-scripts"];
  }
  if (manager === "bun") {
    return ["bun", "install", "--ignore-scripts"];
  }
  return ["npm", "install", "--ignore-scripts"];
}
