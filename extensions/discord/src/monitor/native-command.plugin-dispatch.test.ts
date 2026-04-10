import { ChannelType } from "discord-api-types/v10";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "../../../../test/helpers/plugins/plugin-registry.js";
import {
  type MockCommandInteraction,
  createMockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let discordNativeCommandTesting: typeof import("./native-command.js").__testing;
const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  executePluginCommand: vi.fn(),
  matchPluginCommand: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-runtime")>(
    "openclaw/plugin-sdk/plugin-runtime",
  );
  return {
    ...actual,
    executePluginCommand: (...args: unknown[]) => runtimeModuleMocks.executePluginCommand(...args),
    matchPluginCommand: (...args: unknown[]) => runtimeModuleMocks.matchPluginCommand(...args),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) =>
      runtimeModuleMocks.dispatchReplyWithDispatcher(...args),
  };
});

function createInteraction(params?: {
  channelType?: ChannelType;
  channelId?: string;
  threadParentId?: string | null;
  guildId?: string;
  guildName?: string;
}): MockCommandInteraction {
  return createMockCommandInteraction({
    channelId: params?.channelId ?? "dm-1",
    channelType: params?.channelType ?? ChannelType.DM,
    globalName: "Tester",
    guildId: params?.guildId ?? null,
    guildName: params?.guildName,
    interactionId: "interaction-1",
    threadParentId: params?.threadParentId,
    userId: "owner",
    username: "tester",
  });
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
  } as OpenClawConfig;
}

function createConfiguredAcpBinding(params: {
  channelId: string;
  peerKind: "channel" | "direct";
  agentId?: string;
}) {
  return {
    acp: {
      mode: "persistent",
    },
    agentId: params.agentId ?? "codex",
    match: {
      accountId: "default",
      channel: "discord",
      peer: { id: params.channelId, kind: params.peerKind },
    },
    type: "acp",
  } as const;
}

function createConfiguredAcpCase(params: {
  channelType: ChannelType;
  channelId: string;
  peerKind: "channel" | "direct";
  guildId?: string;
  guildName?: string;
  includeChannelAccess?: boolean;
  agentId?: string;
}) {
  return {
    cfg: {
      commands: {
        useAccessGroups: false,
      },
      ...(params.includeChannelAccess === false
        ? {}
        : (params.channelType === ChannelType.DM
          ? {
              channels: {
                discord: {
                  dm: { enabled: true, policy: "open" },
                },
              },
            }
          : {
              channels: {
                discord: {
                  guilds: {
                    [params.guildId!]: {
                      channels: {
                        [params.channelId]: { enabled: true, requireMention: false },
                      },
                    },
                  },
                },
              },
            })),
      bindings: [
        createConfiguredAcpBinding({
          agentId: params.agentId,
          channelId: params.channelId,
          peerKind: params.peerKind,
        }),
      ],
    } as OpenClawConfig,
    interaction: createInteraction({
      channelId: params.channelId,
      channelType: params.channelType,
      guildId: params.guildId,
      guildName: params.guildName,
    }),
  };
}

