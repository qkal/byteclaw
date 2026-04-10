import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import type { HandleCommandsParams } from "./commands-types.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const buildPluginSnapshotReportMock = vi.hoisted(() => vi.fn());
const buildPluginDiagnosticsReportMock = vi.hoisted(() => vi.fn());
const buildPluginInspectReportMock = vi.hoisted(() => vi.fn());
const buildAllPluginInspectReportsMock = vi.hoisted(() => vi.fn());
const formatPluginCompatibilityNoticeMock = vi.hoisted(() => vi.fn(() => "ok"));

vi.mock("../../cli/npm-resolution.js", () => ({
  buildNpmInstallRecordFields: vi.fn(),
}));

vi.mock("../../cli/plugins-command-helpers.js", () => ({
  buildPreferredClawHubSpec: vi.fn(() => null),
  createPluginInstallLogger: vi.fn(() => ({})),
  decidePreferredClawHubFallback: vi.fn(() => "fallback_to_npm"),
  resolveFileNpmSpecToLocalPath: vi.fn(() => null),
}));

vi.mock("../../cli/plugins-install-persist.js", () => ({
  persistPluginInstall: vi.fn(async () => undefined),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../../infra/archive.js", () => ({
  resolveArchiveKind: vi.fn(() => null),
}));

vi.mock("../../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: vi.fn(() => null),
}));

vi.mock("../../plugins/clawhub.js", () => ({
  installPluginFromClawHub: vi.fn(),
}));

vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: vi.fn(),
  installPluginFromPath: vi.fn(),
}));

vi.mock("../../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: vi.fn(),
}));

vi.mock("../../plugins/status.js", () => ({
  buildAllPluginInspectReports: buildAllPluginInspectReportsMock,
  buildPluginDiagnosticsReport: buildPluginDiagnosticsReportMock,
  buildPluginInspectReport: buildPluginInspectReportMock,
  buildPluginSnapshotReport: buildPluginSnapshotReportMock,
  formatPluginCompatibilityNotice: formatPluginCompatibilityNoticeMock,
}));

vi.mock("../../plugins/toggle-config.js", () => ({
  setPluginEnabledInConfig: vi.fn((config: OpenClawConfig, id: string, enabled: boolean) => ({
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: { enabled },
      },
    },
  })),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: vi.fn((value: string) => value),
  };
});

function buildCfg(): OpenClawConfig {
  return {
    commands: { plugins: true, text: true },
    plugins: { enabled: true },
  };
}

function buildPluginsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    command: {
      channel: "whatsapp",
      channelId: "whatsapp",
      commandBodyNormalized,
      from: "test-user",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
      senderId: "owner",
      senderIsOwner: true,
      surface: "whatsapp",
      to: "test-bot",
    },
    ctx: {
      AccountId: undefined,
      CommandSource: "text",
      GatewayClientScopes: ["operator.write", "operator.pairing"],
      Provider: "whatsapp",
      Surface: "whatsapp",
    },
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    workspaceDir: "/tmp/plugins-workspace",
  } as unknown as HandleCommandsParams;
}

describe("handlePluginsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      resolved: buildCfg(),
      valid: true,
    });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      config: buildCfg(),
      issues: [],
      ok: true,
    });
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        {
          bundleFormat: "claude",
          format: "openclaw",
          id: "superpowers",
          name: "superpowers",
          status: "disabled",
        },
      ],
      workspaceDir: "/tmp/plugins-workspace",
    });
    buildPluginDiagnosticsReportMock.mockReturnValue({
      plugins: [
        {
          bundleFormat: "claude",
          format: "openclaw",
          id: "superpowers",
          name: "superpowers",
          status: "disabled",
        },
      ],
      workspaceDir: "/tmp/plugins-workspace",
    });
    buildPluginInspectReportMock.mockReturnValue({
      bundleFormat: "claude",
      compatibility: [],
      plugin: {
        id: "superpowers",
      },
      shape: { commands: ["review"] },
    });
    buildAllPluginInspectReportsMock.mockReturnValue([
      {
        compatibility: [],
        plugin: { id: "superpowers" },
      },
    ]);
  });

  it("lists discovered plugins and inspects plugin details", async () => {
    const listResult = await handlePluginsCommand(
      buildPluginsParams("/plugins list", buildCfg()),
      true,
    );
    expect(listResult?.reply?.text).toContain("Plugins");
    expect(listResult?.reply?.text).toContain("superpowers");
    expect(listResult?.reply?.text).toContain("[disabled]");

    const showResult = await handlePluginsCommand(
      buildPluginsParams("/plugins inspect superpowers", buildCfg()),
      true,
    );
    expect(showResult?.reply?.text).toContain('"id": "superpowers"');
    expect(showResult?.reply?.text).toContain('"bundleFormat": "claude"');
    expect(showResult?.reply?.text).toContain('"shape"');
    expect(showResult?.reply?.text).toContain('"compatibilityWarnings": []');

    const inspectAllResult = await handlePluginsCommand(
      buildPluginsParams("/plugins inspect all", buildCfg()),
      true,
    );
    expect(inspectAllResult?.reply?.text).toContain("```json");
    expect(inspectAllResult?.reply?.text).toContain('"plugin"');
    expect(inspectAllResult?.reply?.text).toContain('"compatibilityWarnings"');
    expect(inspectAllResult?.reply?.text).toContain('"superpowers"');
  });

  it("rejects internal writes without operator.admin", async () => {
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg());
    params.command.channel = "webchat";
    params.command.channelId = "webchat";
    params.command.surface = "webchat";
    params.ctx.Provider = "webchat";
    params.ctx.Surface = "webchat";
    params.ctx.GatewayClientScopes = ["operator.write"];

    const result = await handlePluginsCommand(params, true);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("returns an explicit unauthorized reply for native /plugins list", async () => {
    const params = buildPluginsParams("/plugins list", buildCfg());
    params.command.senderIsOwner = false;
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";
    params.ctx.CommandSource = "native";
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";

    const result = await handlePluginsCommand(params, true);
    expect(result).toEqual({
      reply: { text: "You are not authorized to use this command." },
      shouldContinue: false,
    });
  });
});
