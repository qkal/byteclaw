import { Type } from "@sinclair/typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import {
  createMessageToolButtonsSchema,
  createMessageToolCardSchema,
} from "../../plugin-sdk/channel-actions.js";
type CreateMessageTool = typeof import("./message-tool.js").createMessageTool;
type ResetPluginRuntimeStateForTest =
  typeof import("../../plugins/runtime.js").resetPluginRuntimeStateForTest;
type SetActivePluginRegistry = typeof import("../../plugins/runtime.js").setActivePluginRegistry;
type CreateTestRegistry = typeof import("../../test-utils/channel-plugins.js").createTestRegistry;

let createMessageTool: CreateMessageTool;
let resetPluginRuntimeStateForTest: ResetPluginRuntimeStateForTest;
let setActivePluginRegistry: SetActivePluginRegistry;
let createTestRegistry: CreateTestRegistry;

type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;
type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];
type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

function createDiscordMessageToolComponentsSchema() {
  return Type.Object({ type: Type.Literal("discord-components") });
}

function createSlackMessageToolBlocksSchema() {
  return Type.Array(Type.Object({}, { additionalProperties: true }));
}

function createTelegramPollExtraToolSchemas() {
  return {
    pollAnonymous: Type.Optional(Type.Boolean()),
    pollDurationSeconds: Type.Optional(Type.Number()),
    pollPublic: Type.Optional(Type.Boolean()),
  };
}

function createCardSchemaPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  blurb: string;
}) {
  return createChannelPlugin({
    ...params,
    actions: ["send"],
    capabilities: ["cards"],
    toolSchema: () => ({
      properties: {
        card: createMessageToolCardSchema(),
      },
    }),
  });
}

const mocks = vi.hoisted(() => ({
  getScopedChannelsCommandSecretTargets: vi.fn(
    ({
      config,
      channel,
      accountId,
    }: {
      config?: { channels?: Record<string, unknown> };
      channel?: string | null;
      accountId?: string | null;
    }) => {
      const allowedPaths = new Set<string>();
      const targetIds = new Set<string>();
      const scopedChannel = channel?.trim();
      const scopedAccountId = accountId?.trim();
      const scopedConfig =
        scopedChannel && config?.channels && typeof config.channels[scopedChannel] === "object"
          ? (config.channels[scopedChannel] as Record<string, unknown>)
          : null;
      if (!scopedChannel || !scopedConfig) {
        return { targetIds };
      }

      const maybeCollectSecretPath = (path: string, value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.source === "string" && typeof record.id === "string") {
          targetIds.add(path);
          allowedPaths.add(path);
        }
      };

      maybeCollectSecretPath(`channels.${scopedChannel}.token`, scopedConfig.token);
      maybeCollectSecretPath(`channels.${scopedChannel}.botToken`, scopedConfig.botToken);
      if (scopedAccountId) {
        const accountRecord =
          scopedConfig.accounts &&
          typeof scopedConfig.accounts === "object" &&
          !Array.isArray(scopedConfig.accounts) &&
          typeof (scopedConfig.accounts as Record<string, unknown>)[scopedAccountId] === "object"
            ? ((scopedConfig.accounts as Record<string, unknown>)[scopedAccountId] as Record<
                string,
                unknown
              >)
            : null;
        if (accountRecord) {
          maybeCollectSecretPath(
            `channels.${scopedChannel}.accounts.${scopedAccountId}.token`,
            accountRecord.token,
          );
          maybeCollectSecretPath(
            `channels.${scopedChannel}.accounts.${scopedAccountId}.botToken`,
            accountRecord.botToken,
          );
        }
      }

      return {
        targetIds,
        ...(allowedPaths.size > 0 ? { allowedPaths } : {}),
      };
    },
  ),
  loadConfig: vi.fn(() => ({})),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    diagnostics: [],
    resolvedConfig: config,
  })),
  runMessageAction: vi.fn(),
}));

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
}));

