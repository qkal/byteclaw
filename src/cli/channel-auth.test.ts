import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  createClackPrompter: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  getChannelPlugin: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  listChannelPlugins: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  loadConfig: vi.fn(),
  login: vi.fn(),
  logoutAccount: vi.fn(),
  normalizeChannelId: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveAccount: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  setVerbose: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
}));

describe("channel-auth", () => {
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const plugin = {
    auth: { login: mocks.login },
    config: {
      listAccountIds: vi.fn().mockReturnValue(["default"]),
      resolveAccount: mocks.resolveAccount,
    },
    gateway: { logoutAccount: mocks.logoutAccount },
    id: "whatsapp",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockReturnValue("whatsapp");
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {} } });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ changes: [], config }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default-account");
    mocks.createClackPrompter.mockReturnValue({} as object);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: { channels: { whatsapp: {} } },
      installed: true,
      pluginId: "whatsapp",
    });
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channelSetups: [],
      channels: [{ plugin }],
    });
    mocks.resolveAccount.mockReturnValue({ id: "resolved-account" });
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAccount.mockResolvedValue(undefined);
  });

  it("runs login with explicit trimmed account and verbose flag", async () => {
    await runChannelLogin({ account: "  acct-1  ", channel: "wa", verbose: true }, runtime);

    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expect(mocks.resolveChannelDefaultAccountId).not.toHaveBeenCalled();
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        cfg: { channels: { whatsapp: {} } },
        channelInput: "wa",
        runtime,
        verbose: true,
      }),
    );
  });

  it("auto-picks the single configured channel that supports login when opts are empty", async () => {
    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInput: "whatsapp",
      }),
    );
  });

  it("does not auto-pick enabled-only channel stubs when channel is omitted", async () => {
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: { enabled: false } } });

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "Channel is required (no configured channels support login).",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("auto-picks the single auth-capable channel from the auto-enabled config snapshot", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ changes: ["whatsapp"], config: autoEnabledCfg });

    await runChannelLogin({}, runtime);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledCfg,
        channelInput: "whatsapp",
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      baseHash: "config-1",
      nextConfig: autoEnabledCfg,
    });
  });

  it("persists auto-enabled config during logout auto-pick too", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ changes: ["whatsapp"], config: autoEnabledCfg });

    await runChannelLogout({}, runtime);

    expect(mocks.logoutAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledCfg,
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      baseHash: "config-1",
      nextConfig: autoEnabledCfg,
    });
  });

  it("ignores configured channels that do not support login when channel is omitted", async () => {
    const telegramPlugin = {
      auth: {},
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
      gateway: {},
      id: "telegram",
    };
    mocks.loadConfig.mockReturnValue({ channels: { telegram: {}, whatsapp: {} } });
    mocks.listChannelPlugins.mockReturnValue([telegramPlugin, plugin]);

    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalled();
  });

  it("propagates auth-channel ambiguity when multiple configured channels support login", async () => {
    const zaloPlugin = {
      auth: { login: vi.fn() },
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
      gateway: {},
      id: "zalouser",
    };
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {}, zalouser: {} } });
    mocks.listChannelPlugins.mockReturnValue([plugin, zaloPlugin]);
    mocks.normalizeChannelId.mockImplementation((value) => value);
    mocks.getChannelPlugin.mockImplementation((value) =>
      value === "whatsapp"
        ? plugin
        : (value === "zalouser"
          ? (zaloPlugin as typeof plugin)
          : undefined),
    );

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "multiple configured channels support login: whatsapp, zalouser",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("ignores plugins with prototype-chain IDs like __proto__", async () => {
    const protoPlugin = {
      auth: { login: vi.fn() },
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
      gateway: {},
      id: "__proto__",
    };
    mocks.listChannelPlugins.mockReturnValue([protoPlugin, plugin]);

    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalled();
  });

  it("throws for unsupported channel aliases", async () => {
    mocks.normalizeChannelId.mockImplementation(() => undefined);

    await expect(runChannelLogin({ channel: "bad-channel" }, runtime)).rejects.toThrow(
      "Unsupported channel: bad-channel",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("throws when channel does not support login", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: {},
      config: { resolveAccount: mocks.resolveAccount },
      gateway: { logoutAccount: mocks.logoutAccount },
    });

    await expect(runChannelLogin({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support login",
    );
  });

  it("installs a catalog-backed channel plugin on demand for login", async () => {
    const catalogEntry = {
      id: "whatsapp",
      install: {
        npmSpec: "@openclaw/whatsapp",
      },
      meta: {
        blurb: "wa",
        docsPath: "/channels/whatsapp",
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
      },
      pluginId: "@openclaw/whatsapp",
    };
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValueOnce([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel
      .mockReturnValueOnce({
        channelSetups: [],
        channels: [],
      })
      .mockReturnValueOnce({
        channelSetups: [],
        channels: [{ plugin }],
      });

    await runChannelLogin({ channel: "whatsapp" }, runtime);

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: catalogEntry,
        runtime,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        pluginId: "whatsapp",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      baseHash: "config-1",
      nextConfig: { channels: { whatsapp: {} } },
    });
    expect(mocks.login).toHaveBeenCalled();
  });

  it("resolves explicit channel login through the catalog when registry normalize misses", async () => {
    mocks.normalizeChannelId.mockReturnValueOnce(undefined).mockReturnValue("whatsapp");
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValueOnce([
      {
        id: "whatsapp",
        install: {
          npmSpec: "@openclaw/whatsapp",
        },
        meta: {
          blurb: "wa",
          docsPath: "/channels/whatsapp",
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
        },
        pluginId: "@openclaw/whatsapp",
      },
    ]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel
      .mockReturnValueOnce({
        channelSetups: [],
        channels: [],
      })
      .mockReturnValueOnce({
        channelSetups: [],
        channels: [{ plugin }],
      });

    await runChannelLogin({ channel: "whatsapp" }, runtime);

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "whatsapp" }),
        runtime,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInput: "whatsapp",
      }),
    );
  });

  it("runs logout with resolved account and explicit account id", async () => {
    await runChannelLogout({ account: " acct-2 ", channel: "whatsapp" }, runtime);

    expect(mocks.resolveAccount).toHaveBeenCalledWith({ channels: { whatsapp: {} } }, "acct-2");
    expect(mocks.logoutAccount).toHaveBeenCalledWith({
      account: { id: "resolved-account" },
      accountId: "acct-2",
      cfg: { channels: { whatsapp: {} } },
      runtime,
    });
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it("throws when channel does not support logout", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: { login: mocks.login },
      config: { resolveAccount: mocks.resolveAccount },
      gateway: {},
    });

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support logout",
    );
  });
});
