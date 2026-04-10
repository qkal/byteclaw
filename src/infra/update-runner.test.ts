import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledDistPluginFile } from "../../test/helpers/bundled-plugin-paths.js";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { pathExists } from "../utils.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { runGatewayUpdate } from "./update-runner.js";

interface CommandResponse {
  stdout?: string;
  stderr?: string;
  code?: number | null;
}
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
const WHATSAPP_LIGHT_RUNTIME_API = bundledDistPluginFile("whatsapp", "light-runtime-api.js");
const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-update-" });

function toCommandResult(response?: CommandResponse): CommandResult {
  return {
    code: response?.code ?? 0,
    stderr: response?.stderr ?? "",
    stdout: response?.stdout ?? "",
  };
}

function createRunner(responses: Record<string, CommandResponse>) {
  const calls: string[] = [];
  const runner = async (argv: string[]) => {
    const key = argv.join(" ");
    calls.push(key);
    return toCommandResult(responses[key]);
  };
  return { calls, runner };
}

describe("runGatewayUpdate", () => {
  const preflightPrefixPattern = /(?:openclaw-update-preflight-|ocu-pf-)/;

  let tempDir: string;

  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  beforeEach(async () => {
    tempDir = await fixtureRootTracker.make("case");
    await fs.writeFile(path.join(tempDir, "openclaw.mjs"), "export {};\n", "utf8");
  });

  afterEach(async () => {
    // Shared fixtureRoot cleaned up in afterAll.
  });

  async function createStableTagRunner(params: {
    stableTag: string;
    uiIndexPath: string;
    onDoctor?: () => Promise<void>;
    onUiBuild?: (count: number) => Promise<void>;
  }) {
    const calls: string[] = [];
    let uiBuildCount = 0;
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorKey = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { code: 0, stderr: "", stdout: tempDir };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { code: 0, stderr: "", stdout: "abc123" };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { code: 0, stderr: "", stdout: `${params.stableTag}\n` };
      }
      if (key === `git -C ${tempDir} checkout --detach ${params.stableTag}`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === "pnpm install") {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === "pnpm build") {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === "pnpm ui:build") {
        uiBuildCount += 1;
        await params.onUiBuild?.(uiBuildCount);
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === doctorKey) {
        await params.onDoctor?.();
        return { code: 0, stderr: "", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    return {
      calls,
      doctorKey,
      getUiBuildCount: () => uiBuildCount,
      runCommand,
    };
  }

  async function setupGitCheckout(options?: { packageManager?: string }) {
    await fs.mkdir(path.join(tempDir, ".git"));
    const pkg: Record<string, string> = { name: "openclaw", version: "1.0.0" };
    if (options?.packageManager) {
      pkg.packageManager = options.packageManager;
    }
    await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify(pkg), "utf8");
  }

  async function setupUiIndex() {
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf8");
    return uiIndexPath;
  }

  async function setupGitPackageManagerFixture(packageManager = "pnpm@8.0.0") {
    await setupGitCheckout({ packageManager });
    return await setupUiIndex();
  }

  function buildStableTagResponses(
    stableTag: string,
    options?: { additionalTags?: string[] },
  ): Record<string, CommandResponse> {
    const tagOutput = [stableTag, ...(options?.additionalTags ?? [])].join("\n");
    return {
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: { stdout: "" },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} tag --list v* --sort=-v:refname`]: { stdout: `${tagOutput}\n` },
      [`git -C ${tempDir} checkout --detach ${stableTag}`]: { stdout: "" },
    };
  }

  function buildGitWorktreeProbeResponses(options?: { status?: string; branch?: string }) {
    return {
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
      [`git -C ${tempDir} rev-parse HEAD`]: { stdout: "abc123" },
      [`git -C ${tempDir} rev-parse --abbrev-ref HEAD`]: { stdout: options?.branch ?? "main" },
      [`git -C ${tempDir} status --porcelain -- :!dist/control-ui/`]: {
        stdout: options?.status ?? "",
      },
    } satisfies Record<string, CommandResponse>;
  }

  function createGitInstallRunner(params: {
    stableTag: string;
    installCommand: string;
    buildCommand: string;
    uiBuildCommand: string;
    doctorCommand: string;
    onCommand?: (
      key: string,
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => Promise<CommandResponse | undefined> | CommandResponse | undefined;
  }) {
    const calls: string[] = [];
    const responses = {
      ...buildStableTagResponses(params.stableTag),
      [params.installCommand]: { stdout: "" },
      [params.buildCommand]: { stdout: "" },
      [params.uiBuildCommand]: { stdout: "" },
      [params.doctorCommand]: { stdout: "" },
    } satisfies Record<string, CommandResponse>;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);
      const override = await params.onCommand?.(key, options);
      if (override) {
        return toCommandResult(override);
      }
      return toCommandResult(responses[key]);
    };

    return { calls, runCommand };
  }

  async function removeControlUiAssets() {
    await fs.rm(path.join(tempDir, "dist", "control-ui"), { force: true, recursive: true });
  }

  async function runWithCommand(
    runCommand: (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => Promise<CommandResult>,
    options?: { channel?: "stable" | "beta" | "dev"; tag?: string; cwd?: string },
  ) {
    return runGatewayUpdate({
      cwd: options?.cwd ?? tempDir,
      runCommand: async (argv, runOptions) => runCommand(argv, runOptions),
      timeoutMs: 5000,
      ...(options?.channel ? { channel: options.channel } : {}),
      ...(options?.tag ? { tag: options.tag } : {}),
    });
  }

  async function runWithRunner(
    runner: (argv: string[]) => Promise<CommandResult>,
    options?: { channel?: "stable" | "beta" | "dev"; tag?: string; cwd?: string },
  ) {
    return runWithCommand(runner, options);
  }

  async function seedGlobalPackageRoot(pkgRoot: string, version = "1.0.0") {
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    );
    await writeBundledRuntimeSidecars(pkgRoot);
  }

  async function writeGlobalPackageVersion(pkgRoot: string, version = "2.0.0") {
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    );
    await writeBundledRuntimeSidecars(pkgRoot);
  }

  async function writeBundledRuntimeSidecars(pkgRoot: string) {
    for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
      const absolutePath = path.join(pkgRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "export {};\n", "utf8");
    }
  }

  async function createGlobalPackageFixture(rootDir: string) {
    const nodeModules = path.join(rootDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);
    return { nodeModules, pkgRoot };
  }

  function createGlobalNpmUpdateRunner(params: {
    pkgRoot: string;
    nodeModules: string;
    onBaseInstall?: () => Promise<CommandResult>;
    onOmitOptionalInstall?: () => Promise<CommandResult>;
  }) {
    const baseInstallKey = "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error";
    const omitOptionalInstallKey =
      "npm i -g openclaw@latest --omit=optional --no-fund --no-audit --loglevel=error";

    return async (argv: string[]): Promise<CommandResult> => {
      const key = argv.join(" ");
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        return { code: 128, stderr: "not a git repository", stdout: "" };
      }
      if (key === "npm root -g") {
        return { code: 0, stderr: "", stdout: params.nodeModules };
      }
      if (key === "pnpm root -g") {
        return { code: 1, stderr: "", stdout: "" };
      }
      if (key === baseInstallKey) {
        return (await params.onBaseInstall?.()) ?? { code: 0, stderr: "", stdout: "ok" };
      }
      if (key === omitOptionalInstallKey) {
        return (
          (await params.onOmitOptionalInstall?.()) ?? { code: 1, stderr: "not found", stdout: "" }
        );
      }
      return { code: 0, stderr: "", stdout: "" };
    };
  }

  it("skips git update when worktree is dirty", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses({ status: " M README.md" }),
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("dirty");
    expect(calls.some((call) => call.includes("rebase"))).toBe(false);
  });

  it("aborts rebase on failure", async () => {
    await setupGitCheckout();
    const { runner, calls } = createRunner({
      ...buildGitWorktreeProbeResponses(),
      [`git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
        stdout: "origin/main",
      },
      [`git -C ${tempDir} fetch --all --prune --tags`]: { stdout: "" },
      [`git -C ${tempDir} rev-parse @{upstream}`]: { stdout: "upstream123" },
      [`git -C ${tempDir} rev-list --max-count=10 upstream123`]: { stdout: "upstream123\n" },
      [`git -C ${tempDir} rebase upstream123`]: { code: 1, stderr: "conflict" },
      [`git -C ${tempDir} rebase --abort`]: { stdout: "" },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("error");
    expect(result.reason).toBe("rebase-failed");
    expect(calls.some((call) => call.includes("rebase --abort"))).toBe(true);
  });

  it("returns error and stops early when deps install fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm install": { code: 1, stderr: "ERR_PNPM_NETWORK" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("deps-install-failed");
    expect(calls.some((call) => call === "pnpm build")).toBe(false);
    expect(calls.some((call) => call === "pnpm ui:build")).toBe(false);
  });

  it("returns error and stops early when build fails", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const stableTag = "v1.0.1-1";
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm build": { code: 1, stderr: "tsc: error TS2345" },
      "pnpm install": { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("build-failed");
    expect(calls.some((call) => call === "pnpm install")).toBe(true);
    expect(calls.some((call) => call === "pnpm ui:build")).toBe(false);
  });

  it("uses stable tag when beta tag is older than release", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await setupUiIndex();
    const stableTag = "v1.0.1-1";
    const betaTag = "v1.0.0-beta.2";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const { runner, calls } = createRunner({
      ...buildStableTagResponses(stableTag, { additionalTags: [betaTag] }),
      "pnpm install": { stdout: "" },
      "pnpm build": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
      [`${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`]: {
        stdout: "",
      },
    });

    const result = await runWithRunner(runner, { channel: "beta" });

    expect(result.status).toBe("ok");
    expect(calls).toContain(`git -C ${tempDir} checkout --detach ${stableTag}`);
    expect(calls).not.toContain(`git -C ${tempDir} checkout --detach ${betaTag}`);
  });

  it("bootstraps pnpm via npm when pnpm and corepack are unavailable", async () => {
    await setupGitPackageManagerFixture();
    const stableTag = "v1.0.1-1";
    const { calls, runCommand } = createGitInstallRunner({
      buildCommand: "pnpm build",
      doctorCommand: `${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`,
      installCommand: "pnpm install",
      onCommand: (key, options) => {
        if (key === "pnpm --version") {
          const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
          if (envPath.includes("openclaw-update-pnpm-")) {
            return { stdout: "10.0.0" };
          }
          throw new Error("spawn pnpm ENOENT");
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0" };
        }
        if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
          return { stdout: "added 1 package" };
        }
        return undefined;
      },
      stableTag,
      uiBuildCommand: "pnpm ui:build",
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(calls).toContain("pnpm --version");
    expect(calls.some((call) => call.startsWith("npm install --prefix "))).toBe(true);
    expect(calls).toContain("npm --version");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("npm install --no-package-lock --legacy-peer-deps");
  });

  it("bootstraps pnpm via corepack when pnpm is missing", async () => {
    await setupGitPackageManagerFixture();
    const stableTag = "v1.0.1-1";
    let pnpmVersionChecks = 0;
    const { calls, runCommand } = createGitInstallRunner({
      buildCommand: "pnpm build",
      doctorCommand: `${process.execPath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive`,
      installCommand: "pnpm install",
      onCommand: (key) => {
        if (key === "pnpm --version") {
          pnpmVersionChecks += 1;
          if (pnpmVersionChecks === 1) {
            throw new Error("spawn pnpm ENOENT");
          }
          return { stdout: "10.0.0" };
        }
        if (key === "corepack --version") {
          return { stdout: "0.30.0" };
        }
        if (key === "corepack enable") {
          return { stdout: "" };
        }
        return undefined;
      },
      stableTag,
      uiBuildCommand: "pnpm ui:build",
    });

    const result = await runGatewayUpdate({
      channel: "stable",
      cwd: tempDir,
      runCommand: async (argv, _options) => runCommand(argv),
      timeoutMs: 5000,
    });

    expect(result.status).toBe("ok");
    expect(calls).toContain("corepack enable");
    expect(calls).toContain("pnpm install");
    expect(calls).not.toContain("npm install --no-package-lock --legacy-peer-deps");
  });

  it("uses npm-bootstrapped pnpm for dev preflight when pnpm and corepack are missing", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const pnpmEnvPaths: string[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;

    const runCommand = async (
      argv: string[],
      options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { code: 0, stderr: "", stdout: tempDir };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { code: 0, stderr: "", stdout: "abc123" };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { code: 0, stderr: "", stdout: "main" };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { code: 0, stderr: "", stdout: "origin/main" };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { code: 0, stderr: "", stdout: upstreamSha };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { code: 0, stderr: "", stdout: `${upstreamSha}\n` };
      }
      if (key === "pnpm --version") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        if (envPath.includes("openclaw-update-pnpm-")) {
          pnpmEnvPaths.push(envPath);
          return { code: 0, stderr: "", stdout: "10.0.0" };
        }
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { code: 0, stderr: "", stdout: "10.0.0" };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { code: 0, stderr: "", stdout: "added 1 package" };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
        key.endsWith(` ${upstreamSha}`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { code: 0, stderr: "", stdout: `HEAD is now at ${upstreamSha}` };
      }
      if (
        key.startsWith("git -C /tmp/") &&
        preflightPrefixPattern.test(key) &&
        key.includes(" checkout --detach ") &&
        key.endsWith(upstreamSha)
      ) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        pnpmEnvPaths.push(envPath);
        return { code: 0, stderr: "", stdout: "" };
      }
      if (
        key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
        preflightPrefixPattern.test(key)
      ) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} worktree prune`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === "pnpm ui:build") {
        const envPath = options?.env?.PATH ?? options?.env?.Path ?? "";
        pnpmEnvPaths.push(envPath);
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === doctorCommand) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { code: 0, stderr: "", stdout: upstreamSha };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("ok");
    expect(calls.some((call) => call.startsWith("npm install --prefix "))).toBe(true);
    expect(calls).toContain("pnpm install");
    expect(calls).toContain("pnpm build");
    expect(calls).toContain("pnpm lint");
    expect(calls).toContain("pnpm ui:build");
    expect(pnpmEnvPaths.some((value) => value.includes("openclaw-update-pnpm-"))).toBe(true);
  });

  it("retries windows pnpm git installs with --ignore-scripts for dev updates", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    let preflightInstallAttempts = 0;
    let preflightIgnoreScriptsAttempts = 0;
    let finalInstallAttempts = 0;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const runCommand = async (
        argv: string[],
        options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
      ) => {
        const key = argv.join(" ");
        calls.push(key);

        if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
          return { code: 0, stderr: "", stdout: tempDir };
        }
        if (key === `git -C ${tempDir} rev-parse HEAD`) {
          return { code: 0, stderr: "", stdout: "abc123" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
          return { code: 0, stderr: "", stdout: "main" };
        }
        if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
          return { code: 0, stderr: "", stdout: "origin/main" };
        }
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
          return { code: 0, stderr: "", stdout: upstreamSha };
        }
        if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: `${upstreamSha}\n` };
        }
        if (key === "pnpm --version") {
          return { code: 0, stderr: "", stdout: "10.0.0" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { code: 0, stderr: "", stdout: `HEAD is now at ${upstreamSha}` };
        }
        if (
          key.startsWith("git -C /tmp/") &&
          preflightPrefixPattern.test(key) &&
          key.includes(" checkout --detach ") &&
          key.endsWith(upstreamSha)
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === "pnpm install") {
          if (options?.cwd && /(?:openclaw-update-preflight-|ocu-pf-)/.test(options.cwd)) {
            preflightInstallAttempts += 1;
            return preflightInstallAttempts === 1
              ? { code: 1, stderr: "sharp: Please add node-gyp to your dependencies", stdout: "" }
              : { code: 0, stderr: "", stdout: "" };
          }
          if (options?.cwd === tempDir) {
            finalInstallAttempts += 1;
            return finalInstallAttempts === 1
              ? { code: 1, stderr: "sharp: Please add node-gyp to your dependencies", stdout: "" }
              : { code: 0, stderr: "", stdout: "" };
          }
        }
        if (key === "pnpm install --ignore-scripts") {
          if (options?.cwd && /(?:openclaw-update-preflight-|ocu-pf-)/.test(options.cwd)) {
            preflightIgnoreScriptsAttempts += 1;
          }
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === "pnpm build" || key === "pnpm lint" || key === "pnpm ui:build") {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} worktree prune`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === doctorCommand) {
          return { code: 0, stderr: "", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: "" };
      };

      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      expect(preflightInstallAttempts).toBe(0);
      expect(preflightIgnoreScriptsAttempts).toBe(1);
      expect(finalInstallAttempts).toBe(1);
      expect(result.steps.map((step) => step.name)).toContain(
        "preflight deps install (ignore scripts) (upstream)",
      );
      expect(result.steps.map((step) => step.name)).toContain("deps install (ignore scripts)");
      expect(calls).toContain("pnpm install --ignore-scripts");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not fail a good windows dev preflight only because worktree cleanup hit long paths", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const upstreamSha = "upstream123";
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const runCommand = async (
        argv: string[],
        _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
      ) => {
        const key = argv.join(" ");
        calls.push(key);

        if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
          return { code: 0, stderr: "", stdout: tempDir };
        }
        if (key === `git -C ${tempDir} rev-parse HEAD`) {
          return { code: 0, stderr: "", stdout: "abc123" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
          return { code: 0, stderr: "", stdout: "main" };
        }
        if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
          return { code: 0, stderr: "", stdout: "origin/main" };
        }
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
          return { code: 0, stderr: "", stdout: upstreamSha };
        }
        if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: `${upstreamSha}\n` };
        }
        if (key === "pnpm --version") {
          return { code: 0, stderr: "", stdout: "10.0.0" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { code: 0, stderr: "", stdout: `HEAD is now at ${upstreamSha}` };
        }
        if (
          key.startsWith("git -C /tmp/") &&
          preflightPrefixPattern.test(key) &&
          key.includes(" checkout --detach ") &&
          key.endsWith(upstreamSha)
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === "pnpm install" || key === "pnpm build" || key === "pnpm lint") {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force `) &&
          preflightPrefixPattern.test(key)
        ) {
          return {
            code: 255,
            stderr: "error: failed to delete worktree: Filename too long",
            stdout: "",
          };
        }
        if (key === `git -C ${tempDir} worktree prune`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === doctorCommand) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === "pnpm ui:build") {
          return { code: 0, stderr: "", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: "" };
      };

      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      const cleanupStep = result.steps.find((step) => step.name === "preflight cleanup");
      expect(cleanupStep?.exitCode).toBe(0);
      expect(cleanupStep?.stderrTail ?? "").toContain(
        "windows fallback cleanup removed preflight tree",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("adds heap headroom to windows pnpm build steps during dev updates", async () => {
    await setupGitPackageManagerFixture();
    const upstreamSha = "upstream123";
    const buildNodeOptions: string[] = [];
    const doctorNodePath = await resolveStableNodePath(process.execPath);
    const doctorCommand = `${doctorNodePath} ${path.join(tempDir, "openclaw.mjs")} doctor --non-interactive --fix`;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const runCommand = async (
        argv: string[],
        options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
      ) => {
        const key = argv.join(" ");

        if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
          return { code: 0, stderr: "", stdout: tempDir };
        }
        if (key === `git -C ${tempDir} rev-parse HEAD`) {
          return { code: 0, stderr: "", stdout: "abc123" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
          return { code: 0, stderr: "", stdout: "main" };
        }
        if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
          return { code: 0, stderr: "", stdout: "origin/main" };
        }
        if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
          return { code: 0, stderr: "", stdout: upstreamSha };
        }
        if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: `${upstreamSha}\n` };
        }
        if (key === "pnpm --version") {
          return { code: 0, stderr: "", stdout: "10.0.0" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree add --detach /tmp/`) &&
          key.endsWith(` ${upstreamSha}`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { code: 0, stderr: "", stdout: `HEAD is now at ${upstreamSha}` };
        }
        if (
          key.startsWith("git -C /tmp/") &&
          preflightPrefixPattern.test(key) &&
          key.includes(" checkout --detach ") &&
          key.endsWith(upstreamSha)
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (
          key === "pnpm install --ignore-scripts" ||
          key === "pnpm lint" ||
          key === "pnpm ui:build"
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === "pnpm build") {
          buildNodeOptions.push(options?.env?.NODE_OPTIONS ?? "");
          return { code: 0, stderr: "", stdout: "" };
        }
        if (
          key.startsWith(`git -C ${tempDir} worktree remove --force /tmp/`) &&
          preflightPrefixPattern.test(key)
        ) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} worktree prune`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === `git -C ${tempDir} rebase ${upstreamSha}`) {
          return { code: 0, stderr: "", stdout: "" };
        }
        if (key === doctorCommand) {
          return { code: 0, stderr: "", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: "" };
      };

      const result = await runWithCommand(runCommand, { channel: "dev" });

      expect(result.status).toBe("ok");
      expect(buildNodeOptions).toHaveLength(2);
      expect(buildNodeOptions).toEqual(["--max-old-space-size=4096", "--max-old-space-size=4096"]);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not fall back to npm scripts when a pnpm repo cannot bootstrap pnpm", async () => {
    await setupGitPackageManagerFixture();
    const calls: string[] = [];
    const upstreamSha = "upstream123";

    const runCommand = async (
      argv: string[],
      _options?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
    ) => {
      const key = argv.join(" ");
      calls.push(key);

      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { code: 0, stderr: "", stdout: tempDir };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { code: 0, stderr: "", stdout: "abc123" };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref HEAD`) {
        return { code: 0, stderr: "", stdout: "main" };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`) {
        return { code: 0, stderr: "", stdout: "origin/main" };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { code: 0, stderr: "", stdout: "" };
      }
      if (key === `git -C ${tempDir} rev-parse @{upstream}`) {
        return { code: 0, stderr: "", stdout: upstreamSha };
      }
      if (key === `git -C ${tempDir} rev-list --max-count=10 ${upstreamSha}`) {
        return { code: 0, stderr: "", stdout: `${upstreamSha}\n` };
      }
      if (key === "pnpm --version") {
        throw new Error("spawn pnpm ENOENT");
      }
      if (key === "corepack --version") {
        throw new Error("spawn corepack ENOENT");
      }
      if (key === "npm --version") {
        return { code: 0, stderr: "", stdout: "10.0.0" };
      }
      if (key.startsWith("npm install --prefix ") && key.endsWith(" pnpm@10")) {
        return { code: 1, stderr: "network exploded", stdout: "" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    const result = await runWithCommand(runCommand, { channel: "dev" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("pnpm-npm-bootstrap-failed");
    expect(calls.some((call) => call === "npm run build")).toBe(false);
    expect(calls.some((call) => call === "npm run lint")).toBe(false);
    expect(calls.some((call) => preflightPrefixPattern.test(call))).toBe(false);
  });

  it("skips update when no git root", async () => {
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "openclaw", packageManager: "pnpm@8.0.0" }),
      "utf8",
    );
    await fs.writeFile(path.join(tempDir, "pnpm-lock.yaml"), "", "utf8");
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { code: 1 },
      "npm root -g": { code: 1 },
      "pnpm root -g": { code: 1 },
    });

    const result = await runWithRunner(runner);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("not-git-install");
    expect(calls.some((call) => call.startsWith("pnpm add -g"))).toBe(false);
    expect(calls.some((call) => call.startsWith("npm i -g"))).toBe(false);
  });

  async function runNpmGlobalUpdateCase(params: {
    expectedInstallCommand: string;
    channel?: "stable" | "beta";
    tag?: string;
  }): Promise<{ calls: string[]; result: Awaited<ReturnType<typeof runGatewayUpdate>> }> {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    const { calls, runCommand } = createGlobalInstallHarness({
      installCommand: params.expectedInstallCommand,
      npmRootOutput: nodeModules,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          "utf8",
        );
      },
      pkgRoot,
    });

    const result = await runWithCommand(runCommand, {
      channel: params.channel,
      cwd: pkgRoot,
      tag: params.tag,
    });

    return { calls, result };
  }

  const createGlobalInstallHarness = (params: {
    pkgRoot: string;
    npmRootOutput?: string;
    installCommand: string;
    gitRootMode?: "not-git" | "missing";
    onInstall?: (options?: { env?: NodeJS.ProcessEnv }) => Promise<void>;
  }) => {
    const calls: string[] = [];
    const runCommand = async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${params.pkgRoot} rev-parse --show-toplevel`) {
        if (params.gitRootMode === "missing") {
          throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
        }
        return { code: 128, stderr: "not a git repository", stdout: "" };
      }
      if (key === "npm root -g") {
        if (params.npmRootOutput) {
          return { code: 0, stderr: "", stdout: params.npmRootOutput };
        }
        return { code: 1, stderr: "", stdout: "" };
      }
      if (key === "pnpm root -g") {
        return { code: 1, stderr: "", stdout: "" };
      }
      if (key === params.installCommand) {
        await params.onInstall?.(options);
        return { code: 0, stderr: "", stdout: "ok" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };
    return { calls, runCommand };
  };

  it.each([
    {
      expectedInstallCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      title: "updates global npm installs when detected",
    },
    {
      channel: "beta" as const,
      expectedInstallCommand: "npm i -g openclaw@beta --no-fund --no-audit --loglevel=error",
      title: "uses update channel for global npm installs when tag is omitted",
    },
    {
      expectedInstallCommand: "npm i -g openclaw@beta --no-fund --no-audit --loglevel=error",
      tag: "beta",
      title: "updates global npm installs with tag override",
    },
  ])("$title", async ({ expectedInstallCommand, channel, tag }) => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      channel,
      expectedInstallCommand,
      tag,
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.before?.version).toBe("1.0.0");
    expect(result.after?.version).toBe("2.0.0");
    expect(calls.some((call) => call === expectedInstallCommand)).toBe(true);
  });

  it("updates global npm installs from the GitHub main package spec", async () => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand:
        "npm i -g github:openclaw/openclaw#main --no-fund --no-audit --loglevel=error",
      tag: "main",
    });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(calls).toContain(
      "npm i -g github:openclaw/openclaw#main --no-fund --no-audit --loglevel=error",
    );
  });

  it("falls back to global npm update when git is missing from PATH", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const { calls, runCommand } = createGlobalInstallHarness({
      gitRootMode: "missing",
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      npmRootOutput: nodeModules,
      onInstall: async () => writeGlobalPackageVersion(pkgRoot),
      pkgRoot,
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(calls).toContain("npm i -g openclaw@latest --no-fund --no-audit --loglevel=error");
  });

  it("cleans stale npm rename dirs before global update", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    const staleDir = path.join(nodeModules, ".openclaw-stale");
    await fs.mkdir(staleDir, { recursive: true });
    await seedGlobalPackageRoot(pkgRoot);

    let stalePresentAtInstall = true;
    const runCommand = createGlobalNpmUpdateRunner({
      nodeModules,
      onBaseInstall: async () => {
        stalePresentAtInstall = await pathExists(staleDir);
        return { code: 0, stderr: "", stdout: "ok" };
      },
      pkgRoot,
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("ok");
    expect(stalePresentAtInstall).toBe(false);
    expect(await pathExists(staleDir)).toBe(false);
  });

  it("retries global npm update with --omit=optional when initial install fails", async () => {
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    await seedGlobalPackageRoot(pkgRoot);

    let firstAttempt = true;
    const runCommand = createGlobalNpmUpdateRunner({
      nodeModules,
      onBaseInstall: async () => {
        firstAttempt = false;
        return { code: 1, stderr: "node-gyp failed", stdout: "" };
      },
      onOmitOptionalInstall: async () => {
        await writeGlobalPackageVersion(pkgRoot);
        return { code: 0, stderr: "", stdout: "ok" };
      },
      pkgRoot,
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(firstAttempt).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.mode).toBe("npm");
    expect(result.steps.map((s) => s.name)).toEqual([
      "global update",
      "global update (omit optional)",
    ]);
  });

  it("fails global npm update when the installed version misses the requested correction", async () => {
    const { calls, result } = await runNpmGlobalUpdateCase({
      expectedInstallCommand: "npm i -g openclaw@2026.3.23-2 --no-fund --no-audit --loglevel=error",
      tag: "2026.3.23-2",
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global install verify");
    expect(result.after?.version).toBe("2.0.0");
    expect(result.steps.at(-1)?.stderrTail).toContain(
      "expected installed version 2026.3.23-2, found 2.0.0",
    );
    expect(calls).toContain("npm i -g openclaw@2026.3.23-2 --no-fund --no-audit --loglevel=error");
  });

  it("fails global npm update when bundled runtime sidecars are missing after install", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand = "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error";
    const { runCommand } = createGlobalInstallHarness({
      installCommand: expectedInstallCommand,
      npmRootOutput: nodeModules,
      onInstall: async () => {
        await fs.writeFile(
          path.join(pkgRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0" }),
          "utf8",
        );
        await fs.rm(path.join(pkgRoot, "dist"), { force: true, recursive: true });
      },
      pkgRoot,
    });

    const result = await runWithCommand(runCommand, { cwd: pkgRoot });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("global install verify");
    expect(result.steps.at(-1)?.stderrTail).toContain(
      `missing bundled runtime sidecar ${WHATSAPP_LIGHT_RUNTIME_API}`,
    );
  });

  it("prepends portable Git PATH for global Windows npm updates", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const localAppData = path.join(tempDir, "local-app-data");
    const portableGitMingw = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "mingw64",
      "bin",
    );
    const portableGitUsr = path.join(
      localAppData,
      "OpenClaw",
      "deps",
      "portable-git",
      "usr",
      "bin",
    );
    await fs.mkdir(portableGitMingw, { recursive: true });
    await fs.mkdir(portableGitUsr, { recursive: true });

    let installEnv: NodeJS.ProcessEnv | undefined;
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const { runCommand } = createGlobalInstallHarness({
      installCommand: "npm i -g openclaw@latest --no-fund --no-audit --loglevel=error",
      npmRootOutput: nodeModules,
      onInstall: async (options) => {
        installEnv = options?.env;
        await writeGlobalPackageVersion(pkgRoot);
      },
      pkgRoot,
    });

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      const result = await runWithCommand(runCommand, { cwd: pkgRoot });
      expect(result.status).toBe("ok");
    });

    platformSpy.mockRestore();

    const mergedPath = installEnv?.Path ?? installEnv?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(installEnv?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
    expect(installEnv?.NODE_LLAMA_CPP_SKIP_DOWNLOAD).toBe("1");
  });

  it("uses OPENCLAW_UPDATE_PACKAGE_SPEC for global package updates", async () => {
    const { nodeModules, pkgRoot } = await createGlobalPackageFixture(tempDir);
    const expectedInstallCommand =
      "npm i -g http://10.211.55.2:8138/openclaw-next.tgz --no-fund --no-audit --loglevel=error";
    const { calls, runCommand } = createGlobalInstallHarness({
      installCommand: expectedInstallCommand,
      npmRootOutput: nodeModules,
      onInstall: async () => writeGlobalPackageVersion(pkgRoot),
      pkgRoot,
    });

    await withEnvAsync(
      { OPENCLAW_UPDATE_PACKAGE_SPEC: "http://10.211.55.2:8138/openclaw-next.tgz" },
      async () => {
        const result = await runWithCommand(runCommand, { cwd: pkgRoot });
        expect(result.status).toBe("ok");
      },
    );

    expect(calls).toContain(expectedInstallCommand);
  });

  it("updates global bun installs when detected", async () => {
    const bunInstall = path.join(tempDir, "bun-install");
    await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
      const { pkgRoot } = await createGlobalPackageFixture(
        path.join(bunInstall, "install", "global"),
      );

      const { calls, runCommand } = createGlobalInstallHarness({
        installCommand: "bun add -g openclaw@latest",
        onInstall: async () => {
          await writeGlobalPackageVersion(pkgRoot);
        },
        pkgRoot,
      });

      const result = await runWithCommand(runCommand, { cwd: pkgRoot });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("bun");
      expect(result.before?.version).toBe("1.0.0");
      expect(result.after?.version).toBe("2.0.0");
      expect(calls.some((call) => call === "bun add -g openclaw@latest")).toBe(true);
    });
  });

  it("rejects git roots that are not a openclaw checkout", async () => {
    await fs.mkdir(path.join(tempDir, ".git"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    const { runner, calls } = createRunner({
      [`git -C ${tempDir} rev-parse --show-toplevel`]: { stdout: tempDir },
    });

    const result = await runWithRunner(runner);

    cwdSpy.mockRestore();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("not-openclaw-root");
    expect(calls.some((call) => call.includes("status --porcelain"))).toBe(false);
  });

  it("fails with a clear reason when openclaw.mjs is missing", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    await fs.rm(path.join(tempDir, "openclaw.mjs"), { force: true });

    const stableTag = "v1.0.1-1";
    const { runner } = createRunner({
      ...buildStableTagResponses(stableTag),
      "pnpm build": { stdout: "" },
      "pnpm install": { stdout: "" },
      "pnpm ui:build": { stdout: "" },
    });

    const result = await runWithRunner(runner, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("doctor-entry-missing");
    expect(result.steps.at(-1)?.name).toBe("openclaw doctor entry");
  });

  it("repairs UI assets when doctor run removes control-ui files", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand, calls, doctorKey, getUiBuildCount } = await createStableTagRunner({
      onDoctor: removeControlUiAssets,
      onUiBuild: async (count) => {
        await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
        await fs.writeFile(uiIndexPath, `<html>${count}</html>`, "utf8");
      },
      stableTag,
      uiIndexPath,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("ok");
    expect(getUiBuildCount()).toBe(2);
    expect(await pathExists(uiIndexPath)).toBe(true);
    expect(calls).toContain(doctorKey);
  });

  it("fails when UI assets are still missing after post-doctor repair", async () => {
    await setupGitCheckout({ packageManager: "pnpm@8.0.0" });
    const uiIndexPath = await setupUiIndex();

    const stableTag = "v1.0.1-1";
    const { runCommand } = await createStableTagRunner({
      onDoctor: removeControlUiAssets,
      onUiBuild: async (count) => {
        if (count === 1) {
          await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
          await fs.writeFile(uiIndexPath, "<html>built</html>", "utf8");
        }
      },
      stableTag,
      uiIndexPath,
    });

    const result = await runWithCommand(runCommand, { channel: "stable" });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("ui-assets-missing");
  });
});
