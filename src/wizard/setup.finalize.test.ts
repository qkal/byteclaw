import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

const runTui = vi.hoisted(() => vi.fn(async () => {}));
const probeGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const waitForGatewayReachable = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(async () => ({ ok: true })),
);
const setupWizardShellCompletion = vi.hoisted(() => vi.fn(async () => {}));
const buildGatewayInstallPlan = vi.hoisted(() =>
  vi.fn(async () => ({
    environment: {},
    programArguments: [],
    workingDirectory: "/tmp",
  })),
);
const gatewayServiceInstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceRestart = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" } | { outcome: "scheduled" }>>(async () => ({
    outcome: "completed",
  })),
);
const gatewayServiceUninstall = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceIsLoaded = vi.hoisted(() => vi.fn(async () => false));
const resolveGatewayInstallToken = vi.hoisted(() =>
  vi.fn(async () => ({
    token: undefined,
    tokenRefConfigured: true,
    warnings: [],
  })),
);
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));
const readSystemdUserLingerStatus = vi.hoisted(() =>
  vi.fn(async () => ({ linger: "yes" as const, user: "test-user" })),
);
const resolveSetupSecretInputString = vi.hoisted(() =>
  vi.fn<() => Promise<string | undefined>>(async () => undefined),
);
const resolveExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => string | undefined>(() => undefined),
);
const hasExistingKey = vi.hoisted(() =>
  vi.fn<(config: OpenClawConfig, provider: string) => boolean>(() => false),
);
const hasKeyInEnv = vi.hoisted(() =>
  vi.fn<(entry: Pick<PluginWebSearchProviderEntry, "envVars">) => boolean>(() => false),
);
const listConfiguredWebSearchProviders = vi.hoisted(() =>
  vi.fn<(params?: { config?: OpenClawConfig }) => PluginWebSearchProviderEntry[]>(() => []),
);

vi.mock("../commands/onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(async () => ({ ok: false })),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
  openUrl: vi.fn(async () => false),
  probeGatewayReachable,
  resolveControlUiLinks: vi.fn(() => ({
    httpUrl: "http://127.0.0.1:18789",
    wsUrl: "ws://127.0.0.1:18789",
  })),
  waitForGatewayReachable,
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("../commands/gateway-install-token.js", () => ({
  resolveGatewayInstallToken,
}));

vi.mock("../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  GATEWAY_DAEMON_RUNTIME_OPTIONS: [{ label: "Node", value: "node" }],
}));

vi.mock("../commands/health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("../commands/health.js", () => ({
  healthCommand: vi.fn(async () => {}),
}));

vi.mock("../commands/onboard-search.js", () => ({
  hasExistingKey,
  hasKeyInEnv,
  listSearchProviderOptions: () => [],
  resolveExistingKey,
  resolveSearchProviderOptions: () => [],
}));

vi.mock("../web-search/runtime.js", () => ({
  listConfiguredWebSearchProviders,
}));

vi.mock("../daemon/service.js", () => ({
  describeGatewayServiceRestart: vi.fn((serviceNoun: string, result: { outcome: string }) =>
    result.outcome === "scheduled"
      ? {
          daemonActionResult: "scheduled",
          message: `restart scheduled, ${serviceNoun.toLowerCase()} will restart momentarily`,
          progressMessage: `${serviceNoun} service restart scheduled.`,
          scheduled: true,
        }
      : {
          daemonActionResult: "restarted",
          message: `${serviceNoun} service restarted.`,
          progressMessage: `${serviceNoun} service restarted.`,
          scheduled: false,
        },
  ),
  resolveGatewayService: vi.fn(() => ({
    install: gatewayServiceInstall,
    isLoaded: gatewayServiceIsLoaded,
    restart: gatewayServiceRestart,
    uninstall: gatewayServiceUninstall,
  })),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable,
  readSystemdUserLingerStatus,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: vi.fn(),
}));

vi.mock("../tui/tui.js", () => ({
  runTui,
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString,
}));

vi.mock("./setup.completion.js", () => ({
  setupWizardShellCompletion,
}));

import { finalizeSetupWizard } from "./setup.finalize.js";

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createWebSearchProviderEntry(
  provider: Pick<
    PluginWebSearchProviderEntry,
    "id" | "label" | "hint" | "envVars" | "placeholder" | "signupUrl" | "credentialPath"
  >,
): PluginWebSearchProviderEntry {
  return {
    createTool: () => null,
    getCredentialValue: () => undefined,
    pluginId: `plugin-${provider.id}`,
    setCredentialValue: () => {},
    ...provider,
  };
}

function expectFirstOnboardingInstallPlanCallOmitsToken() {
  const [firstArg] =
    (buildGatewayInstallPlan.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
  expect(firstArg).toBeDefined();
  expect(firstArg && "token" in firstArg).toBe(false);
}

interface AdvancedFinalizeArgs {
  nextConfig?: OpenClawConfig;
  prompter?: ReturnType<typeof buildWizardPrompter>;
  runtime?: RuntimeEnv;
  installDaemon?: boolean;
}

function createLaterPrompter() {
  return buildWizardPrompter({
    confirm: vi.fn(async () => false),
    select: vi.fn(async () => "later") as never,
  });
}

function createEnabledFirecrawlSearchConfig(): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          enabled: true,
          provider: "firecrawl",
        },
      },
    },
  };
}

