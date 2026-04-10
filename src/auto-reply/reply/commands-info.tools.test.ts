import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveToolInventoryResult } from "../../agents/tools-effective-inventory.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function makeInventoryEntry(params: {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin" | "channel";
  pluginId?: string;
  channelId?: string;
}) {
  return {
    ...params,
    rawDescription: params.description,
  };
}

function makeDefaultInventory(): EffectiveToolInventoryResult {
  return {
    agentId: "main",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          makeInventoryEntry({
            description: "Run shell commands",
            id: "exec",
            label: "Exec",
            source: "core",
          }),
        ],
      },
      {
        id: "plugin",
        label: "Connected tools",
        source: "plugin",
        tools: [
          makeInventoryEntry({
            description: "Search internal documentation",
            id: "docs_lookup",
            label: "Docs Lookup",
            pluginId: "docs",
            source: "plugin",
          }),
        ],
      },
    ],
    profile: "coding",
  };
}

const toolsTestState = vi.hoisted(() => {
  const defaultResolveTools = (): EffectiveToolInventoryResult => makeDefaultInventory();

  return {
    replyToMode: "all" as const,
    resolveToolsImpl: defaultResolveTools,
    resolveToolsMock: vi.fn((..._args: unknown[]) => defaultResolveTools()),
    threadingContext: {
      currentChannelId: "channel-123",
      currentMessageId: "message-456",
    },
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: () => "main",
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: (...args: unknown[]) => toolsTestState.resolveToolsMock(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildThreadingToolContext: () => toolsTestState.threadingContext,
}));

vi.mock("./reply-threading.js", () => ({
  resolveReplyToMode: () => toolsTestState.replyToMode,
}));

let buildCommandTestParams: typeof import("./commands.test-harness.js").buildCommandTestParams;
let handleToolsCommand: typeof import("./commands-info.js").handleToolsCommand;

async function loadToolsHarness(options?: { resolveTools?: () => EffectiveToolInventoryResult }) {
  toolsTestState.resolveToolsImpl = options?.resolveTools ?? (() => makeDefaultInventory());
  toolsTestState.resolveToolsMock.mockImplementation((..._args: unknown[]) =>
    toolsTestState.resolveToolsImpl(),
  );

  return {
    buildCommandTestParams,
    handleToolsCommand,
    resolveToolsMock: toolsTestState.resolveToolsMock,
  };
}

function buildConfig() {
  return {
    channels: { whatsapp: { allowFrom: ["*"] } },
    commands: { text: true },
  } as OpenClawConfig;
}

describe("handleToolsCommand", () => {
  beforeAll(async () => {
    ({ buildCommandTestParams } = await import("./commands.test-harness.js"));
    ({ handleToolsCommand } = await import("./commands-info.js"));
  });

  beforeEach(() => {
    toolsTestState.resolveToolsMock.mockReset();
    toolsTestState.resolveToolsImpl = () => makeDefaultInventory();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("renders a product-facing tool list", async () => {
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      AccountId: "acct-1",
      ChatType: "group",
      From: "telegram:group:abc123",
      GroupChannel: "#ops",
      GroupSpace: "workspace-1",
      MessageThreadId: 99,
      Provider: "telegram",
      SenderE164: "+1000",
      SenderName: "User Name",
      SenderUsername: "user_name",
    };

    const result = await handleToolsCommand(params, true);

    expect(result?.reply?.text).toContain("Available tools");
    expect(result?.reply?.text).toContain("Profile: coding");
    expect(result?.reply?.text).toContain("Built-in tools");
    expect(result?.reply?.text).toContain("exec");
    expect(result?.reply?.text).toContain("Connected tools");
    expect(result?.reply?.text).toContain("docs_lookup (docs)");
    expect(result?.reply?.text).not.toContain("unavailable right now");
    expect(resolveToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        currentChannelId: "channel-123",
        currentMessageId: "message-456",
        currentThreadTs: "99",
        groupChannel: "#ops",
        groupId: "abc123",
        groupSpace: "workspace-1",
        replyToMode: "all",
        senderE164: "+1000",
        senderId: undefined,
        senderIsOwner: false,
        senderName: "User Name",
        senderUsername: "user_name",
      }),
    );
  });

  it("returns usage when arguments are provided", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools extra", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result).toEqual({
      reply: { text: "Usage: /tools [compact|verbose]" },
      shouldContinue: false,
    });
  });

  it("does not synthesize group ids for direct-chat sender ids", async () => {
    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.ctx = {
      ...params.ctx,
      ChatType: "dm",
      From: "telegram:8231046597",
      Provider: "telegram",
    };

    await handleToolsCommand(params, true);

    expect(resolveToolsMock).toHaveBeenCalledWith(expect.objectContaining({ groupId: undefined }));
  });

  it("renders the detailed tool list in verbose mode", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools verbose", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result?.reply?.text).toContain("What this agent can use right now:");
    expect(result?.reply?.text).toContain("Profile: coding");
    expect(result?.reply?.text).toContain("Exec - Run shell commands");
    expect(result?.reply?.text).toContain("Docs Lookup - Search internal documentation");
  });

  it("accepts explicit compact mode", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const result = await handleToolsCommand(
      buildCommandTestParams("/tools compact", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result?.reply?.text).toContain("exec");
    expect(result?.reply?.text).toContain("Use /tools verbose for descriptions.");
  });

  it("ignores unauthorized senders", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness();
    const params = buildCommandTestParams("/tools", buildConfig(), undefined, {
      workspaceDir: "/tmp",
    });
    params.command = {
      ...params.command,
      isAuthorizedSender: false,
      senderId: "unauthorized",
    };

    const result = await handleToolsCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
  });

  it("uses the configured default account when /tools omits AccountId", async () => {
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
              id: "telegram",
              label: "Telegram",
            }),
          },
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const { buildCommandTestParams, handleToolsCommand, resolveToolsMock } =
      await loadToolsHarness();
    const params = buildCommandTestParams(
      "/tools",
      {
        channels: { telegram: { defaultAccount: "work" } },
        commands: { text: true },
      } as OpenClawConfig,
      undefined,
      { workspaceDir: "/tmp" },
    );
    params.agentId = "main";
    params.provider = "openai";
    params.model = "gpt-4.1";
    params.ctx = {
      ...params.ctx,
      AccountId: undefined,
      ChatType: "group",
      OriginatingChannel: "telegram",
      Provider: "telegram",
      Surface: "telegram",
    };
    params.command = {
      ...params.command,
      channel: "telegram",
    };

    await handleToolsCommand(params, true);

    expect(resolveToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
      }),
    );
  });

  it("returns a concise fallback error on effective inventory failures", async () => {
    const { buildCommandTestParams, handleToolsCommand } = await loadToolsHarness({
      resolveTools: () => {
        throw new Error("boom");
      },
    });

    const result = await handleToolsCommand(
      buildCommandTestParams("/tools", buildConfig(), undefined, { workspaceDir: "/tmp" }),
      true,
    );

    expect(result).toEqual({
      reply: { text: "Couldn't load available tools right now. Try again in a moment." },
      shouldContinue: false,
    });
  });
});
