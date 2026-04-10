import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveApprovalApprovers } from "../../plugin-sdk/approval-approvers.js";
import {
  createApproverRestrictedNativeApprovalAdapter,
  createResolvedApproverActionAuthAdapter,
} from "../../plugin-sdk/approval-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleApproveCommand } from "./commands-approve.js";
import type { HandleCommandsParams } from "./commands-types.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

function normalizeDiscordDirectApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(discord|user|pk):/i, "")
    .replace(/^<@!?(\d+)>$/, "$1")
    .toLowerCase();
  return normalized || undefined;
}

function getDiscordExecApprovalApproversForTests(params: { cfg: OpenClawConfig }): string[] {
  const discord = params.cfg.channels?.discord;
  return resolveApprovalApprovers({
    allowFrom: discord?.allowFrom,
    defaultTo: discord?.defaultTo,
    explicit: discord?.execApprovals?.approvers,
    extraAllowFrom: discord?.dm?.allowFrom,
    normalizeApprover: normalizeDiscordDirectApproverId,
    normalizeDefaultTo: (value) => normalizeDiscordDirectApproverId(value),
  });
}

const discordNativeApprovalAdapterForTests = createApproverRestrictedNativeApprovalAdapter({
  channel: "discord",
  channelLabel: "Discord",
  hasApprovers: ({ cfg }) => getDiscordExecApprovalApproversForTests({ cfg }).length > 0,
  isExecAuthorizedSender: ({ cfg, senderId }) => {
    const normalizedSenderId =
      senderId === undefined || senderId === null
        ? undefined
        : normalizeDiscordDirectApproverId(senderId);
    return Boolean(
      normalizedSenderId &&
      getDiscordExecApprovalApproversForTests({ cfg }).includes(normalizedSenderId),
    );
  },
  isNativeDeliveryEnabled: ({ cfg }) =>
    Boolean(cfg.channels?.discord?.execApprovals?.enabled) &&
    getDiscordExecApprovalApproversForTests({ cfg }).length > 0,
  listAccountIds: () => [DEFAULT_ACCOUNT_ID],
  resolveNativeDeliveryMode: ({ cfg }) => cfg.channels?.discord?.execApprovals?.target ?? "dm",
});

const discordApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      nativeCommands: true,
      reactions: true,
      threads: true,
    },
    docsPath: "/channels/discord",
    id: "discord",
    label: "Discord",
  }),
  approvalCapability: {
    authorizeActorAction: discordNativeApprovalAdapterForTests.auth.authorizeActorAction,
    getActionAvailabilityState:
      discordNativeApprovalAdapterForTests.auth.getActionAvailabilityState,
  },
};

const slackApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      nativeCommands: true,
      reactions: true,
      threads: true,
    },
    docsPath: "/channels/slack",
    id: "slack",
    label: "Slack",
  }),
};

const signalApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      nativeCommands: true,
      reactions: true,
    },
    docsPath: "/channels/signal",
    id: "signal",
    label: "Signal",
  }),
  approvalCapability: createResolvedApproverActionAuthAdapter({
    channelLabel: "Signal",
    resolveApprovers: ({ cfg, accountId }) => {
      const signal = accountId ? cfg.channels?.signal?.accounts?.[accountId] : cfg.channels?.signal;
      return resolveApprovalApprovers({
        allowFrom: signal?.allowFrom,
        defaultTo: signal?.defaultTo,
        normalizeApprover: (value) => String(value).trim() || undefined,
      });
    },
  }),
};

interface TelegramTestAccountConfig {
  enabled?: boolean;
  allowFrom?: (string | number)[];
  execApprovals?: {
    enabled?: boolean;
    approvers?: string[];
    target?: "dm" | "channel" | "both";
  };
}

type TelegramTestSectionConfig = TelegramTestAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, TelegramTestAccountConfig>;
};

function listConfiguredTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  const accountIds = Object.keys(channel?.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  if (!channel) {
    return [];
  }
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...base } = channel;
  return Object.values(base).some((value) => value !== undefined) ? [DEFAULT_ACCOUNT_ID] : [];
}

function resolveTelegramTestAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramTestAccountConfig {
  const resolvedAccountId = normalizeAccountId(accountId);
  const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  const scoped = channel?.accounts?.[resolvedAccountId];
  const base = resolvedAccountId === DEFAULT_ACCOUNT_ID ? channel : undefined;
  return {
    ...base,
    ...scoped,
    enabled:
      typeof scoped?.enabled === "boolean"
        ? scoped.enabled
        : typeof channel?.enabled === "boolean"
          ? channel.enabled
          : true,
  };
}

