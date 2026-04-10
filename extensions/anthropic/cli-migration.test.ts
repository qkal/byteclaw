import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

const { readClaudeCliCredentialsForSetup, readClaudeCliCredentialsForSetupNonInteractive } =
  vi.hoisted(() => ({
    readClaudeCliCredentialsForSetup: vi.fn(),
    readClaudeCliCredentialsForSetupNonInteractive: vi.fn(),
  }));

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsForSetup,
    readClaudeCliCredentialsForSetupNonInteractive,
  };
});

const { buildAnthropicCliMigrationResult, hasClaudeCliAuth } = await import("./cli-migration.js");
const { registerSingleProviderPlugin } =
  await import("../../test/helpers/plugins/plugin-registration.js");
const { createTestWizardPrompter } = await import("../../test/helpers/plugins/setup-wizard.js");
const { default: anthropicPlugin } = await import("./index.js");

async function resolveAnthropicCliAuthMethod() {
  const provider = await registerSingleProviderPlugin(anthropicPlugin);
  const method = provider.auth.find((entry) => entry.id === "cli");
  if (!method) {
    throw new Error("anthropic cli auth method missing");
  }
  return method;
}

function createProviderAuthContext(
  config: ProviderAuthContext["config"] = {},
): ProviderAuthContext {
  return {
    agentDir: "/tmp/openclaw/agents/main",
    allowSecretRefPrompt: false,
    config,
    env: {},
    isRemote: false,
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
    openUrl: vi.fn(),
    opts: {},
    prompter: createTestWizardPrompter(),
    runtime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    },
    workspaceDir: "/tmp/openclaw/workspace",
  };
}

function createProviderAuthMethodNonInteractiveContext(
  config: ProviderAuthMethodNonInteractiveContext["config"] = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    agentDir: "/tmp/openclaw/agents/main",
    authChoice: "anthropic-cli",
    baseConfig: config,
    config,
    opts: {},
    resolveApiKey: vi.fn(async () => null),
    runtime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    },
    toApiKeyCredential: vi.fn(() => null),
    workspaceDir: "/tmp/openclaw/workspace",
  };
}

describe("anthropic cli migration", () => {
  it("detects local Claude CLI auth", () => {
    readClaudeCliCredentialsForSetup.mockReturnValue({ type: "oauth" });

    expect(hasClaudeCliAuth()).toBe(true);
  });

  it("uses the non-interactive Claude auth probe without keychain prompts", () => {
    readClaudeCliCredentialsForSetup.mockReset();
    readClaudeCliCredentialsForSetupNonInteractive.mockReset();
    readClaudeCliCredentialsForSetup.mockReturnValue(null);
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue({ type: "oauth" });

    expect(hasClaudeCliAuth({ allowKeychainPrompt: false })).toBe(true);
    expect(readClaudeCliCredentialsForSetup).not.toHaveBeenCalled();
    expect(readClaudeCliCredentialsForSetupNonInteractive).toHaveBeenCalledTimes(1);
  });

  it("rewrites anthropic defaults to claude-cli defaults", () => {
    const result = buildAnthropicCliMigrationResult({
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
    });

    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
            primary: "claude-cli/claude-sonnet-4-6",
          },
          models: {
            "claude-cli/claude-haiku-4-5": {},
            "claude-cli/claude-opus-4-5": {},
            "claude-cli/claude-opus-4-6": { alias: "Opus" },
            "claude-cli/claude-sonnet-4-5": {},
            "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    });
  });

  it("adds a Claude CLI default when no anthropic default is present", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: {
            "openai/gpt-5.2": {},
          },
        },
      },
    });

    expect(result.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "claude-cli/claude-haiku-4-5": {},
            "claude-cli/claude-opus-4-5": {},
            "claude-cli/claude-opus-4-6": {},
            "claude-cli/claude-sonnet-4-5": {},
            "claude-cli/claude-sonnet-4-6": {},
            "openai/gpt-5.2": {},
          },
        },
      },
    });
  });

  it("backfills the Claude CLI allowlist when older configs only stored sonnet", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-sonnet-4-6" },
          models: {
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    });

    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "claude-cli/claude-haiku-4-5": {},
            "claude-cli/claude-opus-4-5": {},
            "claude-cli/claude-opus-4-6": {},
            "claude-cli/claude-sonnet-4-5": {},
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    });
  });

  it("registered cli auth tells users to run claude auth login when local auth is missing", async () => {
    readClaudeCliCredentialsForSetup.mockReturnValue(null);
    const method = await resolveAnthropicCliAuthMethod();

    await expect(method.run(createProviderAuthContext())).rejects.toThrow(
      [
        "Claude CLI is not authenticated on this host.",
        "Run claude auth login first, then re-run this setup.",
      ].join("\n"),
    );
  });

  it("registered cli auth returns the same migration result as the builder", async () => {
    const credential = {
      access: "access-token",
      expires: Date.now() + 60_000,
      provider: "anthropic",
      refresh: "refresh-token",
      type: "oauth",
    } as const;
    readClaudeCliCredentialsForSetup.mockReturnValue(credential);
    const method = await resolveAnthropicCliAuthMethod();
    const config = {
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

    await expect(method.run(createProviderAuthContext(config))).resolves.toEqual(
      buildAnthropicCliMigrationResult(config, credential),
    );
  });

  it("stores a claude-cli oauth profile when Claude CLI credentials are available", () => {
    const result = buildAnthropicCliMigrationResult(
      {},
      {
        access: "access-token",
        expires: 123,
        provider: "anthropic",
        refresh: "refresh-token",
        type: "oauth",
      },
    );

    expect(result.profiles).toEqual([
      {
        credential: {
          access: "access-token",
          expires: 123,
          provider: "claude-cli",
          refresh: "refresh-token",
          type: "oauth",
        },
        profileId: "anthropic:claude-cli",
      },
    ]);
  });

  it("stores a claude-cli token profile when Claude CLI only exposes a bearer token", () => {
    const result = buildAnthropicCliMigrationResult(
      {},
      {
        expires: 123,
        provider: "anthropic",
        token: "bearer-token",
        type: "token",
      },
    );

    expect(result.profiles).toEqual([
      {
        credential: {
          expires: 123,
          provider: "claude-cli",
          token: "bearer-token",
          type: "token",
        },
        profileId: "anthropic:claude-cli",
      },
    ]);
  });

  it("registered non-interactive cli auth rewrites anthropic fallbacks before setting the claude-cli default", async () => {
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue({
      access: "access-token",
      expires: Date.now() + 60_000,
      provider: "anthropic",
      refresh: "refresh-token",
      type: "oauth",
    });
    const method = await resolveAnthropicCliAuthMethod();
    const config = {
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

    await expect(
      method.runNonInteractive?.(createProviderAuthMethodNonInteractiveContext(config)),
    ).resolves.toMatchObject({
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
    });
  });

  it("registered non-interactive cli auth reports missing local auth and exits cleanly", async () => {
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue(null);
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthMethodNonInteractiveContext();

    await expect(method.runNonInteractive?.(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        "Run claude auth login first.",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });
});
