import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { doctorCommand } from "../../commands/doctor.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayPort,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import {
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  channelToNpmTag,
  normalizeUpdateChannel,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmPackageTargetStatus,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  cleanupGlobalRenameDirs,
  collectInstalledGlobalPackageErrors,
  createGlobalInstallEnv,
  globalInstallArgs,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
} from "../../infra/update-global.js";
import { type UpdateRunResult, runGatewayUpdate } from "../../infra/update-runner.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../../plugins/update.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";
import {
  DEFAULT_PACKAGE_NAME,
  type UpdateCommandOptions,
  createGlobalCommandRunner,
  ensureGitCheckout,
  normalizeTag,
  parseTimeoutMsOrExit,
  readPackageName,
  readPackageVersion,
  resolveGitInstallDir,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

function resolveGatewayInstallEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return [
    path.join(root, "dist", "entry.js"),
    path.join(root, "dist", "entry.mjs"),
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "index.mjs"),
  ];
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

async function resolvePackageRuntimePreflightError(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(params.tag)) {
    return null;
  }
  const target = params.tag.trim();
  if (!target) {
    return null;
  }
  const status = await fetchNpmPackageTargetStatus({
    target,
    timeoutMs: params.timeoutMs,
  });
  if (status.error) {
    return null;
  }
  const satisfies = nodeVersionSatisfiesEngine(process.versions.node ?? null, status.nodeEngine);
  if (satisfies !== false) {
    return null;
  }
  const targetLabel = status.version ?? target;
  return [
    `Node ${process.versions.node ?? "unknown"} is too old for openclaw@${targetLabel}.`,
    `The requested package requires ${status.nodeEngine}.`,
    "Upgrade Node to 22.14+ or Node 24, then rerun `openclaw update`.",
    "Bare `npm i -g openclaw` can silently install an older compatible release.",
    "After upgrading Node, use `npm i -g openclaw@latest`.",
  ].join("\n");
}

function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    if (!invocationCwd) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    resolvedEnv[key] = path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

interface UpdateDryRunPreview {
  dryRun: true;
  root: string;
  installKind: "git" | "package" | "unknown";
  mode: UpdateRunResult["mode"];
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  restart: boolean;
  requestedChannel: "stable" | "beta" | "dev" | null;
  storedChannel: "stable" | "beta" | "dev" | null;
  effectiveChannel: "stable" | "beta" | "dev";
  tag: string;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  actions: string[];
  notes: string[];
}