function stripTelegramInternalPrefixes(value: string): string {
  let trimmed = value.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

function normalizeTelegramDirectApproverId(value: string | number): string | undefined {
  const normalized = stripTelegramInternalPrefixes(String(value));
  if (!normalized || normalized.startsWith("-")) {
    return undefined;
  }
  return normalized;
}

function getTelegramExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveTelegramTestAccount(params.cfg, params.accountId);
  return resolveApprovalApprovers({
    allowFrom: account.allowFrom,
    explicit: account.execApprovals?.approvers,
    normalizeApprover: normalizeTelegramDirectApproverId,
  });
}

function isTelegramExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  const senderId = params.senderId?.trim();
  const execApprovals = params.cfg.approvals?.exec;
  if (
    !senderId ||
    execApprovals?.enabled !== true ||
    (execApprovals.mode !== "targets" && execApprovals.mode !== "both")
  ) {
    return false;
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  return (execApprovals.targets ?? []).some((target) => {
    if (target.channel?.trim().toLowerCase() !== "telegram") {
      return false;
    }
    if (accountId && target.accountId && normalizeAccountId(target.accountId) !== accountId) {
      return false;
    }
    const to = target.to ? normalizeTelegramDirectApproverId(target.to) : undefined;
    return Boolean(to && to === senderId);
  });
}

function isTelegramExecApprovalAuthorizedSender(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const senderId = params.senderId ? normalizeTelegramDirectApproverId(params.senderId) : undefined;
  if (!senderId) {
    return false;
  }
  return (
    getTelegramExecApprovalApprovers(params).includes(senderId) ||
    isTelegramExecApprovalTargetRecipient(params)
  );
}

function isTelegramExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveTelegramTestAccount(params.cfg, params.accountId).execApprovals;
  return Boolean(config?.enabled && getTelegramExecApprovalApprovers(params).length > 0);
}

function resolveTelegramExecApprovalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): "dm" | "channel" | "both" {
  return resolveTelegramTestAccount(params.cfg, params.accountId).execApprovals?.target ?? "dm";
}

const telegramNativeApprovalAdapter = createApproverRestrictedNativeApprovalAdapter({
  channel: "telegram",
  channelLabel: "Telegram",
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ accountId, cfg }).length > 0,
  isExecAuthorizedSender: isTelegramExecApprovalAuthorizedSender,
  isNativeDeliveryEnabled: isTelegramExecApprovalClientEnabled,
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) => {
    const normalizedSenderId = senderId?.trim();
    return Boolean(
      normalizedSenderId &&
      getTelegramExecApprovalApprovers({ accountId, cfg }).includes(normalizedSenderId),
    );
  },
  listAccountIds: listConfiguredTelegramAccountIds,
  requireMatchingTurnSourceChannel: true,
  resolveNativeDeliveryMode: resolveTelegramExecApprovalTarget,
});

const telegramApproveTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group", "channel", "thread"],
      media: true,
      nativeCommands: true,
      polls: true,
      reactions: true,
      threads: true,
    },
    config: {
      defaultAccountId: (cfg) =>
        (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
        DEFAULT_ACCOUNT_ID,
      listAccountIds: listConfiguredTelegramAccountIds,
      resolveAccount: (cfg, accountId) => resolveTelegramTestAccount(cfg, accountId),
    },
    docsPath: "/channels/telegram",
    id: "telegram",
    label: "Telegram",
  }),
  approvalCapability: {
    authorizeActorAction: telegramNativeApprovalAdapter.auth.authorizeActorAction,
    getActionAvailabilityState: telegramNativeApprovalAdapter.auth.getActionAvailabilityState,
    resolveApproveCommandBehavior: ({ cfg, accountId, senderId, approvalKind }) => {
      if (approvalKind !== "exec") {
        return undefined;
      }
      if (isTelegramExecApprovalClientEnabled({ accountId, cfg })) {
        return undefined;
      }
      if (isTelegramExecApprovalTargetRecipient({ accountId, cfg, senderId })) {
        return undefined;
      }
      if (
        isTelegramExecApprovalAuthorizedSender({ accountId, cfg, senderId }) &&
        !getTelegramExecApprovalApprovers({ accountId, cfg }).includes(senderId?.trim() ?? "")
      ) {
        return undefined;
      }
      return {
        kind: "reply",
        text: "❌ Telegram exec approvals are not enabled for this bot account.",
      } as const;
    },
  },
};

function setApprovePluginRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      { plugin: discordApproveTestPlugin, pluginId: "discord", source: "test" },
      { plugin: slackApproveTestPlugin, pluginId: "slack", source: "test" },
      { plugin: signalApproveTestPlugin, pluginId: "signal", source: "test" },
      { plugin: telegramApproveTestPlugin, pluginId: "telegram", source: "test" },
    ]),
  );
}

function buildApproveParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    SenderId?: string;
    GatewayClientScopes?: string[];
    AccountId?: string;
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "whatsapp";
  return {
    cfg,
    command: {
      channel: provider,
      channelId: provider,
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: ctxOverrides?.SenderId ?? "owner",
    },
    ctx: {
      AccountId: ctxOverrides?.AccountId,
      CommandSource: "text",
      GatewayClientScopes: ctxOverrides?.GatewayClientScopes,
      Provider: provider,
      SenderId: ctxOverrides?.SenderId,
      Surface: ctxOverrides?.Surface ?? provider,
    },
  } as unknown as HandleCommandsParams;
}

describe("handleApproveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApprovePluginRegistry();
  });

  function createTelegramApproveCfg(
    execApprovals: {
      enabled: true;
      approvers: string[];
      target: "dm";
    } | null = { approvers: ["123"], enabled: true, target: "dm" },
  ): OpenClawConfig {
    return {
      channels: {
        telegram: {
          allowFrom: ["*"],
          ...(execApprovals ? { execApprovals } : {}),
        },
      },
      commands: { text: true },
    } as OpenClawConfig;
  }

  function createDiscordApproveCfg(
    execApprovals: {
      enabled: boolean;
      approvers: string[];
      target: "dm" | "channel" | "both";
    } | null = { approvers: ["123"], enabled: true, target: "channel" },
  ): OpenClawConfig {
    return {
      channels: {
        discord: {
          allowFrom: ["*"],
          ...(execApprovals ? { execApprovals } : {}),
        },
      },
      commands: { text: true },
    } as OpenClawConfig;
  }

  it("rejects invalid usage", async () => {
    const result = await handleApproveCommand(
      buildApproveParams("/approve", {
        channels: { whatsapp: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /approve");
  });

  it("submits approval", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve abc allow-once",
        {
          channels: { whatsapp: { allowFrom: ["*"] } },
          commands: { text: true },
        } as OpenClawConfig,
        { SenderId: "123" },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc" },
      }),
    );
  });

  it("accepts bare approve text for Slack-style manual approvals", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "approve abc allow-once",
        {
          channels: { slack: { allowFrom: ["*"] } },
          commands: { text: true },
        } as OpenClawConfig,
        {
          Provider: "slack",
          SenderId: "U123",
          Surface: "slack",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc" },
      }),
    );
  });

  it("accepts Telegram /approve from configured approvers even when chat access is otherwise blocked", async () => {
    const params = buildApproveParams("/approve abc12345 allow-once", createTelegramApproveCfg(), {
      Provider: "telegram",
      SenderId: "123",
      Surface: "telegram",
    });
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc12345" },
      }),
    );
  });

  it("honors the configured default account for omitted-account /approve auth", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: telegramApproveTestPlugin,
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );
    callGatewayMock.mockResolvedValue({ ok: true });
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        channels: {
          telegram: {
            accounts: {
              work: {
                execApprovals: { approvers: ["123"], enabled: true, target: "dm" },
              },
            },
            allowFrom: ["*"],
            defaultAccount: "work",
          },
        },
        commands: { text: true },
      } as OpenClawConfig,
      {
        AccountId: undefined,
        Provider: "telegram",
        SenderId: "123",
        Surface: "telegram",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc12345" },
      }),
    );
  });

  it("accepts Signal /approve from configured approvers even when chat access is otherwise blocked", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        channels: {
          signal: {
            allowFrom: ["+15551230000"],
          },
        },
        commands: { text: true },
      } as OpenClawConfig,
      {
        Provider: "signal",
        SenderId: "+15551230000",
        Surface: "signal",
      },
    );
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc12345" },
      }),
    );
  });

  it("does not treat implicit default approval auth as a bypass for unauthorized senders", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        commands: { text: true },
      } as OpenClawConfig,
      {
        Provider: "webchat",
        SenderId: "123",
        Surface: "webchat",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not treat implicit same-chat approval auth as a bypass for unauthorized senders", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
            approvalCapability: {
              authorizeActorAction: () => ({ authorized: true }),
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
          },
          pluginId: "slack",
          source: "test",
        },
      ]),
    );
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        channels: { slack: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig,
      {
        Provider: "slack",
        SenderId: "U123",
        Surface: "slack",
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("accepts Telegram /approve from exec target recipients when native approvals are disabled", async () => {
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      {
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "telegram", to: "123" }],
          },
        },
        channels: {
          telegram: {
            allowFrom: ["*"],
          },
        },
        commands: { text: true },
      } as OpenClawConfig,
      {
        Provider: "telegram",
        SenderId: "123",
        Surface: "telegram",
      },
    );
    params.command.isAuthorizedSender = false;
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { decision: "allow-once", id: "abc12345" },
      }),
    );
  });

  it("requires configured Discord approvers for exec approvals", async () => {
    for (const testCase of [
      {
        cfg: createDiscordApproveCfg(null),
        expectedGatewayCalls: 0,
        expectedText: "not authorized to approve",
        name: "discord no approver policy",
        senderId: "123",
      },
      {
        cfg: createDiscordApproveCfg({ approvers: ["999"], enabled: true, target: "channel" }),
        expectedGatewayCalls: 0,
        expectedText: "not authorized to approve",
        name: "discord non approver",
        senderId: "123",
      },
      {
        cfg: createDiscordApproveCfg({ approvers: ["123"], enabled: false, target: "channel" }),
        expectedGatewayCalls: 1,
        expectedMethod: "exec.approval.resolve",
        expectedText: "Approval allow-once submitted",
        name: "discord approver with rich client disabled",
        senderId: "123",
      },
      {
        cfg: createDiscordApproveCfg({ approvers: ["123"], enabled: true, target: "channel" }),
        expectedGatewayCalls: 1,
        expectedMethod: "exec.approval.resolve",
        expectedText: "Approval allow-once submitted",
        name: "discord approver",
        senderId: "123",
      },
    ] as const) {
      callGatewayMock.mockReset();
      if (testCase.expectedGatewayCalls > 0) {
        callGatewayMock.mockResolvedValue({ ok: true });
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc12345 allow-once", testCase.cfg, {
          Provider: "discord",
          SenderId: testCase.senderId,
          Surface: "discord",
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedGatewayCalls);
      if ("expectedMethod" in testCase) {
        expect(callGatewayMock, testCase.name).toHaveBeenCalledWith(
          expect.objectContaining({
            method: testCase.expectedMethod,
            params: { decision: "allow-once", id: "abc12345" },
          }),
        );
      }
    }
  });

  it("rejects legacy unprefixed plugin approval fallback on Discord before exec fallback", async () => {
    for (const testCase of [
      {
        cfg: createDiscordApproveCfg(null),
        name: "discord legacy plugin approval with exec approvals disabled",
        senderId: "123",
      },
      {
        cfg: createDiscordApproveCfg({ approvers: ["999"], enabled: true, target: "channel" }),
        name: "discord legacy plugin approval for non approver",
        senderId: "123",
      },
    ] as const) {
      callGatewayMock.mockReset();
      callGatewayMock.mockResolvedValue({ ok: true });
      const result = await handleApproveCommand(
        buildApproveParams("/approve legacy-plugin-123 allow-once", testCase.cfg, {
          Provider: "discord",
          SenderId: testCase.senderId,
          Surface: "discord",
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain("not authorized to approve");
      expect(callGatewayMock, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("preserves legacy unprefixed plugin approval fallback on Discord", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("unknown or expired approval id"));
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve legacy-plugin-123 allow-once",
        createDiscordApproveCfg({ approvers: ["123"], enabled: true, target: "channel" }),
        {
          Provider: "discord",
          SenderId: "123",
          Surface: "discord",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "plugin.approval.resolve",
        params: { decision: "allow-once", id: "legacy-plugin-123" },
      }),
    );
  });

  it("returns the underlying not-found error for plugin-only approval routing", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            approvalCapability: {
              authorizeActorAction: ({ approvalKind }: { approvalKind: "exec" | "plugin" }) =>
                approvalKind === "plugin"
                  ? { authorized: true }
                  : {
                      authorized: false,
                      reason: "❌ You are not authorized to approve exec requests on Matrix.",
                    },
            },
          },
          pluginId: "matrix",
          source: "test",
        },
      ]),
    );
    callGatewayMock.mockRejectedValueOnce(new Error("unknown or expired approval id"));

    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve abc123 allow-once",
        {
          channels: { matrix: { allowFrom: ["*"] } },
          commands: { text: true },
        } as OpenClawConfig,
        {
          Provider: "matrix",
          SenderId: "123",
          Surface: "matrix",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Failed to submit approval");
    expect(result?.reply?.text).toContain("unknown or expired approval id");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.approval.resolve",
        params: { decision: "allow-once", id: "abc123" },
      }),
    );
  });

  it("requires configured Discord approvers for plugin approvals", async () => {
    for (const testCase of [
      {
        cfg: createDiscordApproveCfg({ approvers: ["999"], enabled: false, target: "channel" }),
        expectedGatewayCalls: 0,
        expectedText: "not authorized to approve plugin requests",
        name: "discord plugin non approver",
        senderId: "123",
      },
      {
        cfg: createDiscordApproveCfg({ approvers: ["123"], enabled: false, target: "channel" }),
        expectedGatewayCalls: 1,
        expectedText: "Approval allow-once submitted",
        name: "discord plugin approver",
        senderId: "123",
      },
    ] as const) {
      callGatewayMock.mockReset();
      if (testCase.expectedGatewayCalls > 0) {
        callGatewayMock.mockResolvedValue({ ok: true });
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve plugin:abc123 allow-once", testCase.cfg, {
          Provider: "discord",
          SenderId: testCase.senderId,
          Surface: "discord",
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectedGatewayCalls);
      if (testCase.expectedGatewayCalls > 0) {
        expect(callGatewayMock, testCase.name).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "plugin.approval.resolve",
            params: { decision: "allow-once", id: "plugin:abc123" },
          }),
        );
      }
    }
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const testCase of [
      {
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve@otherbot abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          SenderId: "123",
          Surface: "telegram",
        },
        expectGatewayCalls: 0,
        expectedText: "targets a different Telegram bot",
        name: "different bot mention",
      },
      {
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          SenderId: "123",
          Surface: "telegram",
        },
        expectGatewayCalls: 2,
        expectedText: "unknown or expired approval id",
        name: "unknown approval id",
        setup: () => callGatewayMock.mockRejectedValue(new Error("unknown or expired approval id")),
      },
      {
        cfg: createTelegramApproveCfg(null),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          SenderId: "123",
          Surface: "telegram",
        },
        expectGatewayCalls: 0,
        expectedText: "Telegram exec approvals are not enabled",
        name: "telegram disabled native delivery reports the channel-disabled message",
      },
      {
        cfg: createTelegramApproveCfg({ approvers: ["999"], enabled: true, target: "dm" }),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          SenderId: "123",
          Surface: "telegram",
        },
        expectGatewayCalls: 0,
        expectedText: "not authorized to approve",
        name: "non approver",
      },
    ] as const) {
      callGatewayMock.mockReset();
      testCase.setup?.();
      const result = await handleApproveCommand(
        buildApproveParams(testCase.commandBody, testCase.cfg, testCase.ctx),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(callGatewayMock, testCase.name).toHaveBeenCalledTimes(testCase.expectGatewayCalls);
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    for (const testCase of [
      {
        expectedGatewayCalls: 0,
        expectedText: "requires operator.approvals",
        scopes: ["operator.write"],
      },
      {
        expectedGatewayCalls: 1,
        expectedText: "Approval allow-once submitted",
        scopes: ["operator.approvals"],
      },
      {
        expectedGatewayCalls: 1,
        expectedText: "Approval allow-once submitted",
        scopes: ["operator.admin"],
      },
    ] as const) {
      callGatewayMock.mockReset();
      callGatewayMock.mockResolvedValue({ ok: true });
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc allow-once", cfg, {
          GatewayClientScopes: [...testCase.scopes],
          Provider: "webchat",
          Surface: "webchat",
        }),
        true,
      );

      expect(result?.shouldContinue, String(testCase.scopes)).toBe(false);
      expect(result?.reply?.text, String(testCase.scopes)).toContain(testCase.expectedText);
      expect(callGatewayMock, String(testCase.scopes)).toHaveBeenCalledTimes(
        testCase.expectedGatewayCalls,
      );
      if (testCase.expectedGatewayCalls > 0) {
        expect(callGatewayMock, String(testCase.scopes)).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: "exec.approval.resolve",
            params: { decision: "allow-once", id: "abc" },
          }),
        );
      }
    }
  });
});
