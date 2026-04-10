import { capturePluginRegistration } from "openclaw/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { readClaudeCliCredentialsForSetupMock, readClaudeCliCredentialsForRuntimeMock } = vi.hoisted(
  () => ({
    readClaudeCliCredentialsForRuntimeMock: vi.fn(),
    readClaudeCliCredentialsForSetupMock: vi.fn(),
  }),
);

vi.mock("./cli-auth-seam.js", () => ({
  readClaudeCliCredentialsForRuntime: readClaudeCliCredentialsForRuntimeMock,
  readClaudeCliCredentialsForSetup: readClaudeCliCredentialsForSetupMock,
}));

import anthropicPlugin from "./index.js";

describe("anthropic provider replay hooks", () => {
  it("registers the claude-cli backend", async () => {
    const captured = capturePluginRegistration({ register: anthropicPlugin.register });

    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
        id: "claude-cli",
      }),
    );
  });

  it("owns native reasoning output mode for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
        provider: "anthropic",
      } as never),
    ).toEqual({
      allowSyntheticToolResults: true,
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
  });

  it("defaults provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "anthropic",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("applies Anthropic pruning defaults through plugin hooks", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
        auth: {
          profiles: {
            "anthropic:api": { mode: "api_key", provider: "anthropic" },
          },
        },
      },
      env: {},
      provider: "anthropic",
    } as never);

    expect(next?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills Claude CLI allowlist defaults through plugin hooks for older configs", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      config: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-sonnet-4-6" },
            models: {
              "claude-cli/claude-sonnet-4-6": {},
            },
          },
        },
        auth: {
          profiles: {
            "anthropic:claude-cli": { mode: "oauth", provider: "claude-cli" },
          },
        },
      },
      env: {},
      provider: "anthropic",
    } as never);

    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "1h",
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      "claude-cli/claude-haiku-4-5": {},
      "claude-cli/claude-opus-4-5": {},
      "claude-cli/claude-opus-4-6": {},
      "claude-cli/claude-sonnet-4-5": {},
      "claude-cli/claude-sonnet-4-6": {},
    });
  });

  it("resolves claude-cli synthetic oauth auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      access: "access-token",
      expires: 123,
      provider: "anthropic",
      refresh: "refresh-token",
      type: "oauth",
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      mode: "oauth",
      source: "Claude CLI native auth",
    });
    expect(readClaudeCliCredentialsForRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves claude-cli synthetic token auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      expires: 123,
      provider: "anthropic",
      token: "bearer-token",
      type: "token",
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "bearer-token",
      mode: "token",
      source: "Claude CLI native auth",
    });
  });

  it("stores a claude-cli auth profile during anthropic cli migration", async () => {
    readClaudeCliCredentialsForSetupMock.mockReset();
    readClaudeCliCredentialsForSetupMock.mockReturnValue({
      access: "setup-access-token",
      expires: 123,
      provider: "anthropic",
      refresh: "refresh-token",
      type: "oauth",
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const cliAuth = provider.auth.find((entry) => entry.id === "cli");

    expect(cliAuth).toBeDefined();

    const result = await cliAuth?.run({
      config: {},
    } as never);

    expect(result?.profiles).toEqual([
      {
        credential: {
          access: "setup-access-token",
          expires: 123,
          provider: "claude-cli",
          refresh: "refresh-token",
          type: "oauth",
        },
        profileId: "anthropic:claude-cli",
      },
    ]);
  });
});
