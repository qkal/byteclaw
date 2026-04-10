import { confirm, isCancel } from "@clack/prompts";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  formatUpdateChannelLabel,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { checkUpdateStatus } from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { selectStyled } from "../../terminal/prompt-select-styled.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import {
  type UpdateWizardOptions,
  isEmptyDir,
  isGitCheckout,
  parseTimeoutMsOrExit,
  resolveGitInstallDir,
  resolveUpdateRoot,
} from "./shared.js";
import { updateCommand } from "./update-command.js";

export async function updateWizardCommand(opts: UpdateWizardOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    defaultRuntime.error(
      "Update wizard requires a TTY. Use `openclaw update --channel <stable|beta|dev>` instead.",
    );
    defaultRuntime.exit(1);
    return;
  }

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }

  const root = await resolveUpdateRoot();
  const [updateStatus, configSnapshot] = await Promise.all([
    checkUpdateStatus({
      fetchGit: false,
      includeRegistry: false,
      root,
      timeoutMs: timeoutMs ?? 3500,
    }),
    readConfigFileSnapshot(),
  ]);

  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel,
    git: updateStatus.git
      ? { branch: updateStatus.git.branch, tag: updateStatus.git.tag }
      : undefined,
    installKind: updateStatus.installKind,
  });
  const channelLabel = formatUpdateChannelLabel({
    channel: channelInfo.channel,
    gitBranch: updateStatus.git?.branch ?? null,
    gitTag: updateStatus.git?.tag ?? null,
    source: channelInfo.source,
  });

  const pickedChannel = await selectStyled({
    initialValue: "keep",
    message: "Update channel",
    options: [
      {
        hint: channelLabel,
        label: `Keep current (${channelInfo.channel})`,
        value: "keep",
      },
      {
        hint: "Tagged releases (npm latest)",
        label: "Stable",
        value: "stable",
      },
      {
        hint: "Prereleases (npm beta)",
        label: "Beta",
        value: "beta",
      },
      {
        hint: "Git main",
        label: "Dev",
        value: "dev",
      },
    ],
  });

  if (isCancel(pickedChannel)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  const requestedChannel = pickedChannel === "keep" ? null : pickedChannel;

  if (requestedChannel === "dev" && updateStatus.installKind !== "git") {
    const gitDir = resolveGitInstallDir();
    const hasGit = await isGitCheckout(gitDir);
    if (!hasGit) {
      const dirExists = await pathExists(gitDir);
      if (dirExists) {
        const empty = await isEmptyDir(gitDir);
        if (!empty) {
          defaultRuntime.error(
            `OPENCLAW_GIT_DIR points at a non-git directory: ${gitDir}. Set OPENCLAW_GIT_DIR to an empty folder or an openclaw checkout.`,
          );
          defaultRuntime.exit(1);
          return;
        }
      }

      const ok = await confirm({
        initialValue: true,
        message: stylePromptMessage(
          `Create a git checkout at ${gitDir}? (override via OPENCLAW_GIT_DIR)`,
        ),
      });
      if (isCancel(ok) || !ok) {
        defaultRuntime.log(theme.muted("Update cancelled."));
        defaultRuntime.exit(0);
        return;
      }
    }
  }

  const restart = await confirm({
    initialValue: true,
    message: stylePromptMessage("Restart the gateway service after update?"),
  });
  if (isCancel(restart)) {
    defaultRuntime.log(theme.muted("Update cancelled."));
    defaultRuntime.exit(0);
    return;
  }

  try {
    await updateCommand({
      channel: requestedChannel ?? undefined,
      restart: Boolean(restart),
      timeout: opts.timeout,
    });
  } catch (error) {
    defaultRuntime.error(String(error));
    defaultRuntime.exit(1);
  }
}