async function createNativeCommand(cfg: OpenClawConfig, commandSpec: NativeCommandSpec) {
  return createDiscordNativeCommand({
    accountId: "default",
    cfg,
    command: commandSpec,
    discordConfig: cfg.channels?.discord ?? {},
    ephemeralDefault: true,
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function createConfiguredRouteState(params: {
  sessionKey: string;
  agentId?: string;
  accountId?: string;
}) {
  return {
    bindingReadiness: { ok: true } as const,
    boundSessionKey: params.sessionKey,
    configuredBinding: null,
    configuredRoute: null,
    effectiveRoute: {
      accountId: params.accountId ?? "default",
      agentId: params.agentId ?? "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      matchedBy: "binding.channel",
      sessionKey: params.sessionKey,
    },
    route: {
      accountId: params.accountId ?? "default",
      agentId: params.agentId ?? "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      matchedBy: "binding.channel",
      sessionKey: params.sessionKey,
    },
  } satisfies Awaited<
    ReturnType<typeof import("./native-command-route.js").resolveDiscordNativeInteractionRouteState>
  >;
}

function createUnboundRouteState(params: {
  sessionKey: string;
  agentId?: string;
  accountId?: string;
}) {
  return {
    bindingReadiness: null,
    boundSessionKey: undefined,
    configuredBinding: null,
    configuredRoute: null,
    effectiveRoute: {
      accountId: params.accountId ?? "default",
      agentId: params.agentId ?? "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      matchedBy: "default",
      sessionKey: params.sessionKey,
    },
    route: {
      accountId: params.accountId ?? "default",
      agentId: params.agentId ?? "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: `agent:${params.agentId ?? "main"}:main`,
      matchedBy: "default",
      sessionKey: params.sessionKey,
    },
  } satisfies Awaited<
    ReturnType<typeof import("./native-command-route.js").resolveDiscordNativeInteractionRouteState>
  >;
}

async function createPluginCommand(params: { cfg: OpenClawConfig; name: string }) {
  return createDiscordNativeCommand({
    accountId: "default",
    cfg: params.cfg,
    command: {
      acceptsArgs: true,
      description: "Pair",
      name: params.name,
    } satisfies NativeCommandSpec,
    discordConfig: params.cfg.channels?.discord ?? {},
    ephemeralDefault: true,
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function registerPairPlugin(params?: { discordNativeName?: string }) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.discordNativeName
        ? {
            nativeNames: {
              discord: params.discordNativeName,
              telegram: "pair_device",
            },
          }
        : {}),
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
    }),
  ).toEqual({ ok: true });
}

async function expectPairCommandReply(params: {
  cfg: OpenClawConfig;
  commandName: string;
  interaction: MockCommandInteraction;
}) {
  const command = await createPluginCommand({
    cfg: params.cfg,
    name: params.commandName,
  });
  const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher;

  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    Object.assign(params.interaction, {
      options: {
        getBoolean: () => null,
        getFocused: () => "",
        getString: () => "now",
      },
    }) as unknown,
  );

  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(params.interaction.followUp).toHaveBeenCalledWith(
    expect.objectContaining({ content: "paired:now" }),
  );
  expect(params.interaction.reply).not.toHaveBeenCalled();
}

async function createStatusCommand(cfg: OpenClawConfig) {
  return await createNativeCommand(cfg, {
    acceptsArgs: false,
    description: "Status",
    name: "status",
  });
}

function createDispatchSpy() {
  return runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
    counts: {
      block: 0,
      final: 1,
      tool: 0,
    },
  } as never);
}

function expectBoundSessionDispatch(
  dispatchSpy: ReturnType<typeof createDispatchSpy>,
  expectedPattern: RegExp,
) {
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
  };
  if (!dispatchCall.ctx?.SessionKey || !dispatchCall.ctx.CommandTargetSessionKey) {
    throw new Error("native command dispatch did not include bound session context");
  }
  expect(dispatchCall.ctx.SessionKey).toMatch(expectedPattern);
  expect(dispatchCall.ctx.CommandTargetSessionKey).toMatch(expectedPattern);
}

async function expectBoundStatusCommandDispatch(params: {
  cfg: OpenClawConfig;
  interaction: MockCommandInteraction;
  expectedPattern: RegExp;
}) {
  runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
  const dispatchSpy = createDispatchSpy();
  const command = await createStatusCommand(params.cfg);

  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    params.interaction as unknown,
  );

  expectBoundSessionDispatch(dispatchSpy, params.expectedPattern);
}

