import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import type { UpdateCheckResult } from "./update-check.js";

vi.mock("./openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("./openclaw-root.js")>("./openclaw-root.js");
  return {
    ...actual,
    resolveOpenClawPackageRoot: vi.fn(),
  };
});

vi.mock("./update-check.js", async () => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const compareSemverStrings = (a: string, b: string) => {
    const left = parse(a);
    const right = parse(b);
    for (let idx = 0; idx < 3; idx += 1) {
      const l = left[idx] ?? 0;
      const r = right[idx] ?? 0;
      if (l !== r) {
        return l < r ? -1 : 1;
      }
    }
    return 0;
  };

  return {
    checkUpdateStatus: vi.fn(),
    compareSemverStrings,
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  VERSION: "1.0.0",
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

describe("update-startup", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-update-check-suite-" });
  let tempDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  let resolveOpenClawPackageRoot: (typeof import("./openclaw-root.js"))["resolveOpenClawPackageRoot"];
  let checkUpdateStatus: (typeof import("./update-check.js"))["checkUpdateStatus"];
  let resolveNpmChannelTag: (typeof import("./update-check.js"))["resolveNpmChannelTag"];
  let runCommandWithTimeout: (typeof import("../process/exec.js"))["runCommandWithTimeout"];
  let runGatewayUpdateCheck: (typeof import("./update-startup.js"))["runGatewayUpdateCheck"];
  let scheduleGatewayUpdateCheck: (typeof import("./update-startup.js"))["scheduleGatewayUpdateCheck"];
  let getUpdateAvailable: (typeof import("./update-startup.js"))["getUpdateAvailable"];
  let resetUpdateAvailableStateForTest: (typeof import("./update-startup.js"))["resetUpdateAvailableStateForTest"];
  let loaded = false;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    tempDir = await suiteRootTracker.make("case");
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "NODE_ENV", "VITEST"]);
    process.env.OPENCLAW_STATE_DIR = tempDir;

    process.env.NODE_ENV = "test";

    // Ensure update checks don't short-circuit in test mode.
    delete process.env.VITEST;

    // Perf: load mocked modules once (after timers/env are set up).
    if (!loaded) {
      ({ resolveOpenClawPackageRoot } = await import("./openclaw-root.js"));
      ({ checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js"));
      ({ runCommandWithTimeout } = await import("../process/exec.js"));
      ({
        runGatewayUpdateCheck,
        scheduleGatewayUpdateCheck,
        getUpdateAvailable,
        resetUpdateAvailableStateForTest,
      } = await import("./update-startup.js"));
      loaded = true;
    }
    vi.mocked(resolveOpenClawPackageRoot).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockClear();
    resetUpdateAvailableStateForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    envSnapshot.restore();
    resetUpdateAvailableStateForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  function mockPackageUpdateStatus(tag = "latest", version = "2.0.0") {
    mockPackageInstallStatus();
    mockNpmChannelTag(tag, version);
  }

  function mockPackageInstallStatus() {
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      installKind: "package",
      packageManager: "npm",
      root: "/opt/openclaw",
    } satisfies UpdateCheckResult);
  }

  function mockNpmChannelTag(tag: string, version: string) {
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag,
      version,
    });
  }

  async function runUpdateCheckAndReadState(channel: "stable" | "beta") {
    mockPackageUpdateStatus("latest", "2.0.0");

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: { update: { channel } },
      isNixMode: false,
      log,
    });

    const statePath = path.join(tempDir, "update-check.json");
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      lastNotifiedVersion?: string;
      lastNotifiedTag?: string;
      lastAvailableVersion?: string;
      lastAvailableTag?: string;
    };
    return { log, parsed };
  }

  function createAutoUpdateSuccessMock() {
    return vi.fn().mockResolvedValue({
      code: 0,
      ok: true,
    });
  }

  function createBetaAutoUpdateConfig(params?: { checkOnStart?: boolean }) {
    return {
      update: {
        ...(params?.checkOnStart === false ? { checkOnStart: false } : {}),
        auto: {
          betaCheckIntervalHours: 1,
          enabled: true,
        },
        channel: "beta" as const,
      },
    };
  }

  async function runAutoUpdateCheckWithDefaults(params: {
    cfg: { update?: Record<string, unknown> };
    runAutoUpdate?: ReturnType<typeof createAutoUpdateSuccessMock>;
  }) {
    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: params.cfg,
      isNixMode: false,
      log: { info: vi.fn() },
      ...(params.runAutoUpdate ? { runAutoUpdate: params.runAutoUpdate } : {}),
    });
  }

  async function runStableUpdateCheck(params: {
    onUpdateAvailableChange?: Parameters<
      typeof runGatewayUpdateCheck
    >[0]["onUpdateAvailableChange"];
  }) {
    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: { update: { channel: "stable" } },
      isNixMode: false,
      log: { info: vi.fn() },
      ...(params.onUpdateAvailableChange
        ? { onUpdateAvailableChange: params.onUpdateAvailableChange }
        : {}),
    });
  }

  it.each([
    {
      channel: "stable" as const,
      name: "stable channel",
    },
    {
      channel: "beta" as const,
      name: "beta channel with older beta tag",
    },
  ])("logs latest update hint for $name", async ({ channel }) => {
    const { log, parsed } = await runUpdateCheckAndReadState(channel);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );
    expect(parsed.lastNotifiedVersion).toBe("2.0.0");
    expect(parsed.lastAvailableVersion).toBe("2.0.0");
    expect(parsed.lastNotifiedTag).toBe("latest");
  });

  it("hydrates cached update from persisted state during throttle window", async () => {
    const statePath = path.join(tempDir, "update-check.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          lastAvailableTag: "latest",
          lastAvailableVersion: "2.0.0",
          lastCheckedAt: new Date(Date.now()).toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: { update: { channel: "stable" } },
      isNixMode: false,
      log: { info: vi.fn() },
      onUpdateAvailableChange,
    });

    expect(vi.mocked(checkUpdateStatus)).not.toHaveBeenCalled();
    expect(onUpdateAvailableChange).toHaveBeenCalledWith({
      channel: "latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
    });
    expect(getUpdateAvailable()).toEqual({
      channel: "latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
    });
  });

  it("emits update change callback when update state clears", async () => {
    mockPackageInstallStatus();
    vi.mocked(resolveNpmChannelTag)
      .mockResolvedValueOnce({
        tag: "latest",
        version: "2.0.0",
      })
      .mockResolvedValueOnce({
        tag: "latest",
        version: "1.0.0",
      });

    const onUpdateAvailableChange = vi.fn();
    await runStableUpdateCheck({ onUpdateAvailableChange });
    vi.setSystemTime(new Date("2026-01-18T11:00:00Z"));
    await runStableUpdateCheck({ onUpdateAvailableChange });

    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(1, {
      channel: "latest",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
    });
    expect(onUpdateAvailableChange).toHaveBeenNthCalledWith(2, null);
    expect(getUpdateAvailable()).toBeNull();
  });

  it("skips update check when disabled in config", async () => {
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: { update: { checkOnStart: false } },
      isNixMode: false,
      log,
    });

    expect(log.info).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tempDir, "update-check.json"))).rejects.toThrow();
  });

  it("defers stable auto-update until rollout window is due", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const runAutoUpdate = vi.fn().mockResolvedValue({
      code: 0,
      ok: true,
    });
    const stableAutoConfig = {
      update: {
        auto: {
          enabled: true,
          stableDelayHours: 6,
          stableJitterHours: 12,
        },
        channel: "stable" as const,
      },
    };

    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: stableAutoConfig,
      isNixMode: false,
      log: { info: vi.fn() },
      runAutoUpdate,
    });
    expect(runAutoUpdate).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-18T07:00:00Z"));
    await runGatewayUpdateCheck({
      allowInTests: true,
      cfg: stableAutoConfig,
      isNixMode: false,
      log: { info: vi.fn() },
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "stable",
      root: "/opt/openclaw",
      timeoutMs: 45 * 60 * 1000,
    });
  });

  it("runs beta auto-update checks hourly when enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig(),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
    expect(runAutoUpdate).toHaveBeenCalledWith({
      channel: "beta",
      root: "/opt/openclaw",
      timeoutMs: 45 * 60 * 1000,
    });
  });

  it("runs auto-update when checkOnStart is false but auto-update is enabled", async () => {
    mockPackageUpdateStatus("beta", "2.0.0-beta.1");
    const runAutoUpdate = createAutoUpdateSuccessMock();

    await runAutoUpdateCheckWithDefaults({
      cfg: createBetaAutoUpdateConfig({ checkOnStart: false }),
      runAutoUpdate,
    });

    expect(runAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses current runtime + entrypoint for default auto-update command execution", async () => {
    mockPackageInstallStatus();
    mockNpmChannelTag("beta", "2.0.0-beta.1");
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "{}",
      termination: "exit",
    });

    const originalArgv = [...process.argv];
    process.argv = [process.execPath, "/opt/openclaw/dist/entry.js"];
    try {
      await runAutoUpdateCheckWithDefaults({
        cfg: createBetaAutoUpdateConfig(),
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        "/opt/openclaw/dist/entry.js",
        "update",
        "--yes",
        "--channel",
        "beta",
        "--json",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_AUTO_UPDATE: "1",
        }),
        timeoutMs: 45 * 60 * 1000,
      }),
    );
  });

  it("scheduleGatewayUpdateCheck returns a cleanup function", async () => {
    mockPackageUpdateStatus("latest", "2.0.0");

    const stop = scheduleGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      isNixMode: false,
      log: { info: vi.fn() },
    });
    expect(typeof stop).toBe("function");
    stop();
  });
});
