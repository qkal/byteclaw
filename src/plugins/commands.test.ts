import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  __testing,
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";
import { setActivePluginRegistry } from "./runtime.js";

type CommandsModule = typeof import("./commands.js");

const commandsModuleUrl = new URL("commands.ts", import.meta.url).href;

async function importCommandsModule(cacheBust: string): Promise<CommandsModule> {
  return (await import(`${commandsModuleUrl}?t=${cacheBust}`)) as CommandsModule;
}

function createVoiceCommand(overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {}) {
  return {
    description: "Voice command",
    handler: async () => ({ text: "ok" }),
    name: "voice",
    ...overrides,
  };
}

function registerVoiceCommandForTest(
  overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {},
) {
  return registerPluginCommand("demo-plugin", createVoiceCommand(overrides));
}

function resolveBindingConversationFromCommand(
  params: Parameters<typeof __testing.resolveBindingConversationFromCommand>[0],
) {
  return __testing.resolveBindingConversationFromCommand(params);
}

function expectCommandMatch(
  commandBody: string,
  params: { name: string; pluginId: string; args: string },
) {
  expect(matchPluginCommand(commandBody)).toMatchObject({
    args: params.args,
    command: expect.objectContaining({
      name: params.name,
      pluginId: params.pluginId,
    }),
  });
}

function expectProviderCommandSpecs(
  provider: Parameters<typeof getPluginCommandSpecs>[0],
  expectedNames: readonly string[],
) {
  expect(getPluginCommandSpecs(provider)).toEqual(
    expectedNames.map((name) => ({
      acceptsArgs: false,
      description: "Demo command",
      name,
    })),
  );
}

function expectProviderCommandSpecCases(
  cases: readonly {
    provider: Parameters<typeof getPluginCommandSpecs>[0];
    expectedNames: readonly string[];
  }[],
) {
  cases.forEach(({ provider, expectedNames }) => {
    expectProviderCommandSpecs(provider, expectedNames);
  });
}

function expectUnsupportedBindingApiResult(result: { text?: string }) {
  expect(result.text).toBe(
    JSON.stringify({
      current: null,
      detached: { removed: false },
      requested: {
        message: "This command cannot bind the current conversation.",
        status: "error",
      },
    }),
  );
}