function mockSendResult(overrides: { channel?: string; to?: string } = {}) {
  mocks.runMessageAction.mockClear();
  mocks.runMessageAction.mockResolvedValue({
    action: "send",
    channel: overrides.channel ?? "telegram",
    dryRun: true,
    handledBy: "plugin",
    kind: "send",
    payload: {},
    to: overrides.to ?? "telegram:123",
  } satisfies MessageActionRunResult);
}

function getToolProperties(tool: ReturnType<CreateMessageTool>) {
  return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

function getActionEnum(properties: Record<string, unknown>) {
  return (properties.action as { enum?: string[] } | undefined)?.enum ?? [];
}

beforeAll(async () => {
  ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../../plugins/runtime.js"));
  ({ createTestRegistry } = await import("../../test-utils/channel-plugins.js"));
  ({ createMessageTool } = await import("./message-tool.js"));
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.loadConfig.mockReset().mockReturnValue({});
  mocks.resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    diagnostics: [],
    resolvedConfig: config,
  }));
  mocks.getScopedChannelsCommandSecretTargets.mockClear();
  setActivePluginRegistry(createTestRegistry([]));
});

function createChannelPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  blurb: string;
  aliases?: string[];
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messaging?: ChannelPlugin["messaging"];
}): ChannelPlugin {
  return {
    id: params.id as ChannelPlugin["id"],
    meta: {
      aliases: params.aliases,
      blurb: params.blurb,
      docsPath: params.docsPath,
      id: params.id as ChannelPlugin["id"],
      label: params.label,
      selectionLabel: params.label,
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    ...(params.messaging ? { messaging: params.messaging } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
    },
  };
}

async function executeSend(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
}) {
  const tool = createMessageTool({
    config: {} as never,
    runMessageAction: mocks.runMessageAction as never,
    ...params.toolOptions,
  });
  await tool.execute("1", {
    action: "send",
    ...params.action,
  });
  return mocks.runMessageAction.mock.calls[0]?.[0] as
    | {
        params?: Record<string, unknown>;
        sandboxRoot?: string;
        requesterSenderId?: string;
      }
    | undefined;
}

