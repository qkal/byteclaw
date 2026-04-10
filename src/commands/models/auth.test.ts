import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clackCancel: vi.fn(),
  clackConfirm: vi.fn(),
  clackIsCancel: vi.fn((value: unknown) => value === Symbol.for("clack:cancel")),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clearAuthProfileCooldown: vi.fn(),
  createClackPrompter: vi.fn(),
  isRemoteEnvironment: vi.fn(() => false),
  listProfilesForProvider: vi.fn(),
  loadAuthProfileStoreForRuntime: vi.fn(),
  loadValidConfigOrThrow: vi.fn(),
  logConfigUpdated: vi.fn(),
  openUrl: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  resolvePluginProviders: vi.fn(),
  updateConfig: vi.fn(),
  upsertAuthProfile: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
  listProfilesForProvider: mocks.listProfilesForProvider,
  loadAuthProfileStoreForRuntime: mocks.loadAuthProfileStoreForRuntime,
  upsertAuthProfile: mocks.upsertAuthProfile,
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  confirm: mocks.clackConfirm,
  isCancel: mocks.clackIsCancel,
  select: mocks.clackSelect,
  text: mocks.clackText,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("./shared.js", async (importActual) => {
  const actual = await importActual<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("../oauth-env.js", () => ({
  isRemoteEnvironment: mocks.isRemoteEnvironment,
}));

const { modelsAuthLoginCommand, modelsAuthPasteTokenCommand, modelsAuthSetupTokenCommand } =
  await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function withInteractiveStdin() {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    enumerable: true,
    get: () => true,
  });
  return () => {
    if (previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else if (!hadOwnIsTTY) {
      delete (stdin as { isTTY?: boolean }).isTTY;
    }
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: "OAuth",
        run: params.run,
      },
    ],
    id: params.id,
    label: params.label ?? params.id,
  };
}