describe("Discord native plugin command dispatch", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, __testing: discordNativeCommandTesting } =
      await import("./native-command.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    const actualPluginRuntime = await vi.importActual<
      typeof import("openclaw/plugin-sdk/plugin-runtime")
    >("openclaw/plugin-sdk/plugin-runtime");
    runtimeModuleMocks.matchPluginCommand.mockReset();
    runtimeModuleMocks.matchPluginCommand.mockImplementation(
      actualPluginRuntime.matchPluginCommand,
    );
    runtimeModuleMocks.executePluginCommand.mockReset();
    runtimeModuleMocks.executePluginCommand.mockImplementation(
      actualPluginRuntime.executePluginCommand,
    );
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockReset();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        block: 0,
        final: 1,
        tool: 0,
      },
    } as never);
    discordNativeCommandTesting.setMatchPluginCommand(
      runtimeModuleMocks.matchPluginCommand as typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand,
    );
    discordNativeCommandTesting.setExecutePluginCommand(
      runtimeModuleMocks.executePluginCommand as typeof import("openclaw/plugin-sdk/plugin-runtime").executePluginCommand,
    );
    discordNativeCommandTesting.setDispatchReplyWithDispatcher(
      runtimeModuleMocks.dispatchReplyWithDispatcher as typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithDispatcher,
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async (params) =>
      createUnboundRouteState({
        accountId: params.accountId,
        sessionKey: params.isDirectMessage
          ? `agent:main:discord:dm:${params.directUserId ?? "owner"}`
          : `agent:main:discord:channel:${params.conversationId}`,
      }),
    );
  });

  it("executes plugin commands from the real registry through the native Discord command path", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin();
    await expectPairCommandReply({
      cfg,
      commandName: "pair",
      interaction,
    });
  });

  it("round-trips Discord native aliases through the real plugin registry", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin({ discordNativeName: "pairdiscord" });
    await expectPairCommandReply({
      cfg,
      commandName: "pairdiscord",
      interaction,
    });
  });

  it("blocks unauthorized Discord senders before requireAuth:false plugin commands execute", async () => {
    const cfg = {
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "234567890123456789": {
                  enabled: true,
                  requireMention: false,
                },
              },
            },
          },
        },
      },
      commands: {
        allowFrom: {
          discord: ["user:123456789012345678"],
        },
      },
    } as OpenClawConfig;
    const commandSpec: NativeCommandSpec = {
      acceptsArgs: true,
      description: "Pair",
      name: "pair",
    };
    const command = await createNativeCommand(cfg, commandSpec);
    const interaction = createInteraction({
      channelId: "234567890123456789",
      channelType: ChannelType.GuildText,
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    interaction.user.id = "999999999999999999";
    interaction.options.getString.mockReturnValue("now");

    expect(
      registerPluginCommand("demo-plugin", {
        acceptsArgs: true,
        description: "Pair device",
        handler: async ({ args }) => ({ text: `open:${args ?? ""}` }),
        name: "pair",
        requireAuth: false,
      }),
    ).toEqual({ ok: true });

    const executeSpy = runtimeModuleMocks.executePluginCommand;
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("rejects group DM slash commands outside dm.groupChannels before dispatch", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: {
            enabled: true,
            groupChannels: ["allowed-group"],
            groupEnabled: true,
            policy: "open",
          },
        },
      },
      commands: {
        allowFrom: {
          discord: ["user:owner"],
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelId: "blocked-group",
      channelType: ChannelType.GroupDM,
    });
    const dispatchSpy = createDispatchSpy();
    const command = await createStatusCommand(cfg);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This group DM is not allowed.",
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("executes matched plugin commands directly without invoking the agent dispatcher", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      acceptsArgs: false,
      description: "List cron jobs",
      name: "cron_jobs",
    };
    const interaction = createInteraction();
    const pluginMatch = {
      args: undefined,
      command: {
        acceptsArgs: false,
        description: "List cron jobs",
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
        name: "cron_jobs",
        pluginId: "cron-jobs",
      },
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
      text: "direct plugin output",
    });
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "direct plugin output" }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("forwards Discord thread metadata into direct plugin command execution", async () => {
    const cfg = {
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "parent-456": {
                  enabled: true,
                  requireMention: false,
                },
                "thread-123": {
                  enabled: true,
                  requireMention: false,
                },
              },
            },
          },
        },
      },
      commands: {
        useAccessGroups: false,
      },
    } as OpenClawConfig;
    const commandSpec: NativeCommandSpec = {
      acceptsArgs: false,
      description: "List cron jobs",
      name: "cron_jobs",
    };
    const interaction = createInteraction({
      channelId: "thread-123",
      channelType: ChannelType.PublicThread,
      guildId: "345678901234567890",
      guildName: "Test Guild",
      threadParentId: "parent-456",
    });
    const pluginMatch = {
      args: undefined,
      command: {
        acceptsArgs: false,
        description: "List cron jobs",
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
        name: "cron_jobs",
        pluginId: "cron-jobs",
      },
    };

    runtimeModuleMocks.matchPluginCommand.mockReturnValue(pluginMatch as never);
    const executeSpy = runtimeModuleMocks.executePluginCommand.mockResolvedValue({
      text: "direct plugin output",
    });
    const command = await createNativeCommand(cfg, commandSpec);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        from: "discord:channel:thread-123",
        messageThreadId: "thread-123",
        sessionKey: "agent:main:discord:channel:thread-123",
        threadParentId: "parent-456",
        to: "slash:owner",
      }),
    );
  });

  it("routes native slash commands through configured ACP Discord channel bindings", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelId: "1478836151241412759",
      channelType: ChannelType.GuildText,
      guildId: "1459246755253325866",
      guildName: "Ops",
      peerKind: "channel",
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        agentId: "codex",
        sessionKey: "agent:codex:acp:binding:discord:default:guild-channel",
      }),
    );

    await expectBoundStatusCommandDispatch({
      cfg,
      expectedPattern: /^agent:codex:acp:binding:discord:default:/,
      interaction,
    });
  });

  it("falls back to the routed slash and channel session keys when no bound session exists", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1478836151241412759";
    const cfg = {
      bindings: [
        {
          agentId: "qwen",
          match: {
            accountId: "default",
            channel: "discord",
            guildId,
            peer: { id: channelId, kind: "channel" },
          },
        },
      ],
      channels: {
        discord: {
          guilds: {
            [guildId]: {
              channels: {
                [channelId]: { enabled: true, requireMention: false },
              },
            },
          },
        },
      },
      commands: {
        useAccessGroups: false,
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelId,
      channelType: ChannelType.GuildText,
      guildId,
      guildName: "Ops",
    });

    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createUnboundRouteState({
        agentId: "qwen",
        sessionKey: `agent:qwen:discord:channel:${channelId}`,
      }),
    );
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();
    const command = await createStatusCommand(cfg);
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () => ({
      bindingReadiness: null,
      boundSessionKey: undefined,
      configuredBinding: null,
      configuredRoute: null,
      effectiveRoute: {
        accountId: "default",
        agentId: "qwen",
        channel: "discord",
        lastRoutePolicy: "session",
        mainSessionKey: "agent:qwen:main",
        matchedBy: "binding.channel",
        sessionKey: "agent:qwen:discord:channel:1478836151241412759",
      },
      route: {
        accountId: "default",
        agentId: "qwen",
        channel: "discord",
        lastRoutePolicy: "session",
        mainSessionKey: "agent:qwen:main",
        matchedBy: "binding.channel",
        sessionKey: "agent:qwen:discord:channel:1478836151241412759",
      },
    }));

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.ctx?.SessionKey).toBe("agent:qwen:discord:slash:owner");
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(
      "agent:qwen:discord:channel:1478836151241412759",
    );
  });

  it("routes Discord DM native slash commands through configured ACP bindings", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelId: "dm-1",
      channelType: ChannelType.DM,
      peerKind: "direct",
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        agentId: "codex",
        sessionKey: "agent:codex:acp:binding:discord:default:dm",
      }),
    );

    await expectBoundStatusCommandDispatch({
      cfg,
      expectedPattern: /^agent:codex:acp:binding:discord:default:/,
      interaction,
    });
  });

  it("does not bypass configured ACP readiness for Discord /new", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelId: "1478844424791396446",
      channelType: ChannelType.GuildText,
      guildId: "1459246755253325866",
      guildName: "Ops",
      peerKind: "channel",
    });
    const resolveRouteState = vi.fn(async () =>
      createConfiguredRouteState({
        agentId: "claude",
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      }),
    );
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(resolveRouteState);
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();
    const command = await createNativeCommand(cfg, {
      acceptsArgs: true,
      description: "Start a new session.",
      name: "new",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(resolveRouteState).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceConfiguredBindingReadiness: true,
      }),
    );
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows recovery commands through configured ACP bindings even when ensure fails", async () => {
    const { cfg, interaction } = createConfiguredAcpCase({
      channelId: "1479098716916023408",
      channelType: ChannelType.GuildText,
      guildId: "1459246755253325866",
      guildName: "Ops",
      includeChannelAccess: false,
      peerKind: "channel",
    });
    discordNativeCommandTesting.setResolveDiscordNativeInteractionRouteState(async () =>
      createConfiguredRouteState({
        agentId: "codex",
        sessionKey: "agent:codex:acp:binding:discord:default:recovery",
      }),
    );
    runtimeModuleMocks.matchPluginCommand.mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();
    const command = await createNativeCommand(cfg, {
      acceptsArgs: true,
      description: "Start a new session.",
      name: "new",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.ctx?.SessionKey).toMatch(/^agent:codex:acp:binding:discord:default:/);
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toMatch(
      /^agent:codex:acp:binding:discord:default:/,
    );
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Configured ACP binding is unavailable right now. Please try again.",
      }),
    );
  });
});
