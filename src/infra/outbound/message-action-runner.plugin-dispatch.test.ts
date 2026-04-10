import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import { extractToolPayload } from "./tool-payload.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const mocks = vi.hoisted(() => ({
  executePollAction: vi.fn(),
  executeSendAction: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  resetOutboundChannelResolutionStateForTest: vi.fn(),
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./outbound-send-service.js", () => ({
  executePollAction: mocks.executePollAction,
  executeSendAction: mocks.executeSendAction,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "feishu"
      ? {
          actions: {
            messageActionTargetAliases: {
              "list-pins": { aliases: ["chatId"] },
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
            },
          },
        }
      : undefined,
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  return createOutboundThreadingMock();
});

function createAlwaysConfiguredPluginConfig(account: Record<string, unknown> = { enabled: true }) {
  return {
    isConfigured: () => true,
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
  };
}

function createPollForwardingPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  return {
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: params.handleAction,
      supportsAction: ({ action }) => action === "poll",
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    id: params.pluginId,
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    meta: {
      blurb: params.blurb,
      docsPath: `/channels/${params.pluginId}`,
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
    },
  };
}

async function executePluginAction(params: {
  action: "send" | "poll";
  ctx: Pick<
    ChannelMessageActionContext,
    "channel" | "cfg" | "params" | "mediaAccess" | "accountId" | "gateway" | "toolContext"
  > & {
    dryRun: boolean;
    agentId?: string;
  };
}) {
  const handled = await dispatchChannelMessageAction({
    accountId: params.ctx.accountId ?? undefined,
    action: params.action,
    agentId: params.ctx.agentId,
    cfg: params.ctx.cfg,
    channel: params.ctx.channel,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
    mediaAccess: params.ctx.mediaAccess,
    mediaLocalRoots: params.ctx.mediaAccess?.localRoots ?? [],
    mediaReadFile:
      typeof params.ctx.mediaAccess?.readFile === "function"
        ? params.ctx.mediaAccess.readFile
        : undefined,
    params: params.ctx.params,
    toolContext: params.ctx.toolContext,
  });
  if (!handled) {
    throw new Error(`expected plugin to handle ${params.action}`);
  }
  return {
    handledBy: "plugin" as const,
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    mocks.executeSendAction.mockReset();
    mocks.executeSendAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "send", ctx }),
    );
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "poll", ctx }),
    );
  });

  describe("alias-based plugin action dispatch", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        params,
      }),
    );

    const feishuLikePlugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["pin", "list-pins", "member-info"] }),
        handleAction,
        supportsAction: ({ action }) =>
          action === "pin" || action === "list-pins" || action === "member-info",
      },
      capabilities: { chatTypes: ["direct", "channel"] },
      config: createAlwaysConfiguredPluginConfig(),
      id: "feishu",
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
        },
      },
      meta: {
        blurb: "Feishu action dispatch test plugin.",
        docsPath: "/channels/feishu",
        id: "feishu",
        label: "Feishu",
        selectionLabel: "Feishu",
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: feishuLikePlugin,
            pluginId: "feishu",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    it("dispatches messageId/chatId-based Feishu actions through the shared runner", async () => {
      await runMessageAction({
        action: "pin",
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        dryRun: false,
        params: {
          channel: "feishu",
          messageId: "om_123",
        },
      });

      await runMessageAction({
        action: "list-pins",
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        dryRun: false,
        params: {
          channel: "feishu",
          chatId: "oc_123",
        },
      });

      expect(handleAction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: "pin",
          params: expect.objectContaining({
            messageId: "om_123",
          }),
        }),
      );
      expect(handleAction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: "list-pins",
          params: expect.objectContaining({
            chatId: "oc_123",
          }),
        }),
      );
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      await runMessageAction({
        action: "pin",
        agentId: "alpha",
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        defaultAccountId: "ops",
        dryRun: false,
        params: {
          channel: "feishu",
          messageId: "om_123",
        },
        requesterSenderId: "trusted-user",
        sessionId: "session-123",
        sessionKey: "agent:alpha:main",
        toolContext: {
          currentChannelId: "oc_123",
          currentChannelProvider: "feishu",
          currentMessageId: "msg-789",
          currentThreadTs: "thread-456",
        },
      });

      expect(handleAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: "ops",
          action: "pin",
          agentId: "alpha",
          mediaLocalRoots: expect.arrayContaining([expectedWorkspaceRoot]),
          requesterSenderId: "trusted-user",
          sessionId: "session-123",
          sessionKey: "agent:alpha:main",
          toolContext: expect.objectContaining({
            currentChannelId: "oc_123",
            currentChannelProvider: "feishu",
            currentMessageId: "msg-789",
            currentThreadTs: "thread-456",
          }),
        }),
      );
    });
  });

  describe("card-only send behavior", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        card: params.card ?? null,
        message: params.message ?? null,
        ok: true,
      }),
    );

    const cardPlugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
        supportsAction: ({ action }) => action === "send",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig(),
      id: "cardchat",
      meta: {
        blurb: "Card-only send test plugin.",
        docsPath: "/channels/cardchat",
        id: "cardchat",
        label: "Card Chat",
        selectionLabel: "Card Chat",
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: cardPlugin,
            pluginId: "cardchat",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("allows card-only sends without text or media", async () => {
      const cfg = {
        channels: {
          cardchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      const card = {
        body: [{ text: "Card-only payload", type: "TextBlock" }],
        type: "AdaptiveCard",
        version: "1.4",
      };

      const result = await runMessageAction({
        action: "send",
        cfg,
        dryRun: false,
        params: {
          card,
          channel: "cardchat",
          target: "channel:test-card",
        },
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).toHaveBeenCalled();
      expect(result.payload).toMatchObject({
        card,
        ok: true,
      });
    });
  });

  describe("telegram plugin poll forwarding", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        forwarded: {
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollOption: params.pollOption ?? null,
          pollPublic: params.pollPublic ?? null,
          pollQuestion: params.pollQuestion ?? null,
          threadId: params.threadId ?? null,
          to: params.to ?? null,
        },
        ok: true,
      }),
    );

    const telegramPollPlugin = createPollForwardingPlugin({
      blurb: "Telegram poll forwarding test plugin.",
      handleAction,
      label: "Telegram",
      pluginId: "telegram",
    });

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: telegramPollPlugin,
            pluginId: "telegram",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("forwards telegram poll params through plugin dispatch", async () => {
      const result = await runMessageAction({
        action: "poll",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        dryRun: false,
        params: {
          channel: "telegram",
          pollDurationSeconds: 120,
          pollOption: ["Pizza", "Sushi"],
          pollPublic: true,
          pollQuestion: "Lunch?",
          target: "telegram:123",
          threadId: "42",
        },
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "poll",
          channel: "telegram",
          params: expect.objectContaining({
            pollDurationSeconds: 120,
            pollOption: ["Pizza", "Sushi"],
            pollPublic: true,
            pollQuestion: "Lunch?",
            threadId: "42",
            to: "telegram:123",
          }),
        }),
      );
      expect(result.payload).toMatchObject({
        forwarded: {
          pollDurationSeconds: 120,
          pollOption: ["Pizza", "Sushi"],
          pollPublic: true,
          pollQuestion: "Lunch?",
          threadId: "42",
          to: "telegram:123",
        },
        ok: true,
      });
    });
  });

  describe("plugin-owned poll semantics", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        forwarded: {
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollOption: params.pollOption ?? null,
          pollPublic: params.pollPublic ?? null,
          pollQuestion: params.pollQuestion ?? null,
          to: params.to ?? null,
        },
        ok: true,
      }),
    );

    const discordPollPlugin = createPollForwardingPlugin({
      blurb: "Discord plugin-owned poll test plugin.",
      handleAction,
      label: "Discord",
      pluginId: "discord",
    });

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: discordPollPlugin,
            pluginId: "discord",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("lets non-telegram plugins own extra poll fields", async () => {
      const result = await runMessageAction({
        action: "poll",
        cfg: {
          channels: {
            discord: {
              token: "tok",
            },
          },
        } as OpenClawConfig,
        dryRun: false,
        params: {
          channel: "discord",
          pollDurationSeconds: 120,
          pollOption: ["Pizza", "Sushi"],
          pollPublic: true,
          pollQuestion: "Lunch?",
          target: "channel:123",
        },
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "poll",
          channel: "discord",
          params: expect.objectContaining({
            pollDurationSeconds: 120,
            pollOption: ["Pizza", "Sushi"],
            pollPublic: true,
            pollQuestion: "Lunch?",
            to: "channel:123",
          }),
        }),
      );
    });
  });

  describe("components parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        components: params.components ?? null,
        ok: true,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
        supportsAction: ({ action }) => action === "send",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      id: "discord",
      meta: {
        blurb: "Discord components send test plugin.",
        docsPath: "/channels/discord",
        id: "discord",
        label: "Discord",
        selectionLabel: "Discord",
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: componentsPlugin,
            pluginId: "discord",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses components JSON strings before plugin dispatch", async () => {
      const components = {
        buttons: [{ customId: "a", label: "A" }],
        text: "hello",
      };
      const result = await runMessageAction({
        action: "send",
        cfg: {} as OpenClawConfig,
        dryRun: false,
        params: {
          channel: "discord",
          components: JSON.stringify(components),
          message: "hi",
          target: "channel:123",
        },
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expect(result.payload).toMatchObject({ components, ok: true });
    });

    it("throws on invalid components JSON strings", async () => {
      await expect(
        runMessageAction({
          action: "send",
          cfg: {} as OpenClawConfig,
          dryRun: false,
          params: {
            channel: "discord",
            components: "{not-json}",
            message: "hi",
            target: "channel:123",
          },
        }),
      ).rejects.toThrow(/--components must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });

  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const accountPlugin: ChannelPlugin = {
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      id: "discord",
      meta: {
        blurb: "Discord test plugin.",
        docsPath: "/channels/discord",
        id: "discord",
        label: "Discord",
        selectionLabel: "Discord",
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            plugin: accountPlugin,
            pluginId: "discord",
            source: "test",
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each([
      {
        args: {
          cfg: {} as OpenClawConfig,
          defaultAccountId: "ops",
        },
        expectedAccountId: "ops",
        name: "uses defaultAccountId override",
      },
      {
        args: {
          agentId: "agent-b",
          cfg: {
            bindings: [
              { agentId: "agent-b", match: { accountId: "account-b", channel: "discord" } },
            ],
          } as OpenClawConfig,
        },
        expectedAccountId: "account-b",
        name: "falls back to agent binding account",
      },
    ])("$name", async ({ args, expectedAccountId }) => {
      await runMessageAction({
        ...args,
        action: "send",
        params: {
          channel: "discord",
          message: "hi",
          target: "channel:123",
        },
      });

      expect(handleAction).toHaveBeenCalled();
      const ctx = (handleAction.mock.calls as unknown as [unknown][])[0]?.[0] as
        | {
            accountId?: string | null;
            params: Record<string, unknown>;
          }
        | undefined;
      if (!ctx) {
        throw new Error("expected action context");
      }
      expect(ctx.accountId).toBe(expectedAccountId);
      expect(ctx.params.accountId).toBe(expectedAccountId);
    });
  });
});
