import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatAllowFromLowercase } from "../../plugin-sdk/allow-from.js";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
} from "../../plugin-sdk/allowlist-config-edit.js";
import { createScopedChannelConfigAdapter } from "../../plugin-sdk/channel-config-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import type { HandleCommandsParams } from "./commands-types.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
  removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
}));

interface TelegramTestSectionConfig {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  defaultAccount?: string;
  configWrites?: boolean;
  accounts?: Record<string, TelegramTestSectionConfig>;
}

interface DmGroupAllowlistTestSectionConfig {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  dm?: {
    allowFrom?: string[];
  };
}

function normalizeTelegramAllowFromEntries(values: (string | number)[]): string[] {
  return formatAllowFromLowercase({ allowFrom: values, stripPrefixRe: /^(telegram|tg):/i });
}

function resolveTelegramTestAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramTestSectionConfig {
  const section = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    return section ?? {};
  }
  return {
    ...section,
    ...section?.accounts?.[accountId],
  };
}

const telegramAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      nativeCommands: true,
    },
    docsPath: "/channels/telegram",
    id: "telegram",
    label: "Telegram",
  }),
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "telegram",
    normalize: ({ values }) => normalizeTelegramAllowFromEntries(values),
    resolveAccount: ({ cfg, accountId }) => resolveTelegramTestAccount(cfg, accountId),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveDmPolicy: () => undefined,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveGroupPolicy: () => undefined,
  }),
  config: createScopedChannelConfigAdapter({
    clearBaseFields: [],
    defaultAccountId: (cfg) =>
      (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
      DEFAULT_ACCOUNT_ID,
    formatAllowFrom: normalizeTelegramAllowFromEntries,
    listAccountIds: (cfg) => {
      const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
      return channel?.accounts ? Object.keys(channel.accounts) : [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => resolveTelegramTestAccount(cfg, accountId),
    resolveAllowFrom: (account) => account.allowFrom,
    sectionKey: "telegram",
  }),
  pairing: {
    idLabel: "telegramUserId",
  },
};

const whatsappAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    capabilities: {
      chatTypes: ["direct", "group"],
      nativeCommands: true,
    },
    docsPath: "/channels/whatsapp",
    id: "whatsapp",
    label: "WhatsApp",
  }),
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "whatsapp",
    normalize: ({ values }) => values.map((value) => String(value).trim()).filter(Boolean),
    resolveAccount: ({ cfg }) =>
      (cfg.channels?.whatsapp as DmGroupAllowlistTestSectionConfig | undefined) ?? {},
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveDmPolicy: () => undefined,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveGroupPolicy: () => undefined,
  }),
  pairing: {
    idLabel: "phone",
  },
};

function createLegacyAllowlistPlugin(channelId: "discord" | "slack"): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      capabilities: {
        chatTypes: ["direct", "group", "thread"],
        nativeCommands: true,
      },
      docsPath: `/channels/${channelId}`,
      id: channelId,
      label: channelId === "discord" ? "Discord" : "Slack",
    }),
    allowlist: buildLegacyDmAccountAllowlistAdapter({
      channelId,
      normalize: ({ values }) => values.map((value) => String(value).trim()).filter(Boolean),
      resolveAccount: ({ cfg }) =>
        (cfg.channels?.[channelId] as DmGroupAllowlistTestSectionConfig | undefined) ?? {},
      resolveDmAllowFrom: (account) => account.allowFrom ?? account.dm?.allowFrom,
      resolveGroupOverrides: () => undefined,
      resolveGroupPolicy: () => undefined,
    }),
    pairing: {
      idLabel: channelId === "discord" ? "discordUserId" : "slackUserId",
    },
  };
}

function setAllowlistPluginRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { plugin: telegramAllowlistTestPlugin, pluginId: "telegram", source: "test" },
      { plugin: whatsappAllowlistTestPlugin, pluginId: "whatsapp", source: "test" },
      { plugin: createLegacyAllowlistPlugin("discord"), pluginId: "discord", source: "test" },
      { plugin: createLegacyAllowlistPlugin("slack"), pluginId: "slack", source: "test" },
    ]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAllowlistPluginRegistry();
  readConfigFileSnapshotMock.mockImplementation(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      return { parsed: null, valid: false };
    }
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    return { parsed, valid: true };
  });
  validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
    config,
    ok: true,
  }));
  writeConfigFileMock.mockImplementation(async (config: unknown) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (configPath) {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    }
  });
  readChannelAllowFromStoreMock.mockResolvedValue([]);
  addChannelAllowFromStoreEntryMock.mockResolvedValue({ allowFrom: [], changed: true });
  removeChannelAllowFromStoreEntryMock.mockResolvedValue({ allowFrom: [], changed: true });
});