function printDryRunPreview(preview: UpdateDryRunPreview, jsonMode: boolean): void {
  if (jsonMode) {
    defaultRuntime.writeJson(preview);
    return;
  }

  defaultRuntime.log(theme.heading("Update dry-run"));
  defaultRuntime.log(theme.muted("No changes were applied."));
  defaultRuntime.log("");
  defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
  defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
  defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
  defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
  if (preview.currentVersion) {
    defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
  }
  if (preview.targetVersion) {
    defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Planned actions:"));
  for (const action of preview.actions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (preview.notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Notes:"));
    for (const note of preview.notes) {
      defaultRuntime.log(`  - ${theme.muted(note)}`);
    }
  }
}

async function refreshGatewayServiceEnv(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  for (const candidate of resolveGatewayInstallEntrypointCandidates(params.result.root)) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const res = await runCommandWithTimeout([resolveNodeRunner(), candidate, ...args], {
      cwd: params.result.root,
      env: resolveServiceRefreshEnv(process.env, params.invocationCwd),
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${candidate}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
}

async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Shell completion"));

    const shouldInstall = await confirm({
      initialValue: true,
      message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
    });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
      }
      return;
    }

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
}): Promise<UpdateRunResult> {
  const manager = await resolveGlobalManager({
    installKind: params.installKind,
    root: params.root,
    timeoutMs: params.timeoutMs,
  });
  const installEnv = await createGlobalInstallEnv();
  const runCommand = createGlobalCommandRunner();
  const installTarget = await resolveGlobalInstallTarget({
    manager,
    pkgRoot: params.root,
    runCommand,
    timeoutMs: params.timeoutMs,
  });
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec = resolveGlobalInstallSpec({
    env: installEnv,
    packageName,
    tag: params.tag,
  });

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const updateStep = await runUpdateStep({
    argv: globalInstallArgs(installTarget, installSpec),
    env: installEnv,
    name: "global update",
    progress: params.progress,
    timeoutMs: params.timeoutMs,
  });

  const steps = [updateStep];
  let afterVersion = beforeVersion;

  const verifiedPackageRoot =
    (
      await resolveGlobalInstallTarget({
        manager: installTarget,
        runCommand,
        timeoutMs: params.timeoutMs,
      })
    ).packageRoot ?? pkgRoot;
  if (verifiedPackageRoot) {
    afterVersion = await readPackageVersion(verifiedPackageRoot);
    const expectedVersion = resolveExpectedInstalledVersionFromSpec(packageName, installSpec);
    const verificationErrors = await collectInstalledGlobalPackageErrors({
      expectedVersion,
      packageRoot: verifiedPackageRoot,
    });
    if (verificationErrors.length > 0) {
      steps.push({
        command: `verify ${verifiedPackageRoot}`,
        cwd: verifiedPackageRoot,
        durationMs: 0,
        exitCode: 1,
        name: "global install verify",
        stderrTail: verificationErrors.join("\n"),
        stdoutTail: null,
      });
    }
    const entryPath = path.join(verifiedPackageRoot, "dist", "entry.js");
    if (await pathExists(entryPath)) {
      const doctorStep = await runUpdateStep({
        argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive"],
        name: `${CLI_NAME} doctor`,
        progress: params.progress,
        timeoutMs: params.timeoutMs,
      });
      steps.push(doctorStep);
    }
  }

  const failedStep = steps.find((step) => step.exitCode !== 0);
  return {
    after: { version: afterVersion },
    before: { version: beforeVersion },
    durationMs: Date.now() - params.startedAt,
    mode: manager,
    reason: failedStep ? failedStep.name : undefined,
    root: verifiedPackageRoot ?? params.root,
    status: failedStep ? "error" : "ok",
    steps,
  };
}

