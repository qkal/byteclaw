import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPluginRootAt, repoInstallSpec } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  type PluginInstallRequestContext,
  resolvePluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { loadConfigForInstall } from "./plugins-install-command.js";

const hoisted = vi.hoisted(() => ({
  collectChannelDoctorStaleConfigMutationsMock: vi.fn(),
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshotMock: vi.fn<() => Promise<ConfigFileSnapshot>>(),
}));

const {loadConfigMock} = hoisted;
const {readConfigFileSnapshotMock} = hoisted;
const {collectChannelDoctorStaleConfigMutationsMock} = hoisted;

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorStaleConfigMutations: (cfg: OpenClawConfig) =>
    collectChannelDoctorStaleConfigMutationsMock(cfg),
}));

const MATRIX_REPO_INSTALL_SPEC = repoInstallSpec("matrix");

function makeSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    config: { plugins: {} } as OpenClawConfig,
    exists: true,
    hash: "abc",
    issues: [{ message: "stale path", path: "plugins.installs.matrix" }],
    legacyIssues: [],
    parsed: { plugins: {} },
    path: "/tmp/config.json5",
    raw: '{ "plugins": {} }',
    resolved: { plugins: {} } as OpenClawConfig,
    runtimeConfig: { plugins: {} } as ConfigFileSnapshot["runtimeConfig"],
    sourceConfig: { plugins: {} } as ConfigFileSnapshot["sourceConfig"],
    valid: false,
    warnings: [],
    ...overrides,
  };
}

describe("loadConfigForInstall", () => {
  const matrixNpmRequest = {
    allowInvalidConfigRecovery: true,
    bundledPluginId: "matrix",
    normalizedSpec: "@openclaw/matrix",
    rawSpec: "@openclaw/matrix",
  } satisfies PluginInstallRequestContext;

  beforeEach(() => {
    loadConfigMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    collectChannelDoctorStaleConfigMutationsMock.mockReset();

    collectChannelDoctorStaleConfigMutationsMock.mockImplementation(async (cfg: OpenClawConfig) => [
      {
        changes: [],
        config: cfg,
      },
    ]);
  });

  it("returns the config directly when loadConfig succeeds", async () => {
    const cfg = { plugins: { entries: { matrix: { enabled: true } } } } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(result).toBe(cfg);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not run stale Matrix cleanup on the happy path", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result).toBe(cfg);
  });

  it("falls back to snapshot config for explicit bundled-plugin reinstall when issues match the known upgrade failure", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    const snapshotCfg = {
      plugins: { installs: { matrix: { installPath: "/gone", source: "path" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: snapshotCfg,
        issues: [
          { message: "unknown channel id: matrix", path: "channels.matrix" },
          { message: "plugin: plugin path not found: /gone", path: "plugins.load.paths" },
        ],
        parsed: { plugins: { installs: { matrix: {} } } },
      }),
    );

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(readConfigFileSnapshotMock).toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toBe(snapshotCfg);
  });

  it("allows explicit repo-checkout bundled-plugin reinstall recovery", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: snapshotCfg,
        issues: [{ message: "unknown channel id: matrix", path: "channels.matrix" }],
      }),
    );

    const repoRequest = resolvePluginInstallRequestContext({
      rawSpec: MATRIX_REPO_INSTALL_SPEC,
    });
    if (!repoRequest.ok) {
      throw new Error(repoRequest.error);
    }

    const result = await loadConfigForInstall({
      ...repoRequest.request,
      resolvedPath: bundledPluginRootAt("/tmp/repo", "matrix"),
    });
    expect(result).toBe(snapshotCfg);
  });

  it("rejects unrelated invalid config even during bundled-plugin reinstall recovery", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ message: "invalid model ref", path: "models.default" }],
      }),
    );

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config invalid outside the bundled recovery path for matrix",
    );
  });

  it("rejects non-Matrix install requests when config is invalid", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    await expect(
      loadConfigForInstall({
        normalizedSpec: "alpha",
        rawSpec: "alpha",
      }),
    ).rejects.toThrow("Config invalid; run `openclaw doctor --fix` before installing plugins.");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("throws when loadConfig fails with INVALID_CONFIG and snapshot parsed is empty", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: {} as OpenClawConfig,
        parsed: {},
      }),
    );

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("throws when loadConfig fails with INVALID_CONFIG and config file does not exist", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    loadConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });

    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot({ exists: false, parsed: {} }));

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("re-throws non-config errors from loadConfig", async () => {
    const fsErr = new Error("EACCES: permission denied");
    (fsErr as { code?: string }).code = "EACCES";
    loadConfigMock.mockImplementation(() => {
      throw fsErr;
    });

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "EACCES: permission denied",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });
});
