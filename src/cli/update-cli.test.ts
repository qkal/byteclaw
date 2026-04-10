import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_BUNDLED_RUNTIME_SIDECAR_PATHS } from "../../test/helpers/bundled-runtime-sidecars.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";
import { isOwningNpmCommand } from "./update-cli.test-helpers.js";

const confirm = vi.fn();
const select = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const prepareRestartScript = vi.fn();
const runRestartScript = vi.fn();
const mockedRunDaemonInstall = vi.fn();
const serviceReadRuntime = vi.fn();
const inspectPortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const pathExists = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updateNpmInstalledPlugins = vi.fn();
const nodeVersionSatisfiesEngine = vi.fn();
const { defaultRuntime: runtimeCapture, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("@clack/prompts", () => ({
  confirm,
  isCancel,
  select,
  spinner,
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
  resolveOpenClawPackageRootSync: vi.fn(() => process.cwd()),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18_789),
}));

vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn(),
  compareSemverStrings: vi.fn((left: string | null, right: string | null) => {
    const parse = (value: string | null) => {
      if (!value) {
        return null;
      }
      const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return null;
      }
      return [
        Number.parseInt(match[1] ?? "0", 10),
        Number.parseInt(match[2] ?? "0", 10),
        Number.parseInt(match[3] ?? "0", 10),
      ] as const;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) {
      return null;
    }
    for (let index = 0; index < a.length; index += 1) {
      const diff = a[index] - b[index];
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }),
  fetchNpmPackageTargetStatus: vi.fn(),
  fetchNpmTagVersion: vi.fn(),
  resolveNpmChannelTag: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  nodeVersionSatisfiesEngine,
  parseSemver: (version: string | null) => {
    if (!version) {
      return null;
    }
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      return null;
    }
    return {
      major: Number.parseInt(match[1] ?? "0", 10),
      minor: Number.parseInt(match[2] ?? "0", 10),
      patch: Number.parseInt(match[3] ?? "0", 10),
    };
  },
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      output: [],
      pid: 0,
      signal: null,
      status: 0,
      stderr: "",
      stdout: "",
    })),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    displayString: (input: string) => input,
    isRecord: (value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    pathExists: (...args: unknown[]) => pathExists(...args),
    resolveConfigDir: () => "/tmp/openclaw-config",
  };
});

vi.mock("../plugins/update.js", () => ({
  syncPluginsForUpdateChannel: (...args: unknown[]) => syncPluginsForUpdateChannel(...args),
  updateNpmInstalledPlugins: (...args: unknown[]) => updateNpmInstalledPlugins(...args),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: (...args: unknown[]) => serviceLoaded(...args),
    readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
  })),
}));

vi.mock("../infra/ports.js", () => ({
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeCapture,
}));

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
const { readConfigFileSnapshot, replaceConfigFile } = await import("../config/config.js");
const { checkUpdateStatus, fetchNpmPackageTargetStatus, fetchNpmTagVersion, resolveNpmChannelTag } =
  await import("../infra/update-check.js");
const { runCommandWithTimeout } = await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime } = await import("../runtime.js");
const { updateCommand, updateStatusCommand, updateWizardCommand } = await import("./update-cli.js");
const updateCliShared = await import("./update-cli/shared.js");
const { resolveGitInstallDir } = updateCliShared;

interface UpdateCliScenario {
  name: string;
  run: () => Promise<void>;
  assert: () => void;
}

