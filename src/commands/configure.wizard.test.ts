import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => {
  const writeConfigFile = vi.fn();
  return {
    clackConfirm: vi.fn(),
    clackIntro: vi.fn(),
    clackOutro: vi.fn(),
    clackSelect: vi.fn(),
    clackText: vi.fn(),
    createClackPrompter: vi.fn(),
    ensureControlUiAssetsBuilt: vi.fn(),
    note: vi.fn(),
    printWizardHeader: vi.fn(),
    probeGatewayReachable: vi.fn(),
    readConfigFileSnapshot: vi.fn(),
    replaceConfigFile: vi.fn(async (params: { nextConfig: unknown }) => {
      await writeConfigFile(params.nextConfig);
    }),
    resolveControlUiLinks: vi.fn(),
    resolveGatewayPort: vi.fn(),
    resolveSearchProviderOptions: vi.fn(),
    setupSearch: vi.fn(),
    summarizeExistingConfig: vi.fn(),
    waitForGatewayReachable: vi.fn(),
    writeConfigFile,
  };
});

vi.mock("@clack/prompts", () => ({
  confirm: mocks.clackConfirm,
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: <T>(value: T) => value,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: vi.fn(),
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: vi.fn(),
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: vi.fn(),
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: vi.fn(),
}));

vi.mock("./onboard-search.js", () => ({
  resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
  setupSearch: mocks.setupSearch,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { runConfigureWizard } from "./configure.wizard.js";

const EMPTY_CONFIG_SNAPSHOT = {
  config: {},
  exists: false,
  issues: [],
  valid: true,
};

function createRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createSearchProviderOption(overrides: Record<string, unknown>) {
  return overrides;
}

function createEnabledWebSearchConfig(provider: string, pluginEntry: Record<string, unknown>) {
  return (cfg: OpenClawConfig) => ({
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [provider]: pluginEntry,
      },
    },
    tools: {
      ...cfg.tools,
      web: {
        ...cfg.tools?.web,
        search: {
          enabled: true,
          provider,
        },
      },
    },
  });
}

function setupBaseWizardState(config: OpenClawConfig = {}) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...EMPTY_CONFIG_SNAPSHOT,
    config,
  });
  mocks.resolveGatewayPort.mockReturnValue(18_789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  mocks.summarizeExistingConfig.mockReturnValue("");
  mocks.createClackPrompter.mockReturnValue({
    confirm: vi.fn(async () => true),
    intro: vi.fn(async () => {}),
    multiselect: vi.fn(async () => []),
    note: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    select: vi.fn(async () => "firecrawl"),
    text: vi.fn(async () => ""),
  });
}

function queueWizardPrompts(params: { select: string[]; confirm: boolean[]; text?: string }) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  mocks.clackText.mockResolvedValue(params.text ?? "");
  mocks.clackIntro.mockResolvedValue(undefined);
  mocks.clackOutro.mockResolvedValue(undefined);
}

async function runWebConfigureWizard() {
  await runConfigureWizard({ command: "configure", sections: ["web"] }, createRuntime());
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        credentialLabel: "Firecrawl API key",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
        envVars: ["FIRECRAWL_API_KEY"],
        hint: "Structured results with optional result scraping",
        id: "firecrawl",
        label: "Firecrawl Search",
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
      },
    ]);
    mocks.setupSearch.mockReset();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => cfg);
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      confirm: [false],
      select: ["local", "__continue"],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("persists provider-owned web search config changes returned by setupSearch", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("firecrawl", {
        config: { webSearch: { apiKey: "fc-entered-key" } },
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      confirm: [true, false],
      select: ["local"],
    });

    await runWebConfigureWizard();

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              config: expect.objectContaining({
                webSearch: expect.objectContaining({ apiKey: "fc-entered-key" }),
              }),
              enabled: true,
            }),
          }),
        }),
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              provider: "firecrawl",
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("delegates provider selection to the shared search setup flow", async () => {
    setupBaseWizardState();
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      confirm: [true, false],
      select: ["local"],
    });

    await runWebConfigureWizard();

    expect(mocks.setupSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              enabled: true,
            }),
          }),
        }),
      }),
    );
  });

  it("does not crash when web search providers are unavailable under plugin policy", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({
      confirm: [true, false],
      select: ["local"],
    });

    await expect(runWebConfigureWizard()).resolves.toBeUndefined();

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "No web search providers are currently available under this plugin policy.",
      ),
      "Web search",
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: false,
            }),
          }),
        }),
      }),
    );
  });

  it("still supports keyless web search providers through the shared setup flow", async () => {
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([
      createSearchProviderOption({
        credentialPath: "",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        envVars: [],
        hint: "Free fallback",
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        placeholder: "(no key needed)",
        requiresCredential: false,
        signupUrl: "https://duckduckgo.com/",
      }),
    ]);
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) =>
      createEnabledWebSearchConfig("duckduckgo", {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      confirm: [true, false],
      select: ["local"],
    });

    await runWebConfigureWizard();

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("can enable native Codex search without configuring a managed provider", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai-codex:default": {
            mode: "oauth",
            provider: "openai-codex",
          },
        },
      },
    });
    queueWizardPrompts({
      confirm: [true, true, false, true],
      select: ["local", "cached"],
    });

    await runWebConfigureWizard();

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              openaiCodex: expect.objectContaining({
                enabled: true,
                mode: "cached",
              }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupSearch).not.toHaveBeenCalled();
  });

  it("preserves disabled native Codex search when toggled off", async () => {
    setupBaseWizardState({
      auth: {
        profiles: {
          "openai-codex:default": {
            mode: "oauth",
            provider: "openai-codex",
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            openaiCodex: {
              enabled: true,
              mode: "live",
            },
          },
        },
      },
    });
    queueWizardPrompts({
      confirm: [true, false, true, false],
      select: ["firecrawl"],
    });

    await runWebConfigureWizard();

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              openaiCodex: expect.objectContaining({
                enabled: false,
                mode: "live",
              }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });
});