describe("message tool secret scoping", () => {
  it("scopes command-time secret resolution to the selected channel/account", async () => {
    mockSendResult({ channel: "discord", to: "discord:123" });
    mocks.loadConfig.mockReturnValue({
      channels: {
        discord: {
          accounts: {
            chat: { token: { id: "DISCORD_CHAT_TOKEN", provider: "default", source: "env" } },
            ops: { token: { id: "DISCORD_OPS_TOKEN", provider: "default", source: "env" } },
          },
          token: { id: "DISCORD_TOKEN", provider: "default", source: "env" },
        },
        slack: {
          botToken: { id: "SLACK_BOT_TOKEN", provider: "default", source: "env" },
        },
      },
    });

    const tool = createMessageTool({
      agentAccountId: "ops",
      currentChannelProvider: "discord",
      loadConfig: mocks.loadConfig as never,
      resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway as never,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      message: "hi",
      target: "channel:123",
    });

    const secretResolveCall = mocks.resolveCommandSecretRefsViaGateway.mock.calls.at(-1)?.[0] as {
      targetIds?: Set<string>;
      allowedPaths?: Set<string>;
    };
    expect(secretResolveCall.targetIds).toBeInstanceOf(Set);
    expect(
      [...(secretResolveCall.targetIds ?? [])].every((id) => id.startsWith("channels.discord.")),
    ).toBe(true);
    expect(secretResolveCall.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
  });
});

describe("message tool agent routing", () => {
  it("derives agentId from the session key", async () => {
    mockSendResult();

    const tool = createMessageTool({
      agentSessionKey: "agent:alpha:main",
      config: {} as never,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      message: "hi",
      target: "telegram:123",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.agentId).toBe("alpha");
    expect(call?.sessionKey).toBe("agent:alpha:main");
  });
});

describe("message tool explicit target guard", () => {
  it("requires an explicit target for upload-file when configured", async () => {
    const tool = createMessageTool({
      config: {} as never,
      currentChannelId: "channel:C123",
      currentChannelProvider: "slack",
      requireExplicitTarget: true,
      runMessageAction: mocks.runMessageAction as never,
    });

    await expect(
      tool.execute("1", {
        action: "upload-file",
        filePath: "/tmp/report.png",
      }),
    ).rejects.toThrow(/Explicit message target required/i);

    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  it("allows upload-file when an explicit target is provided", async () => {
    mocks.runMessageAction.mockResolvedValueOnce({
      action: "upload-file",
      channel: "slack",
      dryRun: true,
      handledBy: "dry-run",
      kind: "action",
      payload: { action: "upload-file", channel: "slack", dryRun: true, ok: true },
    });

    const tool = createMessageTool({
      config: {} as never,
      currentChannelId: "channel:C123",
      currentChannelProvider: "slack",
      requireExplicitTarget: true,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "upload-file",
      filePath: "/tmp/report.png",
      target: "channel:C999",
    });

    const call = mocks.runMessageAction.mock.calls[0]?.[0];
    expect(call?.params?.target).toBe("channel:C999");
  });
});

describe("message tool path passthrough", () => {
  it.each([
    { field: "path", value: "~/Downloads/voice.ogg" },
    { field: "filePath", value: "./tmp/note.m4a" },
  ])("does not convert $field to media for send", async ({ field, value }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      action: {
        target: "telegram:123",
        [field]: value,
        message: "",
      },
    });

    expect(call?.params?.[field]).toBe(value);
    expect(call?.params?.media).toBeUndefined();
  });
});

describe("message tool schema scoping", () => {
  const telegramPlugin = createChannelPlugin({
    actions: ["send", "react", "poll"],
    blurb: "Telegram test plugin.",
    capabilities: ["interactive", "buttons"],
    docsPath: "/channels/telegram",
    id: "telegram",
    label: "Telegram",
    toolSchema: () => [
      {
        properties: {
          buttons: createMessageToolButtonsSchema(),
        },
      },
      {
        properties: createTelegramPollExtraToolSchemas(),
        visibility: "all-configured",
      },
    ],
  });

  const discordPlugin = createChannelPlugin({
    actions: ["send", "poll", "poll-vote"],
    blurb: "Discord test plugin.",
    capabilities: ["interactive", "components"],
    docsPath: "/channels/discord",
    id: "discord",
    label: "Discord",
    toolSchema: () => ({
      properties: {
        components: createDiscordMessageToolComponentsSchema(),
      },
    }),
  });

  const slackPlugin = createChannelPlugin({
    actions: ["send", "react"],
    blurb: "Slack test plugin.",
    capabilities: ["interactive", "blocks"],
    docsPath: "/channels/slack",
    id: "slack",
    label: "Slack",
    toolSchema: () => ({
      properties: {
        blocks: createSlackMessageToolBlocksSchema(),
      },
    }),
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      expectBlocks: false,
      expectButtonStyle: true,
      expectButtons: true,
      expectComponents: false,
      expectTelegramPollExtras: true,
      expectedActions: ["send", "react", "poll", "poll-vote"],
      provider: "telegram",
    },
    {
      expectBlocks: false,
      expectButtonStyle: false,
      expectButtons: false,
      expectComponents: true,
      expectTelegramPollExtras: true,
      expectedActions: ["send", "poll", "poll-vote", "react"],
      provider: "discord",
    },
    {
      expectBlocks: true,
      expectButtonStyle: false,
      expectButtons: false,
      expectComponents: false,
      expectTelegramPollExtras: true,
      expectedActions: ["send", "react", "poll", "poll-vote"],
      provider: "slack",
    },
  ])(
    "scopes schema fields for $provider",
    ({
      provider,
      expectComponents,
      expectBlocks,
      expectButtons,
      expectButtonStyle,
      expectTelegramPollExtras,
      expectedActions,
    }) => {
      setActivePluginRegistry(
        createTestRegistry([
          { plugin: telegramPlugin, pluginId: "telegram", source: "test" },
          { plugin: discordPlugin, pluginId: "discord", source: "test" },
          { plugin: slackPlugin, pluginId: "slack", source: "test" },
        ]),
      );

      const tool = createMessageTool({
        config: {} as never,
        currentChannelProvider: provider,
      });
      const properties = getToolProperties(tool);
      const actionEnum = getActionEnum(properties);

      if (expectComponents) {
        expect(properties.components).toBeDefined();
      } else {
        expect(properties.components).toBeUndefined();
      }
      if (expectBlocks) {
        expect(properties.blocks).toBeDefined();
      } else {
        expect(properties.blocks).toBeUndefined();
      }
      if (expectButtons) {
        expect(properties.buttons).toBeDefined();
      } else {
        expect(properties.buttons).toBeUndefined();
      }
      if (expectButtonStyle) {
        const buttonItemProps =
          (
            properties.buttons as {
              items?: { items?: { properties?: Record<string, unknown> } };
            }
          )?.items?.items?.properties ?? {};
        expect(buttonItemProps.style).toBeDefined();
      }
      for (const action of expectedActions) {
        expect(actionEnum).toContain(action);
      }
      if (expectTelegramPollExtras) {
        expect(properties.pollDurationSeconds).toBeDefined();
        expect(properties.pollAnonymous).toBeDefined();
        expect(properties.pollPublic).toBeDefined();
      } else {
        expect(properties.pollDurationSeconds).toBeUndefined();
        expect(properties.pollAnonymous).toBeUndefined();
        expect(properties.pollPublic).toBeUndefined();
      }
      expect(properties.pollId).toBeDefined();
      expect(properties.pollOptionIndex).toBeDefined();
      expect(properties.pollOptionId).toBeDefined();
    },
  );

  it("includes poll in the action enum when the current channel supports poll actions", () => {
    setActivePluginRegistry(
      createTestRegistry([{ plugin: telegramPlugin, pluginId: "telegram", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const actionEnum = getActionEnum(getToolProperties(tool));

    expect(actionEnum).toContain("poll");
  });

  it.each([
    {
      plugin: createCardSchemaPlugin({
        blurb: "Feishu test plugin.",
        docsPath: "/channels/feishu",
        id: "feishu",
        label: "Feishu",
      }),
      provider: "feishu",
    },
    {
      plugin: createCardSchemaPlugin({
        blurb: "MSTeams test plugin.",
        docsPath: "/channels/msteams",
        id: "msteams",
        label: "MSTeams",
      }),
      provider: "msteams",
    },
  ])(
    "keeps $provider card schema optional after merging into the message tool schema",
    ({ plugin }) => {
      setActivePluginRegistry(
        createTestRegistry([{ plugin, pluginId: plugin.id, source: "test" }]),
      );

      const tool = createMessageTool({
        config: {} as never,
        currentChannelProvider: plugin.id,
      });
      const schema = tool.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
      };

      expect(schema.properties?.card).toBeDefined();
      expect(schema.required ?? []).not.toContain("card");
    },
  );

  it("keeps buttons schema optional so plain sends do not require buttons", () => {
    setActivePluginRegistry(
      createTestRegistry([{ plugin: telegramPlugin, pluginId: "telegram", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(schema.properties?.buttons).toBeDefined();
    expect(schema.required ?? []).not.toContain("buttons");
  });

  it("hides telegram poll extras when telegram polls are disabled in scoped mode", () => {
    const telegramPluginWithConfig = createChannelPlugin({
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ cfg }) => {
        const telegramCfg = (cfg as { channels?: { telegram?: { actions?: { poll?: boolean } } } })
          .channels?.telegram;
        return {
          actions:
            telegramCfg?.actions?.poll === false ? ["send", "react"] : ["send", "react", "poll"],
          capabilities: ["interactive", "buttons"],
          schema: [
            {
              properties: {
                buttons: createMessageToolButtonsSchema(),
              },
            },
            ...(telegramCfg?.actions?.poll === false
              ? []
              : [
                  {
                    properties: createTelegramPollExtraToolSchemas(),
                    visibility: "all-configured" as const,
                  },
                ]),
          ],
        };
      },
      docsPath: "/channels/telegram",
      id: "telegram",
      label: "Telegram",
    });

    setActivePluginRegistry(
      createTestRegistry([
        { plugin: telegramPluginWithConfig, pluginId: "telegram", source: "test" },
      ]),
    );

    const tool = createMessageTool({
      config: {
        channels: {
          telegram: {
            actions: {
              poll: false,
            },
          },
        },
      } as never,
      currentChannelProvider: "telegram",
    });
    const properties = getToolProperties(tool);
    const actionEnum = getActionEnum(properties);

    expect(actionEnum).not.toContain("poll");
    expect(properties.pollDurationSeconds).toBeUndefined();
    expect(properties.pollAnonymous).toBeUndefined();
    expect(properties.pollPublic).toBeUndefined();
  });

  it("uses discovery account scope for capability-gated shared fields", () => {
    const scopedInteractivePlugin = createChannelPlugin({
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ accountId }) => ({
        actions: ["send"],
        capabilities: accountId === "ops" ? ["interactive"] : [],
      }),
      docsPath: "/channels/telegram",
      id: "telegram",
      label: "Telegram",
    });

    setActivePluginRegistry(
      createTestRegistry([
        { plugin: scopedInteractivePlugin, pluginId: "telegram", source: "test" },
      ]),
    );

    const scopedTool = createMessageTool({
      agentAccountId: "ops",
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const unscopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });

    expect(getToolProperties(scopedTool).interactive).toBeDefined();
    expect(getToolProperties(unscopedTool).interactive).toBeUndefined();
  });

  it("uses discovery account scope for other configured channel actions", () => {
    const currentPlugin = createChannelPlugin({
      actions: ["send"],
      blurb: "Discord test plugin.",
      docsPath: "/channels/discord",
      id: "discord",
      label: "Discord",
    });
    const scopedOtherPlugin = createChannelPlugin({
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ accountId }) => ({
        actions: accountId === "ops" ? ["react"] : [],
      }),
      docsPath: "/channels/telegram",
      id: "telegram",
      label: "Telegram",
    });

    setActivePluginRegistry(
      createTestRegistry([
        { plugin: currentPlugin, pluginId: "discord", source: "test" },
        { plugin: scopedOtherPlugin, pluginId: "telegram", source: "test" },
      ]),
    );

    const scopedTool = createMessageTool({
      agentAccountId: "ops",
      config: {} as never,
      currentChannelProvider: "discord",
    });
    const unscopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
    });

    expect(getActionEnum(getToolProperties(scopedTool))).toContain("react");
    expect(getActionEnum(getToolProperties(unscopedTool))).not.toContain("react");
    expect(scopedTool.description).toContain("telegram (react, send)");
    expect(unscopedTool.description).not.toContain("telegram (react, send)");
  });

  it("routes full discovery context into plugin action discovery", () => {
    const seenContexts: Record<string, unknown>[] = [];
    const contextPlugin = createChannelPlugin({
      blurb: "Discord context plugin.",
      describeMessageTool: (ctx) => {
        seenContexts.push({ phase: "describeMessageTool", ...ctx });
        return {
          actions: ["send", "react"],
          capabilities: ["interactive"],
        };
      },
      docsPath: "/channels/discord",
      id: "discord",
      label: "Discord",
    });

    setActivePluginRegistry(
      createTestRegistry([{ plugin: contextPlugin, pluginId: "discord", source: "test" }]),
    );

    createMessageTool({
      agentAccountId: "ops",
      agentSessionKey: "agent:alpha:main",
      config: {} as never,
      currentChannelId: "channel:123",
      currentChannelProvider: "discord",
      currentMessageId: "msg-789",
      currentThreadTs: "thread-456",
      requesterSenderId: "user-42",
      sessionId: "session-123",
    });

    expect(seenContexts).toContainEqual(
      expect.objectContaining({
        accountId: "ops",
        agentId: "alpha",
        currentChannelId: "channel:123",
        currentChannelProvider: "discord",
        currentMessageId: "msg-789",
        currentThreadTs: "thread-456",
        requesterSenderId: "user-42",
        sessionId: "session-123",
        sessionKey: "agent:alpha:main",
      }),
    );
  });
});

