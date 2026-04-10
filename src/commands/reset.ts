import { cancel, confirm, isCancel } from "@clack/prompts";
import { formatCliCommand } from "../cli/command-format.js";
import { isNixMode } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { selectStyled } from "../terminal/prompt-select-styled.js";
import { stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { resolveCleanupPlanFromDisk } from "./cleanup-plan.js";
import {
  listAgentSessionDirs,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

export type ResetScope = "config" | "config+creds+sessions" | "full";

export interface ResetOptions {
  scope?: ResetScope;
  yes?: boolean;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

async function stopGatewayIfRunning(runtime: RuntimeEnv) {
  if (isNixMode) {
    return;
  }
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (error) {
    runtime.error(`Gateway service check failed: ${String(error)}`);
    return;
  }
  if (!loaded) {
    return;
  }
  try {
    await service.stop({ env: process.env, stdout: process.stdout });
  } catch (error) {
    runtime.error(`Gateway stop failed: ${String(error)}`);
  }
}

function logBackupRecommendation(runtime: RuntimeEnv) {
  runtime.log(`Recommended first: ${formatCliCommand("openclaw backup create")}`);
}

export async function resetCommand(runtime: RuntimeEnv, opts: ResetOptions) {
  const interactive = !opts.nonInteractive;
  if (!interactive && !opts.yes) {
    runtime.error("Non-interactive mode requires --yes.");
    runtime.exit(1);
    return;
  }

  let {scope} = opts;
  if (!scope) {
    if (!interactive) {
      runtime.error("Non-interactive mode requires --scope.");
      runtime.exit(1);
      return;
    }
    const selection = await selectStyled<ResetScope>({
      initialValue: "config+creds+sessions",
      message: "Reset scope",
      options: [
        {
          hint: "openclaw.json",
          label: "Config only",
          value: "config",
        },
        {
          hint: "keeps workspace + auth profiles",
          label: "Config + credentials + sessions",
          value: "config+creds+sessions",
        },
        {
          hint: "state dir + workspace",
          label: "Full reset",
          value: "full",
        },
      ],
    });
    if (isCancel(selection)) {
      cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
      runtime.exit(0);
      return;
    }
    scope = selection;
  }

  if (!["config", "config+creds+sessions", "full"].includes(scope)) {
    runtime.error('Invalid --scope. Expected "config", "config+creds+sessions", or "full".');
    runtime.exit(1);
    return;
  }

  if (interactive && !opts.yes) {
    const ok = await confirm({
      message: stylePromptMessage(`Proceed with ${scope} reset?`),
    });
    if (isCancel(ok) || !ok) {
      cancel(stylePromptTitle("Reset cancelled.") ?? "Reset cancelled.");
      runtime.exit(0);
      return;
    }
  }

  const dryRun = Boolean(opts.dryRun);
  const { stateDir, configPath, oauthDir, configInsideState, oauthInsideState, workspaceDirs } =
    resolveCleanupPlanFromDisk();

  if (scope !== "config") {
    logBackupRecommendation(runtime);
    if (dryRun) {
      runtime.log("[dry-run] stop gateway service");
    } else {
      await stopGatewayIfRunning(runtime);
    }
  }

  if (scope === "config") {
    await removePath(configPath, runtime, { dryRun, label: configPath });
    return;
  }

  if (scope === "config+creds+sessions") {
    await removePath(configPath, runtime, { dryRun, label: configPath });
    await removePath(oauthDir, runtime, { dryRun, label: oauthDir });
    const sessionDirs = await listAgentSessionDirs(stateDir);
    for (const dir of sessionDirs) {
      await removePath(dir, runtime, { dryRun, label: dir });
    }
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
    return;
  }

  if (scope === "full") {
    await removeStateAndLinkedPaths(
      { configInsideState, configPath, oauthDir, oauthInsideState, stateDir },
      runtime,
      { dryRun },
    );
    await removeWorkspaceDirs(workspaceDirs, runtime, { dryRun });
    runtime.log(`Next: ${formatCliCommand("openclaw onboard --install-daemon")}`);
    return;
  }
}
