import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv } from "../test-utils/env.js";

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ changes: [], config })));
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

const { resolveCommandSecretRefsViaGateway, callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    diagnostics: [] as string[],
    resolvedConfig: config,
  })),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  callGatewayLeastPrivilege: callGatewayMock,
  randomIdempotencyKey: () => "idem-1",
}));

const handleDiscordAction = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } })),
);

const handleTelegramAction = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } })),
);

let messageCommand: typeof import("./message.js").messageCommand;

let envSnapshot: ReturnType<typeof captureEnv>;
const EMPTY_TEST_REGISTRY = createTestRegistry([]);

beforeAll(async () => {
  ({ messageCommand } = await import("./message.js"));
});

beforeEach(() => {
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  setActivePluginRegistry(EMPTY_TEST_REGISTRY);
  callGatewayMock.mockClear();
  handleDiscordAction.mockClear();
  handleTelegramAction.mockClear();
  resolveCommandSecretRefsViaGateway.mockClear();
  applyPluginAutoEnable.mockClear();
  applyPluginAutoEnable.mockImplementation(({ config }) => ({ changes: [], config }));
});

afterEach(() => {
  envSnapshot.restore();
});

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
  log: vi.fn(),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageDiscord: vi.fn(),
  sendMessageIMessage: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageWhatsApp: vi.fn(),
  ...overrides,
});

const createStubPlugin = (params: {
  id: ChannelPlugin["id"];
  label?: string;
  actions?: ChannelMessageActionAdapter;
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  actions: params.actions,
  capabilities: { chatTypes: ["direct"] },
  config: {
    isConfigured: async () => true,
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
  },
  id: params.id,
  meta: {
    blurb: "test stub.",
    docsPath: `/channels/${params.id}`,
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
  },
  outbound: params.outbound,
});

type ChannelActionParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>
>[0];

const createDiscordPollPluginRegistration = () => ({
  plugin: createStubPlugin({
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleDiscordAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
    id: "discord",
    label: "Discord",
  }),
  pluginId: "discord",
  source: "test",
});

const createTelegramSendPluginRegistration = () => ({
  plugin: createStubPlugin({
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
    id: "telegram",
    label: "Telegram",
  }),
  pluginId: "telegram",
  source: "test",
});

const createTelegramPollPluginRegistration = () => ({
  plugin: createStubPlugin({
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      handleAction: (async ({ action, params, cfg, accountId }: ChannelActionParams) => {
        return await handleTelegramAction(
          { action, to: params.to, accountId: accountId ?? undefined },
          cfg,
        );
      }) as unknown as NonNullable<ChannelPlugin["actions"]>["handleAction"],
    },
    id: "telegram",
    label: "Telegram",
  }),
  pluginId: "telegram",
  source: "test",
});

function createTelegramSecretRawConfig() {
  return {
    channels: {
      telegram: {
        token: { $secret: "vault://telegram/token" }, // Pragma: allowlist secret
      },
    },
  };
}

function createTelegramResolvedTokenConfig(token: string) {
  return {
    channels: {
      telegram: {
        token,
      },
    },
  };
}

function mockResolvedCommandConfig(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  testConfig = params.rawConfig;
  resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
    diagnostics: params.diagnostics ?? ["resolved channels.telegram.token"],
    resolvedConfig: params.resolvedConfig,
  });
}

async function runTelegramDirectOutboundSend(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  mockResolvedCommandConfig(params);
  const sendText = vi.fn(async (_ctx: { cfg?: unknown; to?: string; text?: string }) => ({
    channel: "telegram" as const,
    chatId: "123456",
    messageId: "msg-1",
  }));
  const sendMedia = vi.fn(async (_ctx: { cfg?: unknown }) => ({
    channel: "telegram" as const,
    chatId: "123456",
    messageId: "msg-2",
  }));
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: createStubPlugin({
          id: "telegram",
          label: "Telegram",
          outbound: {
            deliveryMode: "direct",
            sendMedia,
            sendText,
          },
        }),
        pluginId: "telegram",
        source: "test",
      },
    ]),
  );

  const deps = makeDeps();
  await messageCommand(
    {
      action: "send",
      channel: "telegram",
      message: "hi",
      target: "123456",
    },
    deps,
    runtime,
  );

  return { sendText };
}

describe("messageCommand", () => {
  it("threads resolved SecretRef config into outbound adapter sends", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    const { sendText } = await runTelegramDirectOutboundSend({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
        text: "hi",
        to: "123456",
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
  });

  it("keeps local-fallback resolved cfg in outbound adapter sends", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
        },
      },
    };
    const locallyResolvedConfig = {
      channels: {
        telegram: {
          token: "12345:local-fallback-token",
        },
      },
    };
    const { sendText } = await runTelegramDirectOutboundSend({
      diagnostics: ["gateway secrets.resolve unavailable; used local resolver fallback."],
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: locallyResolvedConfig as unknown as Record<string, unknown>,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: locallyResolvedConfig,
      }),
    );
    expect(sendText.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("[secrets] gateway secrets.resolve unavailable"),
    );
  });

  it("defaults channel when only one configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        message: "hi",
        target: "123456",
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalled();
  });

  it("defaults channel from the auto-enabled config snapshot when only one channel becomes configured", async () => {
    const rawConfig = {};
    const resolvedConfig = {};
    const autoEnabledConfig = {
      channels: {
        telegram: {
          token: "12345:auto-enabled-token",
        },
      },
      plugins: { allow: ["telegram"] },
    };
    mockResolvedCommandConfig({
      diagnostics: [],
      rawConfig,
      resolvedConfig,
    });
    applyPluginAutoEnable.mockReturnValue({ changes: [], config: autoEnabledConfig });
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
      ]),
    );

    const deps = makeDeps();
    await messageCommand(
      {
        message: "hi",
        target: "123456",
      },
      deps,
      runtime,
    );

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
    });
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        to: "123456",
      }),
      autoEnabledConfig,
    );
  });

  it("requires channel when multiple configured", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-abc";
    process.env.DISCORD_BOT_TOKEN = "token-discord";
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramSendPluginRegistration(),
        },
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await expect(
      messageCommand(
        {
          message: "hi",
          target: "123",
        },
        deps,
        runtime,
      ),
    ).rejects.toThrow(/Channel is required/);
  });

  it("sends via gateway for WhatsApp", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createStubPlugin({
            id: "whatsapp",
            label: "WhatsApp",
            outbound: {
              deliveryMode: "gateway",
            },
          }),
          pluginId: "whatsapp",
          source: "test",
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "send",
        channel: "whatsapp",
        message: "hi",
        target: "+15551234567",
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalled();
  });

  it("routes discord polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createDiscordPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "discord",
        pollOption: ["Pizza", "Sushi"],
        pollQuestion: "Snack?",
        target: "channel:123456789",
      },
      deps,
      runtime,
    );
    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "channel:123456789",
      }),
      expect.any(Object),
    );
  });

  it("routes telegram polls through message action", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          ...createTelegramPollPluginRegistration(),
        },
      ]),
    );
    const deps = makeDeps();
    await messageCommand(
      {
        action: "poll",
        channel: "telegram",
        pollDurationSeconds: 120,
        pollOption: ["Yes", "No"],
        pollQuestion: "Ship it?",
        target: "123456789",
      },
      deps,
      runtime,
    );
    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        to: "123456789",
      }),
      expect.any(Object),
    );
  });
});