function createAdvancedFinalizeArgs(params: AdvancedFinalizeArgs = {}) {
  return {
    baseConfig: {},
    flow: "advanced" as const,
    nextConfig: params.nextConfig ?? {},
    opts: {
      acceptRisk: true,
      authChoice: "skip" as const,
      installDaemon: params.installDaemon ?? false,
      skipHealth: true,
      skipUi: true,
    },
    prompter: params.prompter ?? createLaterPrompter(),
    runtime: params.runtime ?? createRuntime(),
    settings: {
      authMode: "token" as const,
      bind: "loopback" as const,
      gatewayToken: undefined,
      port: 18_789,
      tailscaleMode: "off" as const,
      tailscaleResetOnExit: false,
    },
    workspaceDir: "/tmp",
  };
}

describe("finalizeSetupWizard", () => {
  beforeEach(() => {
    runTui.mockClear();
    probeGatewayReachable.mockClear();
    waitForGatewayReachable.mockReset();
    waitForGatewayReachable.mockResolvedValue({ ok: true });
    setupWizardShellCompletion.mockClear();
    buildGatewayInstallPlan.mockClear();
    gatewayServiceInstall.mockClear();
    gatewayServiceIsLoaded.mockReset();
    gatewayServiceIsLoaded.mockResolvedValue(false);
    gatewayServiceRestart.mockReset();
    gatewayServiceRestart.mockResolvedValue({ outcome: "completed" });
    gatewayServiceUninstall.mockReset();
    resolveGatewayInstallToken.mockClear();
    isSystemdUserServiceAvailable.mockReset();
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    readSystemdUserLingerStatus.mockReset();
    readSystemdUserLingerStatus.mockResolvedValue({ linger: "yes", user: "test-user" });
    resolveSetupSecretInputString.mockReset();
    resolveSetupSecretInputString.mockResolvedValue(undefined);
    resolveExistingKey.mockReset();
    resolveExistingKey.mockReturnValue(undefined);
    hasExistingKey.mockReset();
    hasExistingKey.mockReturnValue(false);
    hasKeyInEnv.mockReset();
    hasKeyInEnv.mockReturnValue(false);
    listConfiguredWebSearchProviders.mockReset();
    listConfiguredWebSearchProviders.mockReturnValue([]);
  });

  it("resolves gateway password SecretRef for probe and TUI", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_PASSWORD;
    process.env.OPENCLAW_GATEWAY_PASSWORD = "resolved-gateway-password"; // Pragma: allowlist secret
    resolveSetupSecretInputString.mockResolvedValueOnce("resolved-gateway-password");
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "How do you want to hatch your bot?") {
        return "tui";
      }
      return "later";
    });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
      select: select as never,
    });
    const runtime = createRuntime();

    try {
      await finalizeSetupWizard({
        baseConfig: {},
        flow: "quickstart",
        nextConfig: {
          gateway: {
            auth: {
              mode: "password",
              password: {
                id: "OPENCLAW_GATEWAY_PASSWORD",
                provider: "default",
                source: "env",
              },
            },
          },
          tools: {
            web: {
              search: {
                apiKey: "",
              },
            },
          },
        },
        opts: {
          acceptRisk: true,
          authChoice: "skip",
          installDaemon: false,
          skipHealth: true,
          skipUi: false,
        },
        prompter,
        runtime,
        settings: {
          authMode: "password",
          bind: "loopback",
          gatewayToken: undefined,
          port: 18_789,
          tailscaleMode: "off",
          tailscaleResetOnExit: false,
        },
        workspaceDir: "/tmp",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previous;
      }
    }

    expect(probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "resolved-gateway-password",
        url: "ws://127.0.0.1:18789", // Pragma: allowlist secret
      }),
    );
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "resolved-gateway-password",
        url: "ws://127.0.0.1:18789", // Pragma: allowlist secret
      }),
    );
  });

  it("does not persist resolved SecretRef token in daemon install plan", async () => {
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
      select: vi.fn(async () => "later") as never,
    });
    const runtime = createRuntime();

    await finalizeSetupWizard({
      baseConfig: {},
      flow: "advanced",
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: {
              id: "OPENCLAW_GATEWAY_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      },
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      prompter,
      runtime,
      settings: {
        authMode: "token",
        bind: "loopback",
        gatewayToken: "session-token",
        port: 18_789,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      workspaceDir: "/tmp",
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledTimes(1);
    expectFirstOnboardingInstallPlanCallOmitsToken();
    expect(gatewayServiceInstall).toHaveBeenCalledTimes(1);
  });

  it("stops after a scheduled restart instead of reinstalling the service", async () => {
    const progressUpdate = vi.fn();
    const progressStop = vi.fn();
    gatewayServiceIsLoaded.mockResolvedValue(true);
    gatewayServiceRestart.mockResolvedValueOnce({ outcome: "scheduled" });
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ stop: progressStop, update: progressUpdate })),
      select: vi.fn(async (params: { message: string }) => {
        if (params.message === "Gateway service already installed") {
          return "restart";
        }
        return "later";
      }) as never,
    });

    await finalizeSetupWizard({
      baseConfig: {},
      flow: "advanced",
      nextConfig: {},
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: true,
        skipHealth: true,
        skipUi: true,
      },
      prompter,
      runtime: createRuntime(),
      settings: {
        authMode: "token",
        bind: "loopback",
        gatewayToken: undefined,
        port: 18_789,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      workspaceDir: "/tmp",
    });

    expect(gatewayServiceRestart).toHaveBeenCalledTimes(1);
    expect(gatewayServiceInstall).not.toHaveBeenCalled();
    expect(gatewayServiceUninstall).not.toHaveBeenCalled();
    expect(progressUpdate).toHaveBeenCalledWith("Restarting Gateway service…");
    expect(progressStop).toHaveBeenCalledWith("Gateway service restart scheduled.");
  });

  it("reports selected providers blocked by plugin policy as unavailable", async () => {
    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: createEnabledFirecrawlSearchConfig(),
        prompter,
      }),
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("selected but unavailable under the current plugin policy"),
      "Web search",
    );
    expect(resolveExistingKey).not.toHaveBeenCalled();
    expect(hasExistingKey).not.toHaveBeenCalled();
  });

  it("only reports legacy auto-detect for runtime-visible providers", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
        envVars: ["PERPLEXITY_API_KEY"],
        hint: "Fast web answers",
        id: "perplexity",
        label: "Perplexity Search",
        placeholder: "pplx-...",
        signupUrl: "https://www.perplexity.ai/",
      }),
    ]);
    hasExistingKey.mockImplementation((_config, provider) => provider === "perplexity");

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(createAdvancedFinalizeArgs({ prompter }));

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Web search is available via Perplexity Search (auto-detected)."),
      "Web search",
    );
  });

  it("uses configured provider resolution instead of the active runtime registry", async () => {
    listConfiguredWebSearchProviders.mockReturnValue([
      createWebSearchProviderEntry({
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
        envVars: ["FIRECRAWL_API_KEY"],
        hint: "Structured results",
        id: "firecrawl",
        label: "Firecrawl Search",
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
      }),
    ]);
    hasExistingKey.mockImplementation((_config, provider) => provider === "firecrawl");

    const prompter = createLaterPrompter();

    await finalizeSetupWizard(
      createAdvancedFinalizeArgs({
        nextConfig: createEnabledFirecrawlSearchConfig(),
        prompter,
      }),
    );

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Web search is enabled, so your agent can look things up online when needed.",
      ),
      "Web search",
    );
  });

  it("shows actionable gateway guidance instead of a hard error in no-daemon onboarding", async () => {
    waitForGatewayReachable.mockResolvedValue({
      detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
      ok: false,
    });
    probeGatewayReachable.mockResolvedValue({
      detail: "gateway closed (1006 abnormal closure (no close frame)): no close reason",
      ok: false,
    });
    const prompter = createLaterPrompter();
    const runtime = createRuntime();

    await finalizeSetupWizard({
      baseConfig: {},
      flow: "quickstart",
      nextConfig: {},
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: false,
        skipUi: false,
      },
      prompter,
      runtime,
      settings: {
        authMode: "token",
        bind: "loopback",
        gatewayToken: "test-token",
        port: 18_789,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      workspaceDir: "/tmp",
    });

    expect(runtime.error).not.toHaveBeenCalledWith("health failed");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Setup was run without Gateway service install"),
      "Gateway",
    );
    expect(prompter.note).not.toHaveBeenCalledWith(expect.any(String), "Dashboard ready");
  });

  it("does not show a Codex native search summary when web search is globally disabled", async () => {
    const note = vi.fn(async () => {});
    const prompter = buildWizardPrompter({
      confirm: vi.fn(async () => false),
      note,
      select: vi.fn(async () => "later") as never,
    });

    await finalizeSetupWizard({
      baseConfig: {},
      flow: "advanced",
      nextConfig: {
        tools: {
          web: {
            search: {
              enabled: false,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      opts: {
        acceptRisk: true,
        authChoice: "skip",
        installDaemon: false,
        skipHealth: true,
        skipUi: true,
      },
      prompter,
      runtime: createRuntime(),
      settings: {
        authMode: "token",
        bind: "loopback",
        gatewayToken: undefined,
        port: 18_789,
        tailscaleMode: "off",
        tailscaleResetOnExit: false,
      },
      workspaceDir: "/tmp",
    });

    expect(note).not.toHaveBeenCalledWith(
      expect.stringContaining("Codex native search:"),
      "Codex native search",
    );
  });
});