describe("update-cli", () => {
  const fixtureRoot = "/tmp/openclaw-update-tests";
  let fixtureCount = 0;

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Tests only need a stable path; the directory does not have to exist because all I/O is mocked.
    return dir;
  };

  const baseConfig = {} as OpenClawConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    config: baseConfig,
    exists: true,
    issues: [],
    legacyIssues: [],
    parsed: {},
    path: "/tmp/openclaw-config.json",
    raw: "{}",
    resolved: baseConfig,
    runtimeConfig: baseConfig,
    sourceConfig: baseConfig,
    valid: true,
    warnings: [],
  };

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      deps: {
        lockfilePath: null,
        manager: "npm",
        markerPath: null,
        status: "ok",
      },
      installKind: "package",
      packageManager: "npm",
      root,
    });
  };

  const expectUpdateCallChannel = (channel: string) => {
    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe(channel);
    return call;
  };

  const expectPackageInstallSpec = (spec: string) => {
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["npm", "i", "-g", spec, "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
  };

  const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult =>
    ({
      durationMs: 100,
      mode: "git",
      status: "ok",
      steps: [],
      ...overrides,
    }) as UpdateRunResult;

  const runUpdateCliScenario = async (testCase: UpdateCliScenario) => {
    vi.clearAllMocks();
    await testCase.run();
    testCase.assert();
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    if (params.daemonInstall === "fail") {
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));
    } else {
      vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runDaemonRestart).toHaveBeenCalled();
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = createCaseDir("openclaw-update");
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");

    mockPackageInstallStatus(tempDir);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.0.1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      durationMs: 100,
      mode: "npm",
      status: "ok",
      steps: [],
    });
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: () => Promise<UpdateRunResult>;
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const entryPath = path.join(root, "dist", "entry.js");
    pathExists.mockImplementation(async (candidate: string) => candidate === entryPath);
    if (params?.gatewayUpdateImpl) {
      vi.mocked(runGatewayUpdate).mockImplementation(params.gatewayUpdateImpl);
    } else {
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        durationMs: 100,
        mode: "npm",
        root,
        status: "ok",
        steps: [],
      });
    }
    serviceLoaded.mockResolvedValue(true);
    return { entryPath, root };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    vi.mocked(defaultRuntime.exit).mockImplementation(() => {});
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      nodeEngine: ">=22.14.0",
      target: "latest",
      version: "9999.0.0",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    nodeVersionSatisfiesEngine.mockReturnValue(true);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      deps: {
        lockfilePath: "/test/path/pnpm-lock.yaml",
        manager: "pnpm",
        markerPath: "/test/path/node_modules",
        status: "ok",
      },
      git: {
        ahead: 0,
        behind: 0,
        branch: "main",
        dirty: false,
        fetchOk: true,
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        upstream: "origin/main",
      },
      installKind: "git",
      packageManager: "pnpm",
      registry: {
        latestVersion: "1.2.3",
      },
      root: "/test/path",
    });
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "",
      termination: "exit",
    });
    vi.spyOn(updateCliShared, "readPackageName").mockImplementation(readPackageName);
    vi.spyOn(updateCliShared, "readPackageVersion").mockImplementation(readPackageVersion);
    vi.spyOn(updateCliShared, "resolveGlobalManager").mockImplementation(resolveGlobalManager);
    readPackageName.mockResolvedValue("openclaw");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceLoaded.mockResolvedValue(false);
    serviceReadRuntime.mockResolvedValue({
      pid: 4242,
      state: "running",
      status: "running",
    });
    prepareRestartScript.mockResolvedValue("/tmp/openclaw-restart-test.sh");
    runRestartScript.mockResolvedValue(undefined);
    inspectPortUsage.mockResolvedValue({
      hints: [],
      listeners: [{ command: "openclaw-gateway", pid: 4242 }],
      port: 18_789,
      status: "busy",
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    pathExists.mockResolvedValue(false);
    syncPluginsForUpdateChannel.mockResolvedValue({
      changed: false,
      config: baseConfig,
      summary: {
        errors: [],
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: baseConfig,
      outcomes: [],
    });
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  it.each([
    {
      assert: () => {
        expect(replaceConfigFile).not.toHaveBeenCalled();
        expect(runGatewayUpdate).not.toHaveBeenCalled();
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).not.toHaveBeenCalled();
        expect(runDaemonRestart).not.toHaveBeenCalled();

        const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logs.join("\n")).toContain("Update dry-run");
        expect(logs.join("\n")).toContain("No changes were applied.");
      },
      name: "preview mode",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        serviceLoaded.mockResolvedValue(true);
        await updateCommand({ channel: "beta", dryRun: true });
      },
    },
    {
      assert: () => {
        expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(false);
        expect(runGatewayUpdate).not.toHaveBeenCalled();
      },
      name: "downgrade bypass",
      run: async () => {
        await setupNonInteractiveDowngrade();
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({ dryRun: true });
      },
    },
  ] as const)("updateCommand dry-run behavior: $name", runUpdateCliScenario);

  it.each([
    {
      assert: () => {
        const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
        expect(logs.join("\n")).toContain("OpenClaw update status");
      },
      name: "table output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: false });
      },
    },
    {
      assert: () => {
        const last = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
        expect(last).toBeDefined();
        const parsed = last as Record<string, unknown>;
        const channel = parsed.channel as { value?: unknown };
        expect(channel.value).toBe("stable");
      },
      name: "json output",
      run: async () => {
        vi.mocked(defaultRuntime.log).mockClear();
        await updateStatusCommand({ json: true });
      },
    },
  ] as const)("updateStatusCommand rendering: $name", runUpdateCliScenario);

  it("parses update status --json as the subcommand option", async () => {
    const program = new Command();
    program.name("openclaw");
    program.enablePositionalOptions();
    let seenJson = false;
    const update = program.command("update").option("--json", "", false);
    update
      .command("status")
      .option("--json", "", false)
      .action((opts) => {
        seenJson = Boolean(opts.json);
      });

    await program.parseAsync(["node", "openclaw", "update", "status", "--json"]);

    expect(seenJson).toBe(true);
  });

  it.each([
    {
      expectedChannel: "dev" as const,
      expectedTag: undefined as string | undefined,
      mode: "git" as const,
      name: "defaults to dev channel for git installs when unset",
      options: {},
      prepare: async () => {},
    },
    {
      expectedChannel: undefined as "stable" | undefined,
      expectedTag: undefined as string | undefined,
      name: "defaults to stable channel for package installs when unset",
      options: { yes: true },
      prepare: async () => {
        const tempDir = createCaseDir("openclaw-update");
        mockPackageInstallStatus(tempDir);
      },
    },
    {
      expectedChannel: "beta" as const,
      expectedTag: undefined as string | undefined,
      mode: "git" as const,
      name: "uses stored beta channel when configured",
      options: {},
      prepare: async () => {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: "beta" } } as OpenClawConfig,
        });
      },
    },
    {
      expectedChannel: undefined as string | undefined,
      expectedPersistedChannel: "beta" as const,
      expectedTag: undefined as string | undefined,
      mode: "git" as const,
      name: "switches git installs to package mode for explicit beta and persists it",
      options: { channel: "beta" },
      prepare: async () => {},
    },
  ])(
    "$name",
    async ({ mode, options, prepare, expectedChannel, expectedTag, expectedPersistedChannel }) => {
      await prepare();
      if (mode) {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode }));
      }

      await updateCommand(options);

      if (expectedChannel !== undefined) {
        const call = expectUpdateCallChannel(expectedChannel);
        if (expectedTag !== undefined) {
          expect(call?.tag).toBe(expectedTag);
        }
      } else {
        expect(runGatewayUpdate).not.toHaveBeenCalled();
        expect(runCommandWithTimeout).toHaveBeenCalledWith(
          ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
          expect.any(Object),
        );
      }

      if (expectedPersistedChannel !== undefined) {
        expect(replaceConfigFile).toHaveBeenCalled();
        const writeCall = vi.mocked(replaceConfigFile).mock.calls[0]?.[0] as
          | { nextConfig?: { update?: { channel?: string } } }
          | undefined;
        expect(writeCall?.nextConfig?.update?.channel).toBe(expectedPersistedChannel);
      }
    },
  );

  it("falls back to latest when beta tag is older than release", async () => {
    const tempDir = createCaseDir("openclaw-update");

    mockPackageInstallStatus(tempDir);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as OpenClawConfig,
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "1.2.3-1",
    });
    await updateCommand({});

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
  });

  it("blocks package updates when the target requires a newer Node runtime", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      nodeEngine: ">=22.14.0",
      target: "latest",
      version: "2026.3.23-2",
    });
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await updateCommand({ yes: true });

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalledWith(
      ["npm", "i", "-g", "openclaw@latest", "--no-fund", "--no-audit", "--loglevel=error"],
      expect.any(Object),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const errors = vi.mocked(defaultRuntime.error).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain("Node ");
    expect(errors.join("\n")).toContain(
      "Bare `npm i -g openclaw` can silently install an older compatible release.",
    );
  });

  it.each([
    {
      expectedSpec: "openclaw@next",
      name: "explicit dist-tag",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ tag: "next" });
      },
    },
    {
      expectedSpec: "github:openclaw/openclaw#main",
      name: "main shorthand",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ tag: "main", yes: true });
      },
    },
    {
      expectedSpec: "github:openclaw/openclaw#main",
      name: "explicit git package spec",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await updateCommand({ tag: "github:openclaw/openclaw#main", yes: true });
      },
    },
    {
      expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
      name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
      run: async () => {
        mockPackageInstallStatus(createCaseDir("openclaw-update"));
        await withEnvAsync(
          { OPENCLAW_UPDATE_PACKAGE_SPEC: "http://10.211.55.2:8138/openclaw-next.tgz" },
          async () => {
            await updateCommand({ tag: "latest", yes: true });
          },
        );
      },
    },
  ] as const)(
    "resolves package install specs from tags and env overrides: $name",
    async ({ run, expectedSpec }) => {
      vi.clearAllMocks();
      readPackageName.mockResolvedValue("openclaw");
      readPackageVersion.mockResolvedValue("1.0.0");
      resolveGlobalManager.mockResolvedValue("npm");
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(process.cwd());
      await run();
      expectPackageInstallSpec(expectedSpec);
    },
  );

  it("fails package updates when the installed correction version does not match the requested target", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const nodeModules = path.join(tempDir, "node_modules");
    const pkgRoot = path.join(nodeModules, "openclaw");
    mockPackageInstallStatus(tempDir);
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(
      path.join(pkgRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.23" }),
      "utf8",
    );
    for (const relativePath of TEST_BUNDLED_RUNTIME_SIDECAR_PATHS) {
      const absolutePath = path.join(pkgRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "export {};\n", "utf8");
    }
    readPackageVersion.mockResolvedValue("2026.3.23");
    pathExists.mockImplementation(async (candidate: string) =>
      TEST_BUNDLED_RUNTIME_SIDECAR_PATHS.some(
        (relativePath) => candidate === path.join(pkgRoot, relativePath),
      ),
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          code: 0,
          killed: false,
          signal: null,
          stderr: "",
          stdout: nodeModules,
          termination: "exit",
        };
      }
      return {
        code: 0,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "",
        termination: "exit",
      };
    });

    await updateCommand({ tag: "2026.3.23-2", yes: true });

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFile).not.toHaveBeenCalled();
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("global install verify");
    expect(logs.join("\n")).toContain("expected installed version 2026.3.23-2, found 2026.3.23");
  });

  it("uses the owning npm binary for package updates when PATH npm points elsewhere", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const brewPrefix = createCaseDir("brew-prefix");
    const brewRoot = path.join(brewPrefix, "lib", "node_modules");
    const pkgRoot = path.join(brewRoot, "openclaw");
    const brewNpm = path.join(brewPrefix, "bin", "npm");
    const win32PrefixNpm = path.join(brewPrefix, "npm.cmd");
    const pathNpmRoot = createCaseDir("nvm-root");
    mockPackageInstallStatus(pkgRoot);
    pathExists.mockResolvedValue(false);

    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (!Array.isArray(argv)) {
        return {
          code: 0,
          killed: false,
          signal: null,
          stderr: "",
          stdout: "",
          termination: "exit",
        };
      }
      if (argv[0] === "npm" && argv[1] === "root" && argv[2] === "-g") {
        return {
          code: 0,
          killed: false,
          signal: null,
          stderr: "",
          stdout: `${pathNpmRoot}\n`,
          termination: "exit",
        };
      }
      if (isOwningNpmCommand(argv[0], brewPrefix) && argv[1] === "root" && argv[2] === "-g") {
        return {
          code: 0,
          killed: false,
          signal: null,
          stderr: "",
          stdout: `${brewRoot}\n`,
          termination: "exit",
        };
      }
      return {
        code: 0,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "",
        termination: "exit",
      };
    });

    await fs.mkdir(path.dirname(brewNpm), { recursive: true });
    await fs.writeFile(brewNpm, "", "utf8");
    await fs.writeFile(win32PrefixNpm, "", "utf8");
    await updateCommand({ yes: true });

    platformSpy.mockRestore();

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    const installCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        ([argv]) =>
          Array.isArray(argv) &&
          isOwningNpmCommand(argv[0], brewPrefix) &&
          argv[1] === "i" &&
          argv[2] === "-g" &&
          argv[3] === "openclaw@latest",
      );

    expect(installCall).toBeDefined();
    const installCommand = String(installCall?.[0][0] ?? "");
    expect(installCommand).not.toBe("npm");
    expect(path.isAbsolute(installCommand)).toBe(true);
    expect(path.normalize(installCommand)).toContain(path.normalize(brewPrefix));
    expect(path.normalize(installCommand)).toMatch(
      new RegExp(
        `${path
          .normalize(path.join(brewPrefix, path.sep))
          .replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}.*npm(?:\\.cmd)?$`,
        "i",
      ),
    );
    expect(installCall?.[1]).toEqual(
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("prepends portable Git PATH for package updates on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const tempDir = createCaseDir("openclaw-update");
    const localAppData = createCaseDir("openclaw-localappdata");
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
    mockPackageInstallStatus(tempDir);
    pathExists.mockImplementation(
      async (candidate: string) => candidate === portableGitMingw || candidate === portableGitUsr,
    );

    await withEnvAsync({ LOCALAPPDATA: localAppData }, async () => {
      await updateCommand({ yes: true });
    });

    platformSpy.mockRestore();

    const updateCall = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.find(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    const updateOptions =
      typeof updateCall?.[1] === "object" && updateCall[1] !== null ? updateCall[1] : undefined;
    const mergedPath = updateOptions?.env?.Path ?? updateOptions?.env?.PATH ?? "";
    expect(mergedPath.split(path.delimiter).slice(0, 2)).toEqual([
      portableGitMingw,
      portableGitUsr,
    ]);
    expect(updateOptions?.env?.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
    expect(updateOptions?.env?.NODE_LLAMA_CPP_SKIP_DOWNLOAD).toBe("1");
  });

  it.each([
    {
      assert: () => {
        const jsonOutput = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0];
        expect(jsonOutput).toBeDefined();
      },
      name: "outputs JSON when --json is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(defaultRuntime.writeJson).mockClear();
        await updateCommand({ json: true });
      },
    },
    {
      assert: () => {
        expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      },
      name: "exits with error on failure",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue({
          durationMs: 100,
          mode: "git",
          reason: "rebase-failed",
          status: "error",
          steps: [],
        } satisfies UpdateRunResult);
        vi.mocked(defaultRuntime.exit).mockClear();
        await updateCommand({});
      },
    },
  ] as const)("updateCommand reports outcomes: $name", runUpdateCliScenario);

  it("persists the requested channel only after a successful package update", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);

    await updateCommand({ channel: "beta", yes: true });

    const installCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) =>
          Array.isArray(call[0]) &&
          call[0][0] === "npm" &&
          call[0][1] === "i" &&
          call[0][2] === "-g",
      );
    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      baseHash: undefined,
      nextConfig: {
        update: {
          channel: "beta",
        },
      },
    });
    expect(
      vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[installCallIndex] ?? 0,
    ).toBeLessThan(
      vi.mocked(replaceConfigFile).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("does not persist the requested channel when the package update fails", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv) => {
      if (Array.isArray(argv) && argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        return {
          code: 1,
          killed: false,
          signal: null,
          stderr: "install failed",
          stdout: "",
          termination: "exit",
        };
      }
      return {
        code: 0,
        killed: false,
        signal: null,
        stderr: "",
        stdout: "",
        termination: "exit",
      };
    });

    await updateCommand({ channel: "beta", yes: true });

    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps the requested channel when plugin sync writes config after update", async () => {
    const tempDir = createCaseDir("openclaw-update");
    mockPackageInstallStatus(tempDir);
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => ({
      changed: true,
      config,
      summary: {
        errors: [],
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
      },
    }));
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) => ({
      changed: false,
      config,
      outcomes: [],
    }));

    await updateCommand({ channel: "beta", yes: true });

    const lastWrite = vi.mocked(replaceConfigFile).mock.calls.at(-1)?.[0] as
      | { nextConfig?: { update?: { channel?: string } } }
      | undefined;
    expect(lastWrite?.nextConfig?.update?.channel).toBe("beta");
  });

  it("skips plugin sync in the old process after switching from package to git", async () => {
    const tempDir = createCaseDir("openclaw-update");
    const completionCacheSpy = vi
      .spyOn(updateCliShared, "tryWriteCompletionCache")
      .mockResolvedValue(undefined);
    mockPackageInstallStatus(tempDir);
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        after: { version: "2026.4.10" },
        mode: "git",
        root: path.join(tempDir, "..", "openclaw"),
      }),
    );
    serviceLoaded.mockResolvedValue(true);
    syncPluginsForUpdateChannel.mockRejectedValue(
      new Error("Config validation failed: old host version"),
    );

    await updateCommand({ channel: "dev", yes: true });

    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(completionCacheSpy).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain(
      "Switched from a package install to a git checkout. Skipping remaining post-update work in the old CLI process; rerun follow-up commands from the new git install if needed.",
    );
  });
  it("explains why git updates cannot run with edited files", async () => {
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      durationMs: 100,
      mode: "git",
      reason: "dirty",
      status: "skipped",
      steps: [],
    } satisfies UpdateRunResult);

    await updateCommand({ channel: "dev" });

    const errors = vi.mocked(defaultRuntime.error).mock.calls.map((call) => String(call[0]));
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(errors.join("\n")).toContain("Update blocked: local files are edited in this checkout.");
    expect(logs.join("\n")).toContain(
      "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
    );
    expect(logs.join("\n")).toContain(
      "Commit, stash, or discard the local changes, then rerun `openclaw update`.",
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
  });
  it.each([
    {
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runRestartScript).toHaveBeenCalled();
        expect(runDaemonRestart).not.toHaveBeenCalled();
      },
      name: "refreshes service env when already installed",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue({
          durationMs: 100,
          mode: "git",
          status: "ok",
          steps: [],
        } satisfies UpdateRunResult);
        vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({});
      },
    },
    {
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalled();
      },
      name: "falls back to daemon restart when service env refresh cannot complete",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "fail" });
      },
    },
    {
      assert: () => {
        expect(runDaemonInstall).toHaveBeenCalledWith({
          force: true,
          json: undefined,
        });
        expect(runDaemonRestart).toHaveBeenCalled();
      },
      name: "keeps going when daemon install succeeds but restart fallback still handles relaunch",
      run: async () => {
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        await runRestartFallbackScenario({ daemonInstall: "ok" });
      },
    },
    {
      assert: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).not.toHaveBeenCalled();
        expect(runDaemonRestart).not.toHaveBeenCalled();
      },
      name: "skips service env refresh when --no-restart is set",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        serviceLoaded.mockResolvedValue(true);

        await updateCommand({ restart: false });
      },
    },
    {
      assert: () => {
        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(
          false,
        );
      },
      name: "skips success message when restart does not run",
      run: async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(false);
        vi.mocked(defaultRuntime.log).mockClear();
        await updateCommand({ restart: true });
      },
    },
  ] as const)("updateCommand service refresh behavior: $name", runUpdateCliScenario);

  it.each([
    {
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
        expect(runRestartScript).toHaveBeenCalled();
      },
      expectedOptions: (root: string) => expect.objectContaining({ cwd: root, timeoutMs: 60_000 }),
      invoke: async () => {
        await updateCommand({});
      },
      name: "updateCommand refreshes service env from updated install root when available",
    },
    {
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
      expectedOptions: (root: string) =>
        expect.objectContaining({
          cwd: root,
          env: expect.objectContaining({
            OPENCLAW_CONFIG_PATH: path.resolve("./config/openclaw.json"),
            OPENCLAW_STATE_DIR: path.resolve("./state"),
          }),
          timeoutMs: 60_000,
        }),
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_CONFIG_PATH: "./config/openclaw.json",
            OPENCLAW_STATE_DIR: "./state",
          },
          async () => {
            await updateCommand({});
          },
        );
      },
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
    },
    {
      assertExtra: () => {
        expect(runDaemonInstall).not.toHaveBeenCalled();
      },
      customSetup: true,
      expectedOptions: (_root: string, context?: { originalCwd: string }) =>
        expect.objectContaining({
          cwd: expect.any(String),
          env: expect.objectContaining({
            OPENCLAW_STATE_DIR: path.resolve(context?.originalCwd ?? process.cwd(), "./state"),
          }),
          timeoutMs: 60_000,
        }),
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return {
              durationMs: 100,
              mode: "npm",
              root,
              status: "ok",
              steps: [],
            };
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: "./state",
            },
            async () => {
              await updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : setupUpdatedRootRefresh();
    const context = (await testCase.invoke()) as { originalCwd: string } | undefined;
    const runCommandWithTimeoutMock = vi.mocked(runCommandWithTimeout) as unknown as {
      mock: { calls: [unknown, { cwd?: string }?][] };
    };
    const root = setup?.root ?? runCommandWithTimeoutMock.mock.calls[0]?.[1]?.cwd;
    const entryPath = setup?.entryPath ?? path.join(String(root), "dist", "entry.js");

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [expect.stringMatching(/node/), entryPath, "gateway", "install", "--force"],
      testCase.expectedOptions(String(root), context),
    );
    testCase.assertExtra();
  });

  it("updateCommand continues after doctor sub-step and clears update flag", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        vi.mocked(doctorCommand).mockResolvedValue(undefined);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({ nonInteractive: true }),
        );
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();

        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(
          logLines.some((line) =>
            line.includes("Leveled up! New skills unlocked. You're welcome."),
          ),
        ).toBe(true);
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it.each([
    {
      expectedError: "timeout",
      name: "update command invalid timeout",
      requireTty: false,
      run: async () => await updateCommand({ timeout: "invalid" }),
    },
    {
      expectedError: "timeout",
      name: "update status command invalid timeout",
      requireTty: false,
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
    },
    {
      expectedError: "timeout",
      name: "update wizard invalid timeout",
      requireTty: true,
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
    },
    {
      expectedError: "Update wizard requires a TTY",
      name: "update wizard requires a TTY",
      requireTty: false,
      run: async () => await updateWizardCommand({}),
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ run, requireTty, expectedError, name }) => {
      setTty(requireTty);
      vi.mocked(defaultRuntime.error).mockClear();
      vi.mocked(defaultRuntime.exit).mockClear();

      await run();

      expect(defaultRuntime.error, name).toHaveBeenCalledWith(
        expect.stringContaining(expectedError),
      );
      expect(defaultRuntime.exit, name).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    await setupNonInteractiveDowngrade();
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(
      shouldExit,
    );
    expect(vi.mocked(runGatewayUpdate).mock.calls.length > 0).toBe(false);
    expect(
      vi
        .mocked(runCommandWithTimeout)
        .mock.calls.some((call) => Array.isArray(call[0]) && call[0][0] === "npm"),
    ).toBe(shouldRunPackageUpdate);
  });

  it("updateWizardCommand offers dev checkout and forwards selections", async () => {
    const tempDir = createCaseDir("openclaw-update-wizard");
    await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
      setTty(true);

      vi.mocked(checkUpdateStatus).mockResolvedValue({
        deps: {
          lockfilePath: null,
          manager: "npm",
          markerPath: null,
          status: "ok",
        },
        installKind: "package",
        packageManager: "npm",
        root: "/test/path",
      });
      select.mockResolvedValue("dev");
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        durationMs: 100,
        mode: "git",
        status: "ok",
        steps: [],
      });

      await updateWizardCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("dev");
    });
  });

  it("uses ~/openclaw as the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    await withEnvAsync({ OPENCLAW_GIT_DIR: undefined }, async () => {
      expect(resolveGitInstallDir()).toBe(path.posix.join("/tmp/oc-home", "openclaw"));
    });
    homedirSpy.mockRestore();
  });
});
