import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceConfigFile, resolveGatewayPort } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { applyLocalSetupWorkspaceConfig } from "../onboard-config.js";
import {
  DEFAULT_WORKSPACE,
  applyWizardMetadata,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import type { OnboardOptions } from "../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  type GatewayHealthFailureDiagnostics,
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

const INSTALL_DAEMON_HEALTH_DEADLINE_MS = 45_000;
const ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS = 15_000;
const INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS = 90_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS = 90_000;

function resolveInstallDaemonGatewayHealthTiming(): {
  deadlineMs: number;
  probeTimeoutMs: number;
  healthCommandTimeoutMs: number;
} {
  if (process.platform === "win32") {
    return {
      deadlineMs: WINDOWS_INSTALL_DAEMON_HEALTH_DEADLINE_MS,
      healthCommandTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
      probeTimeoutMs: WINDOWS_INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
    };
  }
  return {
    deadlineMs: INSTALL_DAEMON_HEALTH_DEADLINE_MS,
    healthCommandTimeoutMs: INSTALL_DAEMON_HEALTH_COMMAND_TIMEOUT_MS,
    probeTimeoutMs: INSTALL_DAEMON_HEALTH_PROBE_TIMEOUT_MS,
  };
}

async function collectGatewayHealthFailureDiagnostics(): Promise<
  GatewayHealthFailureDiagnostics | undefined
> {
  const diagnostics: GatewayHealthFailureDiagnostics = {};

  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    const service = resolveGatewayService();
    const env = process.env as Record<string, string | undefined>;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env }).catch(() => false),
      service.readRuntime(env).catch(() => undefined),
    ]);
    diagnostics.service = {
      label: service.label,
      lastExitReason: runtime?.lastExitReason,
      lastExitStatus: runtime?.lastExitStatus,
      loaded,
      loadedText: service.loadedText,
      pid: runtime?.pid,
      runtimeStatus: runtime?.status,
      state: runtime?.state,
    };
  } catch (error) {
    diagnostics.inspectError = `service diagnostics failed: ${String(error)}`;
  }

  try {
    const { readLastGatewayErrorLine } = await import("../../daemon/diagnostics.js");
    diagnostics.lastGatewayError = (await readLastGatewayErrorLine(process.env)) ?? undefined;
  } catch (error) {
    diagnostics.inspectError = diagnostics.inspectError
      ? `${diagnostics.inspectError}; log diagnostics failed: ${String(error)}`
      : `log diagnostics failed: ${String(error)}`;
  }

  return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError
    ? diagnostics
    : undefined;
}

export async function runNonInteractiveLocalSetup(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  baseHash?: string;
}) {
  const { opts, runtime, baseConfig, baseHash } = params;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
    opts,
  });

  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts, {
    config: nextConfig,
    env: process.env,
    workspaceDir,
  });
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive setup.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  if (authChoice !== "skip") {
    const { applyNonInteractiveAuthChoice } = await import("./local/auth-choice.js");
    const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
      authChoice,
      baseConfig,
      nextConfig,
      opts,
      runtime,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    defaultPort: gatewayBasePort,
    nextConfig,
    opts,
    runtime,
  });
  if (!gatewayResult) {
    return;
  }
  ({ nextConfig } = gatewayResult);

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await replaceConfigFile({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let daemonInstallStatus:
    | {
        requested: boolean;
        installed: boolean;
        skippedReason?: "systemd-user-unavailable";
      }
    | undefined;
  if (opts.installDaemon) {
    const { installGatewayDaemonNonInteractive } = await import("./local/daemon-install.js");
    const daemonInstall = await installGatewayDaemonNonInteractive({
      nextConfig,
      opts,
      port: gatewayResult.port,
      runtime,
    });
    daemonInstallStatus = daemonInstall.installed
      ? {
          installed: true,
          requested: true,
        }
      : {
          installed: false,
          requested: true,
          skippedReason: daemonInstall.skippedReason,
        };
    if (!daemonInstall.installed && !opts.skipHealth) {
      logNonInteractiveOnboardingFailure({
        daemonInstall: {
          installed: false,
          requested: true,
          skippedReason: daemonInstall.skippedReason,
        },
        daemonRuntime: daemonRuntimeRaw,
        hints:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? [
                "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
                "If your auth profile uses env-backed refs, keep those env vars set in the shell that runs `openclaw gateway run` or `openclaw agent --local`.",
              ]
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
        installDaemon: true,
        message:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? "Gateway service install is unavailable because systemd user services are not reachable in this Linux session."
            : "Gateway service install did not complete successfully.",
        mode,
        opts,
        phase: "daemon-install",
        runtime,
      });
      runtime.exit(1);
      return;
    }
  }

  if (!opts.skipHealth) {
    const { healthCommand } = await import("../health.js");
    const links = resolveControlUiLinks({
      basePath: undefined,
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      customBindHost: nextConfig.gateway?.customBindHost,
      port: gatewayResult.port,
    });
    const installDaemonGatewayHealthTiming = resolveInstallDaemonGatewayHealthTiming();
    const probe = await waitForGatewayReachable({
      deadlineMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.deadlineMs
        : ATTACH_EXISTING_GATEWAY_HEALTH_DEADLINE_MS,
      probeTimeoutMs: opts.installDaemon
        ? installDaemonGatewayHealthTiming.probeTimeoutMs
        : undefined,
      token: gatewayResult.gatewayToken,
      url: links.wsUrl,
    });
    if (!probe.ok) {
      const diagnostics = opts.installDaemon
        ? await collectGatewayHealthFailureDiagnostics()
        : undefined;
      logNonInteractiveOnboardingFailure({
        daemonInstall: daemonInstallStatus,
        daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
        detail: probe.detail,
        diagnostics,
        gateway: {
          httpUrl: links.httpUrl,
          wsUrl: links.wsUrl,
        },
        hints: !opts.installDaemon
          ? [
              "Non-interactive local setup only waits for an already-running gateway unless you pass --install-daemon.",
              `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
              process.platform === "win32"
                ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                : undefined,
            ].filter((value): value is string => Boolean(value))
          : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
        installDaemon: Boolean(opts.installDaemon),
        message: `Gateway did not become reachable at ${links.wsUrl}.`,
        mode,
        opts,
        phase: "gateway-health",
        runtime,
      });
      runtime.exit(1);
      return;
    }
    await healthCommand(
      {
        json: false,
        timeoutMs: opts.installDaemon
          ? installDaemonGatewayHealthTiming.healthCommandTimeoutMs
          : 10_000,
      },
      runtime,
    );
  }

  logNonInteractiveOnboardingJson({
    authChoice,
    daemonInstall: daemonInstallStatus,
    daemonRuntime: opts.installDaemon ? daemonRuntimeRaw : undefined,
    gateway: {
      authMode: gatewayResult.authMode,
      bind: gatewayResult.bind,
      port: gatewayResult.port,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(opts.installDaemon),
    mode,
    opts,
    runtime,
    skipHealth: Boolean(opts.skipHealth),
    skipSkills: Boolean(opts.skipSkills),
    workspaceDir,
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
