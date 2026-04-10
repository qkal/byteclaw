import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, replaceConfigFile, resolveGatewayPort } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { resolveSetupSecretInputString } from "../wizard/setup.secret-input.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
import { noteChannelStatus, setupChannels } from "./onboard-channels.js";
import {
  DEFAULT_WORKSPACE,
  applyWizardMetadata,
  ensureWorkspaceAndSessions,
  guardCancel,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type ConfigureSectionChoice = WizardSection | "__continue";

async function resolveGatewaySecretInputForWizard(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    return await resolveSetupSecretInputString({
      config: params.cfg,
      env: process.env,
      path: params.path,
      value: params.value,
    });
  } catch {
    return undefined;
  }
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<void> {
  const localLinks = resolveControlUiLinks({
    basePath: undefined,
    bind: params.cfg.gateway?.bind ?? "loopback",
    customBindHost: params.cfg.gateway?.customBindHost,
    port: params.port,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const configuredToken = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    path: "gateway.auth.token",
    value: params.cfg.gateway?.auth?.token,
  });
  const configuredPassword = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    path: "gateway.auth.password",
    value: params.cfg.gateway?.auth?.password,
  });
  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? configuredToken;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD ?? configuredPassword;

  await waitForGatewayReachable({
    deadlineMs: 15_000,
    password,
    token,
    url: wsUrl,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (error) {
    params.runtime.error(formatHealthCheckFailure(error));
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await select<ConfigureSectionChoice>({
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
      message: "Select sections to configure",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          hint: hasSelection ? "Done" : "Skip for now",
          label: "Continue",
          value: "__continue",
        },
      ],
    }),
    runtime,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      initialValue: "configure",
      message: "Channels",
      options: [
        {
          hint: "Add/update channels; disable unselected accounts",
          label: "Configure/link",
          value: "configure",
        },
        {
          hint: "Delete channel tokens/settings from openclaw.json",
          label: "Remove channel config",
          value: "remove",
        },
      ],
    }),
    runtime,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: ReturnType<typeof createClackPrompter>,
): Promise<OpenClawConfig> {
  type WebSearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const { resolveSearchProviderOptions, setupSearch } = await import("./onboard-search.js");
  const { describeCodexNativeWebSearch, isCodexNativeWebSearchRelevant } =
    await import("../agents/codex-native-web-search.js");
  const searchProviderOptions = resolveSearchProviderOptions(nextConfig);

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Choose a managed provider now, and Codex-capable models can also use native Codex web search.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      initialValue: existingSearch?.enabled ?? searchProviderOptions.length > 0,
      message: "Enable web_search?",
    }),
    runtime,
  );

  let nextSearch: WebSearchConfig = {
    ...existingSearch,
    enabled: enableSearch,
  };
  let workingConfig = nextConfig;

  if (enableSearch) {
    const codexRelevant = isCodexNativeWebSearchRelevant({ config: nextConfig });
    let configureManagedProvider = true;

    if (codexRelevant) {
      note(
        [
          "Codex-capable models can optionally use native Codex web search.",
          "Managed web_search still controls non-Codex models.",
          "If no managed provider is configured, non-Codex models still rely on provider auto-detect and may have no search available.",
          ...(describeCodexNativeWebSearch(nextConfig)
            ? [describeCodexNativeWebSearch(nextConfig)!]
            : ["Recommended mode: cached."]),
        ].join("\n"),
        "Codex native search",
      );

      const enableCodexNative = guardCancel(
        await confirm({
          initialValue: existingSearch?.openaiCodex?.enabled === true,
          message: "Enable native Codex web search for Codex-capable models?",
        }),
        runtime,
      );

      if (enableCodexNative) {
        const codexMode = guardCancel(
          await select({
            initialValue: existingSearch?.openaiCodex?.mode ?? "cached",
            message: "Codex native web search mode",
            options: [
              {
                hint: "Uses cached web content",
                label: "cached (recommended)",
                value: "cached",
              },
              {
                hint: "Allows live external web access",
                label: "live",
                value: "live",
              },
            ],
          }),
          runtime,
        );
        nextSearch = {
          ...nextSearch,
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            enabled: true,
            mode: codexMode,
          },
        };
        configureManagedProvider = guardCancel(
          await confirm({
            initialValue: Boolean(existingSearch?.provider),
            message: "Configure or change a managed web search provider now?",
          }),
          runtime,
        );
      } else {
        nextSearch = {
          ...nextSearch,
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            enabled: false,
          },
        };
      }
    }

    if (searchProviderOptions.length === 0) {
      if (configureManagedProvider) {
        note(
          [
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then rerun configure.",
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
      }
      if (nextSearch.openaiCodex?.enabled !== true) {
        nextSearch = {
          ...existingSearch,
          enabled: false,
        };
      }
    } else if (configureManagedProvider) {
      workingConfig = await setupSearch(workingConfig, runtime, prompter);
      nextSearch = {
        ...workingConfig.tools?.web?.search,
        enabled: workingConfig.tools?.web?.search?.provider ? true : existingSearch?.enabled,
        openaiCodex: {
          ...existingSearch?.openaiCodex,
          ...(nextSearch.openaiCodex as Record<string, unknown> | undefined),
        },
      };
    }
  }

  const enableFetch = guardCancel(
    await confirm({
      initialValue: existingFetch?.enabled ?? true,
      message: "Enable web_fetch (keyless HTTP fetch)?",
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
    enabled: enableFetch,
  };

  return {
    ...workingConfig,
    tools: {
      ...workingConfig.tools,
      web: {
        ...workingConfig.tools?.web,
        fetch: nextFetch,
        search: nextSearch,
      },
    },
  };
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
    let currentBaseHash = snapshot.hash;
    const baseConfig: OpenClawConfig = snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      path: "gateway.auth.token",
      value: baseConfig.gateway?.auth?.token,
    });
    const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      path: "gateway.auth.password",
      value: baseConfig.gateway?.auth?.password,
    });
    const localProbe = await probeGatewayReachable({
      password: process.env.OPENCLAW_GATEWAY_PASSWORD ?? baseLocalProbePassword,
      token: process.env.OPENCLAW_GATEWAY_TOKEN ?? baseLocalProbeToken,
      url: localUrl,
    });
    const remoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url) ?? "";
    const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      path: "gateway.remote.token",
      value: baseConfig.gateway?.remote?.token,
    });
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          token: baseRemoteProbeToken,
          url: remoteUrl,
        })
      : null;

    const mode = guardCancel(
      await select({
        message: "Where will the Gateway run?",
        options: [
          {
            hint: localProbe.ok
              ? `Gateway reachable (${localUrl})`
              : `No gateway detected (${localUrl})`,
            label: "Local (this machine)",
            value: "local",
          },
          {
            hint: !remoteUrl
              ? "No remote URL configured yet"
              : remoteProbe?.ok
                ? `Gateway reachable (${remoteUrl})`
                : `Configured but unreachable (${remoteUrl})`,
            label: "Remote (info-only)",
            value: "remote",
          },
        ],
      }),
      runtime,
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await replaceConfigFile({
        nextConfig: remoteConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
      });
      currentBaseHash = undefined;
      logConfigUpdated(runtime);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });
      await replaceConfigFile({
        nextConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
      });
      currentBaseHash = undefined;
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await text({
          initialValue: workspaceDir,
          message: "Workspace directory",
        }),
        runtime,
      );
      workspaceDir = resolveUserPath(
        normalizeOptionalString(String(workspaceInput ?? "")) || DEFAULT_WORKSPACE,
      );
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          note(
            [
              `Existing workspace detected at ${workspaceDir}`,
              "Existing files are preserved. Missing templates may be created, never overwritten.",
            ].join("\n"),
            "Existing workspace",
          );
        }
      }
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessions(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      await noteChannelStatus({ cfg: nextConfig, prompter });
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
          skipConfirm: true,
          skipStatusNote: true,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await text({
          initialValue: String(gatewayPort),
          message: "Gateway port for service install",
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("plugins")) {
        const { configurePluginConfig } = await import("../wizard/setup.plugin-config.js");
        nextConfig = await configurePluginConfig({
          config: nextConfig,
          prompter,
          workspaceDir: resolveUserPath(workspaceDir),
        });
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemon({ port: gatewayPort, runtime });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({ cfg: nextConfig, port: gatewayPort, runtime });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "plugins") {
          const { configurePluginConfig } = await import("../wizard/setup.plugin-config.js");
          nextConfig = await configurePluginConfig({
            config: nextConfig,
            prompter,
            workspaceDir: resolveUserPath(workspaceDir),
          });
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemon({
            port: gatewayPort,
            runtime,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({ cfg: nextConfig, port: gatewayPort, runtime });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No changes selected.");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      basePath: nextConfig.gateway?.controlUi?.basePath,
      bind,
      customBindHost: nextConfig.gateway?.customBindHost,
      port: gatewayPort,
    });
    const newPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        path: "gateway.auth.password",
        value: nextConfig.gateway?.auth?.password,
      }));
    const oldPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: baseConfig,
        path: "gateway.auth.password",
        value: baseConfig.gateway?.auth?.password,
      }));
    const token =
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        path: "gateway.auth.token",
        value: nextConfig.gateway?.auth?.token,
      }));

    let gatewayProbe = await probeGatewayReachable({
      password: newPassword,
      token,
      url: links.wsUrl,
    });
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        password: oldPassword,
        token,
        url: links.wsUrl,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "Gateway: reachable"
      : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    note(
      [
        `Web UI: ${links.httpUrl}`,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro("Configure complete.");
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw error;
  }
}
