import { afterEach, describe, expect, it, vi } from "vitest";
import { installedPluginRoot } from "../../../test/helpers/bundled-plugin-paths.js";
import { createPluginRecord, createPluginStatusReport } from "../../plugins/status.test-helpers.js";

const WORKSPACE_PLUGIN_ROOT = installedPluginRoot("/tmp/workspace/.openclaw", "superpowers");

const {
  readConfigFileSnapshotMock,
  validateConfigObjectWithPluginsMock,
  writeConfigFileMock,
  buildPluginSnapshotReportMock,
  buildPluginDiagnosticsReportMock,
} = vi.hoisted(() => ({
  buildPluginDiagnosticsReportMock: vi.fn(),
  buildPluginSnapshotReportMock: vi.fn(),
  readConfigFileSnapshotMock: vi.fn(),
  validateConfigObjectWithPluginsMock: vi.fn(),
  writeConfigFileMock: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../plugins/status.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../plugins/status.js")>("../../plugins/status.js");
  return {
    ...actual,
    buildPluginDiagnosticsReport: buildPluginDiagnosticsReportMock,
    buildPluginSnapshotReport: buildPluginSnapshotReportMock,
  };
});

import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function buildCfg() {
  return {
    commands: {
      plugins: true,
      text: true,
    },
    plugins: {
      enabled: true,
    },
  };
}

describe("handleCommands /plugins toggle", () => {
  afterEach(() => {
    readConfigFileSnapshotMock.mockReset();
    validateConfigObjectWithPluginsMock.mockReset();
    writeConfigFileMock.mockReset();
    buildPluginSnapshotReportMock.mockReset();
    buildPluginDiagnosticsReportMock.mockReset();
  });

  it("enables a discovered plugin", async () => {
    const config = buildCfg();
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      resolved: config,
      valid: true,
    });
    buildPluginDiagnosticsReportMock.mockReturnValue(
      createPluginStatusReport({
        plugins: [
          createPluginRecord({
            enabled: false,
            format: "bundle",
            id: "superpowers",
            source: WORKSPACE_PLUGIN_ROOT,
            status: "disabled",
          }),
        ],
        workspaceDir: "/tmp/workspace",
      }),
    );
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ config: next, ok: true }));
    writeConfigFileMock.mockResolvedValue(undefined);

    const params = buildCommandTestParams("/plugins enable superpowers", buildCfg());
    params.command.senderIsOwner = true;

    const result = await handleCommands(params);
    expect(result.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            superpowers: expect.objectContaining({ enabled: true }),
          }),
        }),
      }),
    );
  });

  it("disables a discovered plugin", async () => {
    const config = buildCfg();
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      resolved: config,
      valid: true,
    });
    buildPluginDiagnosticsReportMock.mockReturnValue(
      createPluginStatusReport({
        plugins: [
          createPluginRecord({
            enabled: true,
            format: "bundle",
            id: "superpowers",
            source: WORKSPACE_PLUGIN_ROOT,
          }),
        ],
        workspaceDir: "/tmp/workspace",
      }),
    );
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ config: next, ok: true }));
    writeConfigFileMock.mockResolvedValue(undefined);

    const params = buildCommandTestParams("/plugins disable superpowers", buildCfg());
    params.command.senderIsOwner = true;

    const result = await handleCommands(params);
    expect(result.reply?.text).toContain('Plugin "superpowers" disabled');
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            superpowers: expect.objectContaining({ enabled: false }),
          }),
        }),
      }),
    );
  });

  it("resolves write targets by runtime-derived plugin name", async () => {
    const config = buildCfg();
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      resolved: config,
      valid: true,
    });
    buildPluginSnapshotReportMock.mockReturnValue(
      createPluginStatusReport({
        plugins: [
          createPluginRecord({
            enabled: false,
            format: "bundle",
            id: "superpowers",
            name: "superpowers",
            source: WORKSPACE_PLUGIN_ROOT,
            status: "disabled",
          }),
        ],
        workspaceDir: "/tmp/workspace",
      }),
    );
    buildPluginDiagnosticsReportMock.mockReturnValue(
      createPluginStatusReport({
        plugins: [
          createPluginRecord({
            enabled: false,
            format: "bundle",
            id: "superpowers",
            name: "Super Powers",
            source: WORKSPACE_PLUGIN_ROOT,
            status: "disabled",
          }),
        ],
        workspaceDir: "/tmp/workspace",
      }),
    );
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ config: next, ok: true }));
    writeConfigFileMock.mockResolvedValue(undefined);

    const params = buildCommandTestParams("/plugins enable Super Powers", buildCfg());
    params.command.senderIsOwner = true;

    const result = await handleCommands(params);
    expect(result.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalled();
    expect(buildPluginSnapshotReportMock).not.toHaveBeenCalled();
  });
});