async function withTempConfigPath<T>(
  initialConfig: Record<string, unknown>,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-allowlist-config-"));
  const configPath = path.join(dir, "openclaw.json");
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");
  try {
    return await run(configPath);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previous;
    }
    await fs.rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function buildAllowlistParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    AccountId?: string;
    SenderId?: string;
    From?: string;
    GatewayClientScopes?: string[];
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "telegram";
  return {
    cfg,
    command: {
      channel: provider,
      channelId: provider,
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderId: ctxOverrides?.SenderId ?? "owner",
      senderIsOwner: false,
    },
    ctx: {
      AccountId: ctxOverrides?.AccountId,
      CommandSource: "text",
      From: ctxOverrides?.From,
      GatewayClientScopes: ctxOverrides?.GatewayClientScopes,
      Provider: provider,
      SenderId: ctxOverrides?.SenderId,
      Surface: ctxOverrides?.Surface ?? provider,
    },
  } as unknown as HandleCommandsParams;
}

describe("handleAllowlistCommand", () => {
  it("lists config and store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const cfg = {
      channels: { telegram: { allowFrom: ["123", "@Alice"] } },
      commands: { text: true },
    } as OpenClawConfig;
    const result = await handleAllowlistCommand(
      buildAllowlistParams("/allowlist list dm", cfg),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result?.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("adds allowlist entries to config and pairing stores", async () => {
    const cases = [
      {
        name: "default account",
        run: async () => {
          await withTempConfigPath(
            {
              channels: { telegram: { allowFrom: ["123"] } },
            },
            async (configPath) => {
              readConfigFileSnapshotMock.mockResolvedValueOnce({
                parsed: {
                  channels: { telegram: { allowFrom: ["123"] } },
                },
                valid: true,
              });
              addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
                allowFrom: ["123", "789"],
                changed: true,
              });

              const params = buildAllowlistParams("/allowlist add dm 789", {
                channels: { telegram: { allowFrom: ["123"] } },
                commands: { config: true, text: true },
              } as OpenClawConfig);
              params.command.senderIsOwner = true;
              const result = await handleAllowlistCommand(params, true);

              expect(result?.shouldContinue, "default account").toBe(false);
              const written = await readJsonFile<OpenClawConfig>(configPath);
              expect(written.channels?.telegram?.allowFrom, "default account").toEqual([
                "123",
                "789",
              ]);
              expect(addChannelAllowFromStoreEntryMock, "default account").toHaveBeenCalledWith({
                accountId: "default",
                channel: "telegram",
                entry: "789",
              });
              expect(result?.reply?.text, "default account").toContain("DM allowlist added");
            },
          );
        },
      },
      {
        name: "selected account scope",
        run: async () => {
          readConfigFileSnapshotMock.mockResolvedValueOnce({
            parsed: {
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
            },
            valid: true,
          });
          addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
            allowFrom: ["123", "789"],
            changed: true,
          });

          const params = buildAllowlistParams(
            "/allowlist add dm --account work 789",
            {
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
              commands: { config: true, text: true },
            } as OpenClawConfig,
            { AccountId: "work" },
          );
          params.command.senderIsOwner = true;
          const result = await handleAllowlistCommand(params, true);

          expect(result?.shouldContinue, "selected account scope").toBe(false);
          expect(addChannelAllowFromStoreEntryMock, "selected account scope").toHaveBeenCalledWith({
            accountId: "work",
            channel: "telegram",
            entry: "789",
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("uses the configured default account for omitted-account list", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...telegramAllowlistTestPlugin,
            config: {
              ...telegramAllowlistTestPlugin.config,
              defaultAccountId: (cfg: OpenClawConfig) =>
                (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
                DEFAULT_ACCOUNT_ID,
            },
          },
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const cfg = {
      channels: {
        telegram: {
          accounts: { work: { allowFrom: ["123"] } },
          defaultAccount: "work",
        },
      },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    readChannelAllowFromStoreMock.mockResolvedValueOnce([]);

    const result = await handleAllowlistCommand(
      buildAllowlistParams("/allowlist list dm", cfg, {
        Provider: "telegram",
        Surface: "telegram",
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram (account work)");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123");
  });

  it("blocks config-targeted edits when the target account disables writes", async () => {
    const previousWriteCount = writeConfigFileMock.mock.calls.length;
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: { allowFrom: ["123"], configWrites: false },
          },
          configWrites: true,
        },
      },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      parsed: structuredClone(cfg),
      valid: true,
    });
    const params = buildAllowlistParams("/allowlist add dm --account work --config 789", cfg, {
      AccountId: "default",
      Provider: "telegram",
      Surface: "telegram",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(writeConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("honors the configured default account when gating omitted-account config edits", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...telegramAllowlistTestPlugin,
            config: {
              ...telegramAllowlistTestPlugin.config,
              defaultAccountId: (cfg: OpenClawConfig) =>
                (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
                DEFAULT_ACCOUNT_ID,
            },
          },
          pluginId: "telegram",
          source: "test",
        },
      ]),
    );

    const previousWriteCount = writeConfigFileMock.mock.calls.length;
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            work: { allowFrom: ["123"], configWrites: false },
          },
          configWrites: true,
          defaultAccount: "work",
        },
      },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      parsed: structuredClone(cfg),
      valid: true,
    });
    const params = buildAllowlistParams("/allowlist add dm --config 789", cfg, {
      Provider: "telegram",
      Surface: "telegram",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(writeConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("blocks allowlist writes from authorized non-owner senders", async () => {
    const cfg = {
      channels: {
        discord: { allowFrom: ["owner-discord-id"], configWrites: true },
        telegram: { allowFrom: ["*"], configWrites: true },
      },
      commands: {
        allowFrom: { telegram: ["*"] },
        config: true,
        ownerAllowFrom: ["discord:owner-discord-id"],
        text: true,
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams(
      "/allowlist add dm --channel discord attacker-discord-id",
      cfg,
      {
        From: "telegram-attacker",
        Provider: "telegram",
        SenderId: "telegram-attacker",
        Surface: "telegram",
      },
    );
    params.command.senderIsOwner = false;

    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks non-owner allowlist writes before resolving target channel", async () => {
    const cfg = {
      channels: {
        telegram: { allowFrom: ["*"], configWrites: true },
      },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --channel unknown attacker-id", cfg, {
      From: "telegram-attacker",
      Provider: "telegram",
      SenderId: "telegram-attacker",
      Surface: "telegram",
    });
    params.command.senderIsOwner = false;

    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("removes default-account entries from scoped and legacy pairing stores", async () => {
    removeChannelAllowFromStoreEntryMock
      .mockResolvedValueOnce({
        allowFrom: [],
        changed: true,
      })
      .mockResolvedValueOnce({
        allowFrom: [],
        changed: true,
      });

    const cfg = {
      channels: { telegram: { allowFrom: ["123"] } },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist remove dm --store 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(1, {
      accountId: "default",
      channel: "telegram",
      entry: "789",
    });
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(2, {
      channel: "telegram",
      entry: "789",
    });
  });

  it("rejects blocked account ids and keeps Object.prototype clean", async () => {
    delete (Object.prototype as Record<string, unknown>).allowFrom;

    const cfg = {
      channels: { telegram: { allowFrom: ["123"] } },
      commands: { config: true, text: true },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --account __proto__ 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Invalid account id");
    expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("removes DM allowlist entries from canonical allowFrom and deletes legacy dm.allowFrom", async () => {
    const cases = [
      {
        expectedAllowFrom: ["U222"],
        initialAllowFrom: ["U111", "U222"],
        provider: "slack",
        removeId: "U111",
      },
      {
        expectedAllowFrom: ["222"],
        initialAllowFrom: ["111", "222"],
        provider: "discord",
        removeId: "111",
      },
    ] as const;

    for (const testCase of cases) {
      const initialConfig = {
        channels: {
          [testCase.provider]: {
            allowFrom: testCase.initialAllowFrom,
            configWrites: true,
            dm: { allowFrom: testCase.initialAllowFrom },
          },
        },
      };
      await withTempConfigPath(initialConfig, async (configPath) => {
        readConfigFileSnapshotMock.mockResolvedValueOnce({
          parsed: structuredClone(initialConfig),
          valid: true,
        });

        const cfg = {
          channels: {
            [testCase.provider]: {
              allowFrom: testCase.initialAllowFrom,
              configWrites: true,
              dm: { allowFrom: testCase.initialAllowFrom },
            },
          },
          commands: { config: true, text: true },
        } as OpenClawConfig;

        const params = buildAllowlistParams(`/allowlist remove dm ${testCase.removeId}`, cfg, {
          Provider: testCase.provider,
          Surface: testCase.provider,
        });
        params.command.senderIsOwner = true;
        const result = await handleAllowlistCommand(params, true);

        expect(result?.shouldContinue).toBe(false);
        const written = await readJsonFile<OpenClawConfig>(configPath);
        const channelConfig = written.channels?.[testCase.provider];
        expect(channelConfig?.allowFrom).toEqual(testCase.expectedAllowFrom);
        expect(channelConfig?.dm?.allowFrom).toBeUndefined();
        expect(result?.reply?.text).toContain(`channels.${testCase.provider}.allowFrom`);
      });
    }
  });
});