describe("modelsAuthLoginCommand", () => {
  let restoreStdin: (() => void) | null = null;
  let currentConfig: OpenClawConfig;
  let lastUpdatedConfig: OpenClawConfig | null;
  let runProviderAuth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreStdin = withInteractiveStdin();
    currentConfig = {};
    lastUpdatedConfig = null;
    mocks.clackCancel.mockReset();
    mocks.clackConfirm.mockReset();
    mocks.clackIsCancel.mockImplementation(
      (value: unknown) => value === Symbol.for("clack:cancel"),
    );
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.upsertAuthProfile.mockReset();

    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.isRemoteEnvironment.mockReturnValue(false);
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.updateConfig.mockImplementation(
      async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        lastUpdatedConfig = mutator(currentConfig);
        currentConfig = lastUpdatedConfig;
        return lastUpdatedConfig;
      },
    );
    mocks.createClackPrompter.mockReturnValue({
      note: vi.fn(async () => {}),
      select: vi.fn(),
    });
    runProviderAuth = vi.fn().mockResolvedValue({
      defaultModel: "openai-codex/gpt-5.4",
      profiles: [
        {
          credential: {
            access: "access-token",
            email: "user@example.com",
            expires: Date.now() + 60_000,
            provider: "openai-codex",
            refresh: "refresh-token",
            type: "oauth",
          },
          profileId: "openai-codex:user@example.com",
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai-codex",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.clearAuthProfileCooldown.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreStdin?.();
    restoreStdin = null;
  });

  it("runs plugin-owned openai-codex login", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      credential: expect.objectContaining({
        provider: "openai-codex",
        type: "oauth",
      }),
      profileId: "openai-codex:user@example.com",
    });
    expect(lastUpdatedConfig?.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      mode: "oauth",
      provider: "openai-codex",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Auth profile: openai-codex:user@example.com (openai-codex/oauth)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Default model available: openai-codex/gpt-5.4 (use --set-default to apply)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
    );
  });

  it("applies openai-codex default model when --set-default is used", async () => {
    const runtime = createRuntime();

    await modelsAuthLoginCommand({ provider: "openai-codex", setDefault: true }, runtime);

    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to openai-codex/gpt-5.4");
  });

  it("supports provider-owned Claude CLI migration without writing auth profiles", async () => {
    const runtime = createRuntime();
    const runClaudeCliMigration = vi.fn().mockResolvedValue({
      configPatch: {
        agents: {
          defaults: {
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
      defaultModel: "claude-cli/claude-sonnet-4-6",
      profiles: [],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "cli",
            kind: "custom",
            label: "Claude CLI",
            run: runClaudeCliMigration,
          },
        ],
        id: "anthropic",
        label: "Anthropic",
      },
    ]);

    await modelsAuthLoginCommand(
      { method: "cli", provider: "anthropic", setDefault: true },
      runtime,
    );

    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      primary: "claude-cli/claude-sonnet-4-6",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "claude-cli/claude-sonnet-4-6": {},
    });
    expect(runtime.log).toHaveBeenCalledWith("Default model set to claude-cli/claude-sonnet-4-6");
  });

  it("loads the owning plugin for an explicit provider even in a clean config", async () => {
    const runtime = createRuntime();
    const runClaudeCliMigration = vi.fn().mockResolvedValue({
      configPatch: {
        agents: {
          defaults: {
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
      },
      defaultModel: "claude-cli/claude-sonnet-4-6",
      profiles: [],
    });
    mocks.resolvePluginProviders.mockImplementation(
      (params: { activate?: boolean; providerRefs?: string[] } | undefined) =>
        params?.activate === true && params?.providerRefs?.[0] === "anthropic"
          ? [
              {
                auth: [
                  {
                    id: "cli",
                    kind: "custom",
                    label: "Claude CLI",
                    run: runClaudeCliMigration,
                  },
                ],
                id: "anthropic",
                label: "Anthropic",
              },
            ]
          : [],
    );

    await modelsAuthLoginCommand(
      { method: "cli", provider: "anthropic", setDefault: true },
      runtime,
    );

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: true,
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
        config: {},
        providerRefs: ["anthropic"],
        workspaceDir: "/tmp/openclaw/workspace",
      }),
    );
    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
  });

  it("runs the requested anthropic cli auth method with the full login context", async () => {
    const runtime = createRuntime();
    currentConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
            primary: "anthropic/claude-sonnet-4-6",
          },
          models: {
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };
    const note = vi.fn(async () => {});
    mocks.createClackPrompter.mockReturnValue({
      note,
      select: vi.fn(),
    });
    const runApiKeyAuth = vi.fn();
    const runClaudeCliMigration = vi.fn().mockImplementation(async (ctx) => {
      expect(ctx.config).toEqual(currentConfig);
      expect(ctx.agentDir).toBe("/tmp/openclaw/agents/main");
      expect(ctx.workspaceDir).toBe("/tmp/openclaw/workspace");
      expect(ctx.prompter).toMatchObject({ note, select: expect.any(Function) });
      expect(ctx.runtime).toBe(runtime);
      expect(ctx.env).toBe(process.env);
      expect(ctx.allowSecretRefPrompt).toBe(false);
      expect(ctx.isRemote).toBe(false);
      expect(ctx.openUrl).toEqual(expect.any(Function));
      expect(ctx.oauth).toMatchObject({
        createVpsAwareHandlers: expect.any(Function),
      });
      return {
        configPatch: {
          agents: {
            defaults: {
              model: {
                fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
                primary: "claude-cli/claude-sonnet-4-6",
              },
              models: {
                "claude-cli/claude-opus-4-6": { alias: "Opus" },
                "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
                "openai/gpt-5.2": {},
              },
            },
          },
        },
        defaultModel: "claude-cli/claude-sonnet-4-6",
        notes: [
          "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
          "Existing Anthropic auth profiles are kept for rollback.",
        ],
        profiles: [],
      };
    });
    const fakeStore = {
      profiles: {
        "anthropic:claude-cli": {
          provider: "anthropic",
          type: "oauth",
        },
        "anthropic:legacy": {
          provider: "anthropic",
          type: "token",
        },
      },
      usageStats: {
        "anthropic:claude-cli": {
          disabledReason: "auth_permanent",
          disabledUntil: Date.now() + 3_600_000,
          errorCount: 2,
        },
      },
    };
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(fakeStore);
    mocks.listProfilesForProvider.mockReturnValue(["anthropic:claude-cli", "anthropic:legacy"]);
    mocks.resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "cli",
            kind: "custom",
            label: "Claude CLI",
            run: runClaudeCliMigration,
          },
          {
            id: "api-key",
            kind: "api_key",
            label: "Anthropic API key",
            run: runApiKeyAuth,
          },
        ],
        id: "anthropic",
        label: "Anthropic",
      },
    ]);

    await modelsAuthLoginCommand(
      { method: "cli", provider: "anthropic", setDefault: true },
      runtime,
    );

    expect(runClaudeCliMigration).toHaveBeenCalledOnce();
    expect(runApiKeyAuth).not.toHaveBeenCalled();
    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledTimes(2);
    expect(mocks.clearAuthProfileCooldown).toHaveBeenNthCalledWith(1, {
      agentDir: "/tmp/openclaw/agents/main",
      profileId: "anthropic:claude-cli",
      store: fakeStore,
    });
    expect(mocks.clearAuthProfileCooldown).toHaveBeenNthCalledWith(2, {
      agentDir: "/tmp/openclaw/agents/main",
      profileId: "anthropic:legacy",
      store: fakeStore,
    });
    expect(
      mocks.clearAuthProfileCooldown.mock.invocationCallOrder.every(
        (order) => order < runClaudeCliMigration.mock.invocationCallOrder[0],
      ),
    ).toBe(true);
    expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
    expect(lastUpdatedConfig?.agents?.defaults?.model).toEqual({
      fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
      primary: "claude-cli/claude-sonnet-4-6",
    });
    expect(lastUpdatedConfig?.agents?.defaults?.models).toEqual({
      "claude-cli/claude-opus-4-6": { alias: "Opus" },
      "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
      "openai/gpt-5.2": {},
    });
    expect(note).toHaveBeenCalledWith(
      [
        "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
        "Existing Anthropic auth profiles are kept for rollback.",
      ].join("\n"),
      "Provider notes",
    );
    expect(runtime.log).toHaveBeenCalledWith("Default model set to claude-cli/claude-sonnet-4-6");
  });

  it("clears stale auth lockouts before attempting openai-codex login", async () => {
    const runtime = createRuntime();
    const fakeStore = {
      profiles: {
        "openai-codex:user@example.com": {
          provider: "openai-codex",
          type: "oauth",
        },
      },
      usageStats: {
        "openai-codex:user@example.com": {
          disabledReason: "auth_permanent",
          disabledUntil: Date.now() + 3_600_000,
          errorCount: 3,
        },
      },
    };
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue(fakeStore);
    mocks.listProfilesForProvider.mockReturnValue(["openai-codex:user@example.com"]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      profileId: "openai-codex:user@example.com",
      store: fakeStore,
    });
    // Verify clearing happens before login attempt
    const clearOrder = mocks.clearAuthProfileCooldown.mock.invocationCallOrder[0];
    const loginOrder = runProviderAuth.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(loginOrder);
  });

  it("survives lockout clearing failure without blocking login", async () => {
    const runtime = createRuntime();
    mocks.loadAuthProfileStoreForRuntime.mockImplementation(() => {
      throw new Error("corrupt auth-profiles.json");
    });

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(runProviderAuth).toHaveBeenCalledOnce();
  });

  it("loads lockout state from the agent-scoped store", async () => {
    const runtime = createRuntime();
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {}, usageStats: {} });
    mocks.listProfilesForProvider.mockReturnValue([]);

    await modelsAuthLoginCommand({ provider: "openai-codex" }, runtime);

    expect(mocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/tmp/openclaw/agents/main");
  });

  it("reports loaded plugin providers when requested provider is unavailable", async () => {
    const runtime = createRuntime();

    await expect(modelsAuthLoginCommand({ provider: "anthropic" }, runtime)).rejects.toThrow(
      'Unknown provider "anthropic". Loaded providers: openai-codex. Verify plugins via `openclaw plugins list --json`.',
    );
  });

  it("does not persist a cancelled manual token entry", async () => {
    const runtime = createRuntime();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${String(code ?? "")}`);
    }) as typeof process.exit);
    try {
      const cancelSymbol = Symbol.for("clack:cancel");
      mocks.clackText.mockResolvedValue(cancelSymbol);
      mocks.clackIsCancel.mockImplementation((value: unknown) => value === cancelSymbol);

      await expect(modelsAuthPasteTokenCommand({ provider: "openai" }, runtime)).rejects.toThrow(
        "exit:0",
      );

      expect(mocks.upsertAuthProfile).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("writes pasted tokens to the resolved agent store", async () => {
    const runtime = createRuntime();
    mocks.clackText.mockResolvedValue("tok-fresh");

    await modelsAuthPasteTokenCommand({ provider: "openai" }, runtime);

    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      credential: {
        provider: "openai",
        token: "tok-fresh",
        type: "token",
      },
      profileId: "openai:manual",
    });
  });

  it("writes pasted Anthropic setup-tokens and logs the preference note", async () => {
    const runtime = createRuntime();
    mocks.clackText.mockResolvedValue(`sk-ant-oat01-${"a".repeat(80)}`);

    await modelsAuthPasteTokenCommand({ provider: "anthropic" }, runtime);

    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      credential: {
        provider: "anthropic",
        token: `sk-ant-oat01-${"a".repeat(80)}`,
        type: "token",
      },
      profileId: "anthropic:manual",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic setup-token auth is supported in OpenClaw.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "OpenClaw prefers Claude CLI reuse when it is available on the host.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Anthropic staff told us this OpenClaw path is allowed again.",
    );
  });

  it("runs token auth for any token-capable provider plugin", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          credential: {
            provider: "moonshot",
            token: "moonshot-token",
            type: "token",
          },
          profileId: "moonshot:token",
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "setup-token",
            kind: "token",
            label: "setup-token",
            run: runTokenAuth,
          },
        ],
        id: "moonshot",
        label: "Moonshot",
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "moonshot", yes: true }, runtime);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      credential: {
        provider: "moonshot",
        token: "moonshot-token",
        type: "token",
      },
      profileId: "moonshot:token",
    });
  });

  it("runs setup-token for Anthropic when the provider exposes the method", async () => {
    const runtime = createRuntime();
    const runTokenAuth = vi.fn().mockResolvedValue({
      defaultModel: "anthropic/claude-sonnet-4-6",
      profiles: [
        {
          credential: {
            provider: "anthropic",
            token: `sk-ant-oat01-${"b".repeat(80)}`,
            type: "token",
          },
          profileId: "anthropic:default",
        },
      ],
    });
    mocks.resolvePluginProviders.mockReturnValue([
      {
        auth: [
          {
            id: "setup-token",
            kind: "token",
            label: "setup-token",
            run: runTokenAuth,
          },
        ],
        id: "anthropic",
        label: "Anthropic",
      },
    ]);

    await modelsAuthSetupTokenCommand({ provider: "anthropic", yes: true }, runtime);

    expect(runTokenAuth).toHaveBeenCalledOnce();
    expect(mocks.upsertAuthProfile).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      credential: {
        provider: "anthropic",
        token: `sk-ant-oat01-${"b".repeat(80)}`,
        type: "token",
      },
      profileId: "anthropic:default",
    });
  });
});