describe("message tool description", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  const bluebubblesPlugin = createChannelPlugin({
    blurb: "BlueBubbles test plugin.",
    describeMessageTool: ({ currentChannelId }) => {
      const all: ChannelMessageActionName[] = [
        "react",
        "renameGroup",
        "addParticipant",
        "removeParticipant",
        "leaveGroup",
      ];
      const lowered = currentChannelId?.toLowerCase() ?? "";
      const isDmTarget =
        lowered.includes("chat_guid:imessage;-;") || lowered.includes("chat_guid:sms;-;");
      return {
        actions: isDmTarget
          ? all.filter(
              (action) =>
                action !== "renameGroup" &&
                action !== "addParticipant" &&
                action !== "removeParticipant" &&
                action !== "leaveGroup",
            )
          : all,
      };
    },
    docsPath: "/channels/bluebubbles",
    id: "bluebubbles",
    label: "BlueBubbles",
    messaging: {
      normalizeTarget: (raw) => {
        const trimmed = raw.trim().replace(/^bluebubbles:/i, "");
        const lower = trimmed.toLowerCase();
        if (lower.startsWith("chat_guid:")) {
          const guid = trimmed.slice("chat_guid:".length);
          const parts = guid.split(";");
          if (parts.length === 3 && parts[1] === "-") {
            return parts[2]?.trim() || trimmed;
          }
          return `chat_guid:${guid}`;
        }
        return trimmed;
      },
    },
  });

  it("hides BlueBubbles group actions for DM targets", () => {
    setActivePluginRegistry(
      createTestRegistry([{ plugin: bluebubblesPlugin, pluginId: "bluebubbles", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelId: "bluebubbles:chat_guid:iMessage;-;+15551234567",
      currentChannelProvider: "bluebubbles",
    });

    expect(tool.description).not.toContain("renameGroup");
    expect(tool.description).not.toContain("addParticipant");
    expect(tool.description).not.toContain("removeParticipant");
    expect(tool.description).not.toContain("leaveGroup");
  });

  it("includes other configured channels when currentChannel is set", () => {
    const signalPlugin = createChannelPlugin({
      actions: ["send", "react"],
      blurb: "Signal test plugin.",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
    });

    const telegramPluginFull = createChannelPlugin({
      actions: ["send", "react", "delete", "edit", "topic-create"],
      blurb: "Telegram test plugin.",
      docsPath: "/channels/telegram",
      id: "telegram",
      label: "Telegram",
    });

    setActivePluginRegistry(
      createTestRegistry([
        { plugin: signalPlugin, pluginId: "signal", source: "test" },
        { plugin: telegramPluginFull, pluginId: "telegram", source: "test" },
      ]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    // Current channel actions are listed
    expect(tool.description).toContain("Current channel (signal) supports: react, send.");
    // Other configured channels are also listed
    expect(tool.description).toContain("Other configured channels:");
    expect(tool.description).toContain("telegram (delete, edit, react, send, topic-create)");
  });

  it("normalizes channel aliases before building the current channel description", () => {
    const signalPlugin = createChannelPlugin({
      actions: ["send", "react"],
      aliases: ["sig"],
      blurb: "Signal test plugin.",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
    });

    setActivePluginRegistry(
      createTestRegistry([{ plugin: signalPlugin, pluginId: "signal", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "sig",
    });

    expect(tool.description).toContain("Current channel (signal) supports: react, send.");
  });

  it("does not include 'Other configured channels' when only one channel is configured", () => {
    setActivePluginRegistry(
      createTestRegistry([{ plugin: bluebubblesPlugin, pluginId: "bluebubbles", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "bluebubbles",
    });

    expect(tool.description).toContain("Current channel (bluebubbles) supports:");
    expect(tool.description).not.toContain("Other configured channels");
  });

  it("includes the thread read hint when the current channel supports read", () => {
    const signalPlugin = createChannelPlugin({
      actions: ["send", "read", "react"],
      blurb: "Signal test plugin.",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
    });

    setActivePluginRegistry(
      createTestRegistry([{ plugin: signalPlugin, pluginId: "signal", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    expect(tool.description).toContain('Use action="read" with threadId');
  });

  it("omits the thread read hint when the current channel does not support read", () => {
    const signalPlugin = createChannelPlugin({
      actions: ["send", "react"],
      blurb: "Signal test plugin.",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
    });

    setActivePluginRegistry(
      createTestRegistry([{ plugin: signalPlugin, pluginId: "signal", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    expect(tool.description).not.toContain('Use action="read" with threadId');
  });

  it("includes the thread read hint in the generic fallback when configured actions include read", () => {
    const signalPlugin = createChannelPlugin({
      actions: ["read"],
      blurb: "Signal test plugin.",
      docsPath: "/channels/signal",
      id: "signal",
      label: "Signal",
    });

    setActivePluginRegistry(
      createTestRegistry([{ plugin: signalPlugin, pluginId: "signal", source: "test" }]),
    );

    const tool = createMessageTool({
      config: {} as never,
    });

    expect(tool.description).toContain("Supports actions:");
    expect(tool.description).toContain('Use action="read" with threadId');
  });
});

describe("message tool reasoning tag sanitization", () => {
  it.each([
    {
      channel: "signal",
      expected: "Hello!",
      field: "text",
      input: "<think>internal reasoning</think>Hello!",
      target: "signal:+15551234567",
    },
    {
      channel: "discord",
      expected: "Reply text",
      field: "content",
      input: "<think>reasoning here</think>Reply text",
      target: "discord:123",
    },
    {
      channel: "signal",
      expected: "Normal message without any tags",
      field: "text",
      input: "Normal message without any tags",
      target: "signal:+15551234567",
    },
  ])(
    "sanitizes reasoning tags in $field before sending",
    async ({ channel, target, field, input, expected }) => {
      mockSendResult({ channel, to: target });

      const call = await executeSend({
        action: {
          target,
          [field]: input,
        },
      });
      expect(call?.params?.[field]).toBe(expected);
    },
  );
});

describe("message tool sandbox passthrough", () => {
  it.each([
    {
      expected: "/tmp/sandbox",
      name: "forwards sandboxRoot to runMessageAction",
      toolOptions: { sandboxRoot: "/tmp/sandbox" },
    },
    {
      expected: undefined,
      name: "omits sandboxRoot when not configured",
      toolOptions: {},
    },
  ])("$name", async ({ toolOptions, expected }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      action: {
        message: "",
        target: "telegram:123",
      },
      toolOptions,
    });
    expect(call?.sandboxRoot).toBe(expected);
  });

  it("forwards trusted requesterSenderId to runMessageAction", async () => {
    mockSendResult({ to: "discord:123" });

    const call = await executeSend({
      action: {
        message: "hi",
        target: "discord:123",
      },
      toolOptions: { requesterSenderId: "1234567890" },
    });

    expect(call?.requesterSenderId).toBe("1234567890");
  });
});