function expectBindingConversationCase(
  params: Parameters<typeof resolveBindingConversationFromCommand>[0],
  expected: ReturnType<typeof resolveBindingConversationFromCommand>,
) {
  expect(resolveBindingConversationFromCommand(params)).toEqual(expected);
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const rawTarget = [commandTo, originatingTo, fallbackTo].find(Boolean)?.trim();
              if (!rawTarget || rawTarget.startsWith("slash:")) {
                return null;
              }
              const normalized = rawTarget.replace(/^telegram:/i, "");
              const topicMatch = /^(.*?):topic:(\d+)$/i.exec(normalized);
              if (topicMatch?.[1]) {
                return {
                  conversationId: `${topicMatch[1]}:topic:${threadId ?? topicMatch[2]}`,
                  parentConversationId: topicMatch[1],
                };
              }
              return { conversationId: normalized };
            },
            selfParentConversationByDefault: true,
          },
          commands: {
            nativeCommandsAutoEnabled: true,
          },
        },
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const rawTarget = [originatingTo, commandTo, fallbackTo].find(Boolean)?.trim();
              if (!rawTarget || rawTarget.startsWith("slash:")) {
                return null;
              }
              const normalized = rawTarget.replace(/^discord:/i, "");
              if (/^\d+$/.test(normalized)) {
                return { conversationId: `user:${normalized}` };
              }
              if (threadId) {
                const baseConversationId =
                  originatingTo?.trim()?.replace(/^discord:/i, "") ||
                  commandTo?.trim()?.replace(/^discord:/i, "") ||
                  fallbackTo?.trim()?.replace(/^discord:/i, "");
                return {
                  conversationId: baseConversationId || threadId,
                  ...(threadParentId ? { parentConversationId: threadParentId } : {}),
                };
              }
              if (normalized.startsWith("channel:") || normalized.startsWith("user:")) {
                return { conversationId: normalized };
              }
              return null;
            },
          },
          commands: {
            nativeCommandsAutoEnabled: true,
          },
        },
        pluginId: "discord",
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it.each([
    {
      command: {
        // Runtime plugin payloads are untyped; guard at boundary.
        description: "Demo",
        handler: async () => ({ text: "ok" }),
        name: undefined as unknown as string,
      },
      expected: {
        error: "Command name must be a string",
        ok: false,
      },
      name: "rejects invalid command names",
    },
    {
      command: {
        description: undefined as unknown as string,
        handler: async () => ({ text: "ok" }),
        name: "demo",
      },
      expected: {
        error: "Command description must be a string",
        ok: false,
      },
      name: "rejects invalid command descriptions",
    },
  ] as const)("$name", ({ command, expected }) => {
    expect(registerPluginCommand("demo-plugin", command)).toEqual(expected);
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
      name: "  demo_cmd  ",
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        acceptsArgs: false,
        description: "Demo command",
        name: "demo_cmd",
        pluginId: "demo-plugin",
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        acceptsArgs: false,
        description: "Demo command",
        name: "demo_cmd",
      },
    ]);
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
    });

    expect(result).toEqual({ ok: true });
    expectProviderCommandSpecCases([
      { expectedNames: ["talkvoice"], provider: undefined },
      { expectedNames: ["discordvoice"], provider: "discord" },
      { expectedNames: ["talkvoice"], provider: "telegram" },
      { expectedNames: [], provider: "slack" },
    ]);
  });

  it("accepts native progress metadata on plugin commands", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      nativeProgressMessages: { telegram: "Running voice command..." },
    });

    expect(result).toEqual({ ok: true });
    expect(matchPluginCommand("/voice")).toMatchObject({
      command: expect.objectContaining({
        nativeProgressMessages: { telegram: "Running voice command..." },
      }),
    });
  });

  it("rejects empty native progress metadata", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      nativeProgressMessages: { telegram: "   " },
    });

    expect(result).toEqual({
      error: 'Native progress message "telegram" cannot be empty',
      ok: false,
    });
  });

  it("shares plugin commands across duplicate module instances", async () => {
    const first = await importCommandsModule(`first-${Date.now()}`);
    const second = await importCommandsModule(`second-${Date.now()}`);

    first.clearPluginCommands();

    expect(
      first.registerPluginCommand(
        "demo-plugin",
        createVoiceCommand({
          nativeNames: {
            telegram: "voice",
          },
        }),
      ),
    ).toEqual({ ok: true });

    expect(second.getPluginCommandSpecs("telegram")).toEqual([
      {
        acceptsArgs: false,
        description: "Voice command",
        name: "voice",
      },
    ]);
    expect(second.matchPluginCommand("/voice")).toMatchObject({
      command: expect.objectContaining({
        name: "voice",
        pluginId: "demo-plugin",
      }),
    });

    second.clearPluginCommands();
  });

  it.each(["/talkvoice now", "/discordvoice now"] as const)(
    "matches provider-specific native alias %s back to the canonical command",
    (commandBody) => {
      const result = registerVoiceCommandForTest({
        acceptsArgs: true,
        description: "Demo command",
        nativeNames: {
          default: "talkvoice",
          discord: "discordvoice",
        },
      });

      expect(result).toEqual({ ok: true });
      expectCommandMatch(commandBody, {
        args: "now",
        name: "voice",
        pluginId: "demo-plugin",
      });
    },
  );

  it.each([
    {
      candidate: {
        description: "Pair command",
        handler: async () => ({ text: "ok" }),
        name: "pair",
        nativeNames: {
          telegram: "pair_device",
        },
      },
      expected: {
        error: 'Command "pair_device" already registered by plugin "demo-plugin"',
        ok: false,
      },
      name: "rejects provider aliases that collide with another registered command",
      setup: () =>
        registerPluginCommand(
          "demo-plugin",
          createVoiceCommand({
            nativeNames: {
              telegram: "pair_device",
            },
          }),
        ),
    },
    {
      candidate: createVoiceCommand({
        nativeNames: {
          telegram: "help",
        },
      }),
      expected: {
        error:
          'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
        ok: false,
      },
      name: "rejects reserved provider aliases",
    },
  ] as const)("$name", ({ setup, candidate, expected }) => {
    setup?.();
    expect(registerPluginCommand("other-plugin", candidate)).toEqual(expected);
  });

  it.each([
    {
      expected: {
        accountId: "default",
        channel: "discord",
        conversationId: "user:1177378744822943744",
      },
      name: "resolves Discord DM command bindings with the user target prefix intact",
      params: {
        accountId: "default",
        channel: "discord",
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
      },
    },
    {
      expected: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:1480554272859881494",
      },
      name: "resolves Discord guild command bindings with the channel target prefix intact",
      params: {
        accountId: "default",
        channel: "discord",
        from: "discord:channel:1480554272859881494",
      },
    },
    {
      expected: {
        accountId: "default",
        channel: "discord",
        conversationId: "channel:1480554272859881494",
        parentConversationId: "channel-parent-7",
        threadId: "thread-42",
      },
      name: "resolves Discord thread command bindings with parent channel context intact",
      params: {
        accountId: "default",
        channel: "discord",
        from: "discord:channel:1480554272859881494",
        messageThreadId: "thread-42",
        threadParentId: "channel-parent-7",
      },
    },
    {
      expected: null,
      name: "does not resolve binding conversations for unsupported command channels",
      params: {
        accountId: "default",
        channel: "slack",
        from: "slack:U123",
        to: "C456",
      },
    },
  ] as const)("$name", ({ params, expected }) => {
    expectBindingConversationCase(params, expected);
  });

  it("does not expose binding APIs to plugin commands on unsupported channels", async () => {
    const handler = async (ctx: {
      requestConversationBinding: (params: { summary: string }) => Promise<unknown>;
      getCurrentConversationBinding: () => Promise<unknown>;
      detachConversationBinding: () => Promise<unknown>;
    }) => {
      const requested = await ctx.requestConversationBinding({
        summary: "Bind this conversation.",
      });
      const current = await ctx.getCurrentConversationBinding();
      const detached = await ctx.detachConversationBinding();
      return {
        text: JSON.stringify({
          current,
          detached,
          requested,
        }),
      };
    };
    registerPluginCommand(
      "demo-plugin",
      {
        acceptsArgs: false,
        description: "Demo command",
        handler,
        name: "bindcheck",
      },
      { pluginRoot: "/plugins/demo-plugin" },
    );

    const result = await executePluginCommand({
      accountId: "default",
      channel: "slack",
      command: {
        acceptsArgs: false,
        description: "Demo command",
        handler,
        name: "bindcheck",
        pluginId: "demo-plugin",
        pluginRoot: "/plugins/demo-plugin",
      },
      commandBody: "/bindcheck",
      config: {} as never,
      from: "slack:U123",
      isAuthorizedSender: true,
      senderId: "U123",
      to: "C456",
    });

    expectUnsupportedBindingApiResult(result);
  });

  it("passes host session identity through to the plugin command context", async () => {
    let receivedCtx:
      | {
          sessionKey?: string;
          sessionId?: string;
        }
      | undefined;
    const handler = async (ctx: { sessionKey?: string; sessionId?: string }) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executePluginCommand({
      channel: "whatsapp",
      command: {
        acceptsArgs: false,
        description: "Demo command",
        handler,
        name: "sessioncheck",
        pluginId: "demo-plugin",
      },
      commandBody: "/sessioncheck",
      config: {} as never,
      isAuthorizedSender: true,
      senderId: "U123",
      sessionId: "session-123",
      sessionKey: "agent:main:whatsapp:direct:123",
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx).toMatchObject({
      sessionId: "session-123",
      sessionKey: "agent:main:whatsapp:direct:123",
    });
  });

  it("passes the effective default account to plugin command handlers when accountId is omitted", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({
              config: {
                defaultAccountId: () => "work",
                listAccountIds: () => ["default", "work"],
                resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
              },
              id: "line",
              label: "LINE",
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const rawTarget = [originatingTo, commandTo, fallbackTo].find(Boolean)?.trim();
                if (!rawTarget) {
                  return null;
                }
                return {
                  conversationId: rawTarget.replace(/^line:/i, "").replace(/^user:/i, ""),
                };
              },
            },
          },
          pluginId: "line",
          source: "test",
        },
      ]),
    );

    let receivedCtx:
      | {
          accountId?: string;
        }
      | undefined;
    const handler = async (ctx: { accountId?: string }) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executePluginCommand({
      channel: "line",
      command: {
        acceptsArgs: false,
        description: "Demo command",
        handler,
        name: "accountcheck",
        pluginId: "demo-plugin",
      },
      commandBody: "/accountcheck",
      config: {} as never,
      from: "line:user:U1234567890abcdef1234567890abcdef",
      isAuthorizedSender: true,
      senderId: "U123",
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx).toMatchObject({
      accountId: "work",
    });
  });
});
