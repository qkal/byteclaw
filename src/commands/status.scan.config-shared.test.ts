import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadStatusScanCommandConfig,
  resolveStatusScanColdStart,
  shouldSkipStatusScanMissingConfigFastPath,
} from "./status.scan.config-shared.js";

const mocks = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveConfigPath: mocks.resolveConfigPath,
}));

describe("status.scan.config-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConfigPath.mockReturnValue(
      `/tmp/openclaw-status-scan-config-shared-missing-${process.pid}.json`,
    );
  });

  it("detects the test fast-path env toggle", () => {
    expect(shouldSkipStatusScanMissingConfigFastPath({ ...process.env, VITEST: "true" })).toBe(
      true,
    );
    expect(shouldSkipStatusScanMissingConfigFastPath({ ...process.env, NODE_ENV: "test" })).toBe(
      true,
    );
    expect(shouldSkipStatusScanMissingConfigFastPath({})).toBe(false);
  });

  it("treats missing config as cold-start when fast-path bypass is disabled", () => {
    expect(resolveStatusScanColdStart({ allowMissingConfigFastPath: false, env: {} })).toBe(true);
  });

  it("skips read/resolve on fast-json cold-start outside tests", async () => {
    const readBestEffortConfig = vi.fn(async () => ({ channels: { telegram: {} } }));
    const resolveConfig = vi.fn(async () => ({
      diagnostics: ["resolved"],
      resolvedConfig: { channels: { telegram: {} } },
    }));

    const result = await loadStatusScanCommandConfig({
      allowMissingConfigFastPath: true,
      commandName: "status --json",
      env: {},
      readBestEffortConfig,
      resolveConfig,
    });

    expect(readBestEffortConfig).not.toHaveBeenCalled();
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(result).toEqual({
      coldStart: true,
      resolvedConfig: {},
      secretDiagnostics: [],
      sourceConfig: {},
    });
  });

  it("still reads and resolves during tests even when the config path is missing", async () => {
    const sourceConfig = { channels: { telegram: {} } };
    const resolvedConfig = { channels: { telegram: {} } };
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      diagnostics: ["resolved"],
      resolvedConfig,
    }));

    const result = await loadStatusScanCommandConfig({
      allowMissingConfigFastPath: true,
      commandName: "status --json",
      env: { VITEST: "true" },
      readBestEffortConfig,
      resolveConfig,
    });

    expect(readBestEffortConfig).toHaveBeenCalled();
    expect(resolveConfig).toHaveBeenCalledWith(sourceConfig);
    expect(result).toEqual({
      coldStart: false,
      resolvedConfig,
      secretDiagnostics: ["resolved"],
      sourceConfig,
    });
  });
});