async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: "stable" | "beta" | "dev";
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? 20 * 60_000;
  const installEnv = await createGlobalInstallEnv();

  const cloneStep = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        env: installEnv,
        progress: params.progress,
        timeoutMs: effectiveTimeout,
      })
    : null;

  if (cloneStep && cloneStep.exitCode !== 0) {
    const result: UpdateRunResult = {
      durationMs: Date.now() - params.startedAt,
      mode: "git",
      reason: cloneStep.name,
      root: updateRoot,
      status: "error",
      steps: [cloneStep],
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
  }

  const updateResult = await runGatewayUpdate({
    argv1: params.switchToGit ? undefined : process.argv[1],
    channel: params.channel,
    cwd: updateRoot,
    progress: params.progress,
    tag: params.tag,
    timeoutMs: params.timeoutMs,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      installKind: params.installKind,
      root: params.root,
      timeoutMs: effectiveTimeout,
    });
    const runCommand = createGlobalCommandRunner();
    const installTarget = await resolveGlobalInstallTarget({
      manager,
      pkgRoot: params.root,
      runCommand,
      timeoutMs: effectiveTimeout,
    });
    const installStep = await runUpdateStep({
      argv: globalInstallArgs(installTarget, updateRoot),
      cwd: updateRoot,
      env: installEnv,
      name: "global install",
      progress: params.progress,
      timeoutMs: effectiveTimeout,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    return {
      ...updateResult,
      durationMs: Date.now() - params.startedAt,
      status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
      steps,
    };
  }

  return {
    ...updateResult,
    durationMs: Date.now() - params.startedAt,
    steps,
  };
}

async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  opts: UpdateCommandOptions;
}): Promise<void> {
  if (!params.configSnapshot.valid) {
    if (!params.opts.json) {
      defaultRuntime.log(theme.warn("Skipping plugin updates: config is invalid."));
    }
    return;
  }

  const pluginLogger = params.opts.json
    ? {}
    : {
        error: (msg: string) => defaultRuntime.log(theme.error(msg)),
        info: (msg: string) => defaultRuntime.log(msg),
        warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
      };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const syncResult = await syncPluginsForUpdateChannel({
    channel: params.channel,
    config: params.configSnapshot.config,
    logger: pluginLogger,
    workspaceDir: params.root,
  });
  let pluginConfig = syncResult.config;

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    logger: pluginLogger,
    skipIds: new Set(syncResult.summary.switchedToNpm),
  });
  pluginConfig = npmResult.config;

  if (syncResult.changed || npmResult.changed) {
    await replaceConfigFile({
      baseHash: params.configSnapshot.hash,
      nextConfig: pluginConfig,
    });
  }

  if (params.opts.json) {
    return;
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (syncResult.summary.switchedToBundled.length > 0) {
    defaultRuntime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (syncResult.summary.switchedToNpm.length > 0) {
    defaultRuntime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of syncResult.summary.warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
  for (const error of syncResult.summary.errors) {
    defaultRuntime.log(theme.error(error));
  }

  const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
  const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

  if (npmResult.outcomes.length === 0) {
    defaultRuntime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const outcome of npmResult.outcomes) {
    if (outcome.status !== "error") {
      continue;
    }
    defaultRuntime.log(theme.error(outcome.message));
  }
}

async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
}): Promise<void> {
  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      let restarted = false;
      let restartInitiated = false;
      if (params.refreshServiceEnv) {
        try {
          await refreshGatewayServiceEnv({
            invocationCwd: params.invocationCwd,
            jsonMode: Boolean(params.opts.json),
            result: params.result,
          });
        } catch (error) {
          // Always log the refresh failure so callers can detect it (issue #56772).
          // Previously this was silently suppressed in --json mode, hiding the root
          // Cause and preventing auto-update callers from detecting the failure.
          const message = `Failed to refresh gateway service environment from updated install: ${String(error)}`;
          if (params.opts.json) {
            defaultRuntime.error(message);
          } else {
            defaultRuntime.log(theme.warn(message));
          }
        }
      }
      if (params.restartScriptPath) {
        await runRestartScript(params.restartScriptPath);
        restartInitiated = true;
      } else {
        restarted = await runDaemonRestart();
      }

      if (!params.opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        try {
          const interactiveDoctor =
            Boolean(process.stdin.isTTY) && !params.opts.json && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (error) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(error)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        }
      }

      if (!params.opts.json && restartInitiated) {
        const service = resolveGatewayService();
        let health = await waitForGatewayHealthyRestart({
          port: params.gatewayPort,
          service,
        });
        if (!health.healthy && health.staleGatewayPids.length > 0) {
          if (!params.opts.json) {
            defaultRuntime.log(
              theme.warn(
                `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
              ),
            );
          }
          await terminateStaleGatewayPids(health.staleGatewayPids);
          await runDaemonRestart();
          health = await waitForGatewayHealthyRestart({
            port: params.gatewayPort,
            service,
          });
        }

        if (health.healthy) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
        } else {
          defaultRuntime.log(theme.warn("Gateway did not become healthy after restart."));
          for (const line of renderRestartDiagnostics(health)) {
            defaultRuntime.log(theme.muted(line));
          }
          defaultRuntime.log(
            theme.muted(
              `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
            ),
          );
        }
        defaultRuntime.log("");
      }
    } catch (error) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Daemon restart failed: ${String(error)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
          ),
        );
      }
    }
    return;
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  suppressDeprecations();
  const invocationCwd = tryResolveInvocationCwd();

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }

  const root = await resolveUpdateRoot();
  const updateStatus = await checkUpdateStatus({
    fetchGit: false,
    includeRegistry: false,
    root,
    timeoutMs: timeoutMs ?? 3500,
  });

  const configSnapshot = await readConfigFileSnapshot();
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    const issues = formatConfigIssueLines(configSnapshot.issues, "-");
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const {installKind} = updateStatus;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : (switchToPackage ? "package" : installKind);
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;

  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let fallbackToLatest = false;
  let packageInstallSpec: string | null = null;

  if (updateInstallKind !== "git") {
    currentVersion = switchToPackage ? null : await readPackageVersion(root);
    if (explicitTag) {
      targetVersion = await resolveTargetVersion(tag, timeoutMs);
    } else {
      targetVersion = await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
        ({ tag } = resolved);
        fallbackToLatest = channel === "beta" && resolved.tag === "latest";
        return resolved.version;
      });
    }
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    downgradeRisk =
      canResolveRegistryVersionForPackageTarget(tag) &&
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));
    packageInstallSpec = resolveGlobalInstallSpec({
      env: process.env,
      packageName: DEFAULT_PACKAGE_NAME,
      tag,
    });
  }

  if (opts.dryRun) {
    let mode: UpdateRunResult["mode"] = "unknown";
    if (updateInstallKind === "git") {
      mode = "git";
    } else if (updateInstallKind === "package") {
      mode = await resolveGlobalManager({
        installKind,
        root,
        timeoutMs: timeoutMs ?? 20 * 60_000,
      });
    }

    const actions: string[] = [];
    if (requestedChannel && requestedChannel !== storedChannel) {
      actions.push(`Persist update.channel=${requestedChannel} in config`);
    }
    if (switchToGit) {
      actions.push("Switch install mode from package to git checkout (dev channel)");
    } else if (switchToPackage) {
      actions.push(`Switch install mode from git to package manager (${mode})`);
    } else if (updateInstallKind === "git") {
      actions.push(`Run git update flow on channel ${channel} (fetch/rebase/build/doctor)`);
    } else {
      actions.push(`Run global package manager update with spec ${packageInstallSpec ?? tag}`);
    }
    actions.push("Run plugin update sync after core update");
    actions.push("Refresh shell completion cache (if needed)");
    actions.push(
      shouldRestart
        ? "Restart gateway service and run doctor checks"
        : "Skip restart (because --no-restart is set)",
    );

    const notes: string[] = [];
    if (opts.tag && updateInstallKind === "git") {
      notes.push("--tag applies to npm installs only; git updates ignore it.");
    }
    if (fallbackToLatest) {
      notes.push("Beta channel resolves to latest for this run (fallback).");
    }
    if (explicitTag && !canResolveRegistryVersionForPackageTarget(tag)) {
      notes.push("Non-registry package specs skip npm version lookup and downgrade previews.");
    }

    printDryRunPreview(
      {
        actions,
        currentVersion,
        downgradeRisk,
        dryRun: true,
        effectiveChannel: channel,
        installKind,
        mode,
        notes,
        requestedChannel,
        restart: shouldRestart,
        root,
        storedChannel,
        switchToGit,
        switchToPackage,
        tag: packageInstallSpec ?? tag,
        targetVersion,
        updateInstallKind,
      },
      Boolean(opts.json),
    );
    return;
  }

  if (downgradeRisk && !opts.yes) {
    if (!process.stdin.isTTY || opts.json) {
      defaultRuntime.error(
        [
          "Downgrade confirmation required.",
          "Downgrading can break configuration. Re-run in a TTY to confirm.",
        ].join("\n"),
      );
      defaultRuntime.exit(1);
      return;
    }

    const targetLabel = targetVersion ?? `${tag} (unknown)`;
    const message = `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`;
    const ok = await confirm({
      initialValue: false,
      message: stylePromptMessage(message),
    });
    if (isCancel(ok) || !ok) {
      if (!opts.json) {
        defaultRuntime.log(theme.muted("Update cancelled."));
      }
      defaultRuntime.exit(0);
      return;
    }
  }

  if (updateInstallKind === "git" && opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (updateInstallKind === "package") {
    const runtimePreflightError = await resolvePackageRuntimePreflightError({
      tag,
      timeoutMs,
    });
    if (runtimePreflightError) {
      defaultRuntime.error(runtimePreflightError);
      defaultRuntime.exit(1);
      return;
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();

  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnv = false;
  const gatewayPort = resolveGatewayPort(
    configSnapshot.valid ? configSnapshot.config : undefined,
    process.env,
  );
  if (shouldRestart) {
    try {
      const loaded = await resolveGatewayService().isLoaded({ env: process.env });
      if (loaded) {
        restartScriptPath = await prepareRestartScript(process.env, gatewayPort);
        refreshGatewayServiceEnv = true;
      }
    } catch {
      // Ignore errors during pre-check; fallback to standard restart
    }
  }

  const result =
    updateInstallKind === "package"
      ? await runPackageInstallUpdate({
          installKind,
          progress,
          root,
          startedAt,
          tag,
          timeoutMs: timeoutMs ?? 20 * 60_000,
        })
      : await runGitUpdate({
          channel,
          installKind,
          opts,
          progress,
          root,
          showProgress,
          startedAt,
          stop,
          switchToGit,
          tag,
          timeoutMs,
        });

  stop();
  printResult(result, { ...opts, hideSteps: showProgress });

  if (result.status === "error") {
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (result.reason === "dirty") {
      defaultRuntime.error(theme.error("Update blocked: local files are edited in this checkout."));
      defaultRuntime.log(
        theme.warn(
          "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
        ),
      );
      defaultRuntime.log(
        theme.muted("Commit, stash, or discard the local changes, then rerun `openclaw update`."),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  if (switchToGit && result.status === "ok" && result.mode === "git") {
    if (!opts.json) {
      defaultRuntime.log(
        theme.muted(
          "Switched from a package install to a git checkout. Skipping remaining post-update work in the old CLI process; rerun follow-up commands from the new git install if needed.",
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  let postUpdateConfigSnapshot = configSnapshot;
  if (requestedChannel && configSnapshot.valid && requestedChannel !== storedChannel) {
    if (switchToGit) {
      if (!opts.json) {
        defaultRuntime.log(
          theme.muted(
            `Skipped persisting update.channel=${requestedChannel} in the pre-update CLI process after switching to a git install.`,
          ),
        );
      }
    } else {
      const next = {
        ...configSnapshot.config,
        update: {
          ...configSnapshot.config.update,
          channel: requestedChannel,
        },
      };
      await replaceConfigFile({
        baseHash: configSnapshot.hash,
        nextConfig: next,
      });
      postUpdateConfigSnapshot = {
        ...configSnapshot,
        config: asRuntimeConfig(next),
        hash: undefined,
        parsed: next,
        resolved: asResolvedSourceConfig(next),
        runtimeConfig: asRuntimeConfig(next),
        sourceConfig: asResolvedSourceConfig(next),
      };
      if (!opts.json) {
        defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
      }
    }
  }

  const postUpdateRoot = result.root ?? root;

  // A package -> git switch still runs inside the pre-update CLI process.
  // Any follow-up work that re-enters the CLI can then compare new bundled
  // Plugin minima against the old host version and fail even though the
  // Install itself succeeded. Leave the switched checkout alone and let the
  // New git install handle follow-up commands in a fresh process.
  const deferOldProcessPostUpdateWork = switchToGit && result.mode === "git";
  if (deferOldProcessPostUpdateWork) {
    if (!opts.json) {
      defaultRuntime.log(
        theme.muted(
          "Skipped plugin update sync in the pre-update CLI process after switching to a git install.",
        ),
      );
    }
  } else {
    await updatePluginsAfterCoreUpdate({
      channel,
      configSnapshot: postUpdateConfigSnapshot,
      opts,
      root: postUpdateRoot,
    });
  }

  if (deferOldProcessPostUpdateWork) {
    if (!opts.json) {
      defaultRuntime.log(
        theme.muted(
          "Skipped completion/restart follow-ups in the pre-update CLI process after switching to a git install.",
        ),
      );
    }
  } else {
    await tryWriteCompletionCache(postUpdateRoot, Boolean(opts.json));
    await tryInstallShellCompletion({
      jsonMode: Boolean(opts.json),
      skipPrompt: Boolean(opts.yes),
    });

    await maybeRestartService({
      gatewayPort,
      invocationCwd,
      opts,
      refreshServiceEnv: refreshGatewayServiceEnv,
      restartScriptPath,
      result,
      shouldRestart,
    });
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  }
}
