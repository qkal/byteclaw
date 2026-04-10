import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { describe, expect, it, vi } from "vitest";
import { registerDreamingCommand } from "./dreaming-command.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveStoredDreaming(config: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(config.plugins?.entries?.["memory-core"]);
  const pluginConfig = asRecord(entry?.config);
  return asRecord(pluginConfig?.dreaming) ?? {};
}

function createHarness(initialConfig: OpenClawConfig = {}) {
  let command: OpenClawPluginCommandDefinition | undefined;
  let runtimeConfig: OpenClawConfig = initialConfig;

  const runtime = {
    config: {
      loadConfig: vi.fn(() => runtimeConfig),
      writeConfigFile: vi.fn(async (nextConfig: OpenClawConfig) => {
        runtimeConfig = nextConfig;
      }),
    },
  } as unknown as OpenClawPluginApi["runtime"];

  const api = {
    registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
      command = definition;
    }),
    runtime,
  } as unknown as OpenClawPluginApi;

  registerDreamingCommand(api);

  if (!command) {
    throw new Error("memory-core did not register /dreaming");
  }

  return {
    command,
    getRuntimeConfig: () => runtimeConfig,
    runtime,
  };
}

function createCommandContext(
  args?: string,
  overrides?: Partial<Pick<PluginCommandContext, "gatewayClientScopes">>,
): PluginCommandContext {
  return {
    args,
    channel: "webchat",
    commandBody: args ? `/dreaming ${args}` : "/dreaming",
    config: {},
    detachConversationBinding: async () => ({ removed: false }),
    gatewayClientScopes: overrides?.gatewayClientScopes,
    getCurrentConversationBinding: async () => null,
    isAuthorizedSender: true,
    requestConversationBinding: async () => ({ message: "unsupported", status: "error" }),
  };
}

describe("memory-core /dreaming command", () => {
  it("registers with an enable/disable description", () => {
    const { command } = createHarness();
    expect(command.name).toBe("dreaming");
    expect(command.acceptsArgs).toBe(true);
    expect(command.description).toContain("Enable or disable");
  });

  it("shows phase explanations when invoked without args", async () => {
    const { command } = createHarness();
    const result = await command.handler(createCommandContext());

    expect(result.text).toContain("Usage: /dreaming status");
    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- implementation detail: each sweep runs light -> REM -> deep.");
    expect(result.text).toContain(
      "- deep is the only stage that writes durable entries to MEMORY.md.",
    );
  });

  it("persists global enablement under plugins.entries.memory-core.config.dreaming.enabled", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                frequency: "0 */6 * * *",
                phases: {
                  deep: {
                    minScore: 0.9,
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("off"));

    expect(runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig())).toMatchObject({
      enabled: false,
      frequency: "0 */6 * * *",
    });
    expect(result.text).toContain("Dreaming disabled.");
  });

  it("blocks unscoped gateway callers from persisting dreaming config", async () => {
    const { command, runtime } = createHarness();

    const result = await command.handler(
      createCommandContext("off", {
        gatewayClientScopes: [],
      }),
    );

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("blocks write-scoped gateway callers from persisting dreaming config", async () => {
    const { command, runtime } = createHarness();

    const result = await command.handler(
      createCommandContext("off", {
        gatewayClientScopes: ["operator.write"],
      }),
    );

    expect(result.text).toContain("requires operator.admin");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows admin-scoped gateway callers to persist dreaming config", async () => {
    const { command, runtime, getRuntimeConfig } = createHarness();

    const result = await command.handler(
      createCommandContext("on", {
        gatewayClientScopes: ["operator.admin"],
      }),
    );

    expect(runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(resolveStoredDreaming(getRuntimeConfig())).toMatchObject({
      enabled: true,
    });
    expect(result.text).toContain("Dreaming enabled.");
  });

  it("returns status without mutating config", async () => {
    const { command, runtime } = createHarness({
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                frequency: "15 */8 * * *",
              },
            },
          },
        },
      },
    });

    const result = await command.handler(createCommandContext("status"));

    expect(result.text).toContain("Dreaming status:");
    expect(result.text).toContain("- enabled: off (America/Los_Angeles)");
    expect(result.text).toContain("- sweep cadence: 15 */8 * * *");
    expect(result.text).toContain("- promotion policy: score>=0.8, recalls>=3, uniqueQueries>=3");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });

  it("shows usage for invalid args and does not mutate config", async () => {
    const { command, runtime } = createHarness();
    const result = await command.handler(createCommandContext("unknown-mode"));

    expect(result.text).toContain("Usage: /dreaming status");
    expect(runtime.config.writeConfigFile).not.toHaveBeenCalled();
  });
});
