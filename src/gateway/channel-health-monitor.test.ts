import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "./server-channels.js";

function createMockChannelManager(overrides?: Partial<ChannelManager>): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => ({ channelAccounts: {}, channels: {} })),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    markChannelLoggedOut: vi.fn(),
    resetRestartAttempts: vi.fn(),
    startChannel: vi.fn(async () => {}),
    startChannels: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    ...overrides,
  };
}

function snapshotWith(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
  for (const [channelId, accts] of Object.entries(accounts)) {
    const resolved: Record<string, ChannelAccountSnapshot> = {};
    for (const [accountId, partial] of Object.entries(accts)) {
      resolved[accountId] = { accountId, ...partial };
    }
    channelAccounts[channelId as ChannelId] = resolved;
    const firstId = Object.keys(accts)[0];
    if (firstId) {
      channels[channelId as ChannelId] = resolved[firstId];
    }
  }
  return { channelAccounts, channels };
}

const DEFAULT_CHECK_INTERVAL_MS = 5000;

function createSnapshotManager(
  accounts: Record<string, Record<string, Partial<ChannelAccountSnapshot>>>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createMockChannelManager({
    getRuntimeSnapshot: vi.fn(() => snapshotWith(accounts)),
    ...overrides,
  });
}

function startDefaultMonitor(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  return startChannelHealthMonitor({
    channelManager: manager,
    checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs: 0,
    ...overrides,
  });
}

async function startAndRunCheck(
  manager: ChannelManager,
  overrides: Partial<Omit<Parameters<typeof startChannelHealthMonitor>[0], "channelManager">> = {},
) {
  const monitor = startDefaultMonitor(manager, overrides);
  const startupGraceMs = overrides.timing?.monitorStartupGraceMs ?? overrides.startupGraceMs ?? 0;
  const checkIntervalMs = overrides.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  await vi.advanceTimersByTimeAsync(startupGraceMs + checkIntervalMs + 1);
  return monitor;
}

function managedStoppedAccount(lastError: string): Partial<ChannelAccountSnapshot> {
  return {
    configured: true,
    enabled: true,
    lastError,
    running: false,
  };
}

function runningConnectedSlackAccount(
  overrides: Partial<ChannelAccountSnapshot>,
): Partial<ChannelAccountSnapshot> {
  return {
    configured: true,
    connected: true,
    enabled: true,
    running: true,
    ...overrides,
  };
}

function createSlackSnapshotManager(
  account: Partial<ChannelAccountSnapshot>,
  overrides?: Partial<ChannelManager>,
): ChannelManager {
  return createSnapshotManager(
    {
      slack: {
        default: account,
      },
    },
    overrides,
  );
}

function createBusyDisconnectedManager(lastRunActivityAt: number): ChannelManager {
  const now = Date.now();
  return createSnapshotManager({
    discord: {
      default: {
        activeRuns: 1,
        busy: true,
        configured: true,
        connected: false,
        enabled: true,
        lastRunActivityAt,
        lastStartAt: now - 300_000,
        running: true,
      },
    },
  });
}

async function expectRestartedChannel(
  manager: ChannelManager,
  channel: ChannelId,
  accountId = "default",
) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).toHaveBeenCalledWith(channel, accountId);
  expect(manager.startChannel).toHaveBeenCalledWith(channel, accountId);
  monitor.stop();
}

async function expectNoRestart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.stopChannel).not.toHaveBeenCalled();
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

async function expectNoStart(manager: ChannelManager) {
  const monitor = await startAndRunCheck(manager);
  expect(manager.startChannel).not.toHaveBeenCalled();
  monitor.stop();
}

describe("channel-health-monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not run before the grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { startupGraceMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("runs health check after grace period", async () => {
    const manager = createMockChannelManager();
    const monitor = await startAndRunCheck(manager, { startupGraceMs: 1000 });
    expect(manager.getRuntimeSnapshot).toHaveBeenCalled();
    monitor.stop();
  });

  it("accepts timing.monitorStartupGraceMs", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager, { timing: { monitorStartupGraceMs: 60_000 } });
    await vi.advanceTimersByTimeAsync(5001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips healthy channels (running + connected)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { configured: true, connected: true, enabled: true, running: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("skips disabled channels", async () => {
    const manager = createSnapshotManager({
      imessage: {
        default: {
          configured: true,
          enabled: false,
          lastError: "disabled",
          running: false,
        },
      },
    });
    await expectNoStart(manager);
  });

  it("skips unconfigured channels", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: { configured: false, enabled: true, running: false },
      },
    });
    await expectNoStart(manager);
  });

  it("skips manually stopped channels", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { configured: true, enabled: true, running: false },
        },
      },
      { isManuallyStopped: vi.fn(() => true) },
    );
    await expectNoStart(manager);
  });

  it("skips channels with health monitor disabled globally for that account", async () => {
    const manager = createSnapshotManager(
      {
        discord: {
          default: { configured: true, enabled: true, running: false },
        },
      },
      { isHealthMonitorEnabled: vi.fn(() => false) },
    );
    await expectNoStart(manager);
  });

  it("still restarts enabled accounts when another account on the same channel is disabled", async () => {
    const now = Date.now();
    const manager = createSnapshotManager(
      {
        discord: {
          default: {
            configured: true,
            connected: false,
            enabled: true,
            lastStartAt: now - 300_000,
            running: true,
          },
          quiet: {
            configured: true,
            connected: false,
            enabled: true,
            lastStartAt: now - 300_000,
            running: true,
          },
        },
      },
      {
        isHealthMonitorEnabled: vi.fn(
          (channelId: ChannelId, accountId: string) =>
            !(channelId === "discord" && accountId === "quiet"),
        ),
      },
    );
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    expect(manager.stopChannel).not.toHaveBeenCalledWith("discord", "quiet");
    expect(manager.startChannel).not.toHaveBeenCalledWith("discord", "quiet");
    monitor.stop();
  });

  it("restarts a stuck channel (running but not connected)", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      whatsapp: {
        default: {
          configured: true,
          connected: false,
          enabled: true,
          lastStartAt: now - 300_000,
          linked: true,
          running: true,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("whatsapp", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("whatsapp", "default");
    monitor.stop();
  });

  it("skips restart when channel is busy with active runs", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          activeRuns: 2,
          busy: true,
          configured: true,
          connected: false,
          enabled: true,
          lastRunActivityAt: now - 30_000,
          lastStartAt: now - 300_000,
          running: true,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("restarts busy channels when run activity is stale", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 26 * 60_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("restarts disconnected channels when busy flags are inherited from a prior lifecycle", async () => {
    const now = Date.now();
    const manager = createBusyDisconnectedManager(now - 301_000);
    await expectRestartedChannel(manager, "discord");
  });

  it("skips recently-started channels while they are still connecting", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          configured: true,
          connected: false,
          enabled: true,
          lastStartAt: now - 5000,
          running: true,
        },
      },
    });
    await expectNoRestart(manager);
  });

  it("respects custom per-channel startup grace", async () => {
    const now = Date.now();
    const manager = createSnapshotManager({
      discord: {
        default: {
          configured: true,
          connected: false,
          enabled: true,
          lastStartAt: now - 30_000,
          running: true,
        },
      },
    });
    const monitor = await startAndRunCheck(manager, { channelStartupGraceMs: 60_000 });
    expect(manager.stopChannel).not.toHaveBeenCalled();
    expect(manager.startChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("restarts a stopped channel that gave up (reconnectAttempts >= 10)", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: {
          ...managedStoppedAccount("Failed to resolve Discord application id"),
          reconnectAttempts: 10,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("discord", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it("restarts a channel that stopped unexpectedly (not running, not manual)", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: managedStoppedAccount("polling stopped unexpectedly"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.resetRestartAttempts).toHaveBeenCalledWith("telegram", "default");
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("treats missing enabled/configured flags as managed accounts", async () => {
    const manager = createSnapshotManager({
      telegram: {
        default: {
          lastError: "polling stopped unexpectedly",
          running: false,
        },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledWith("telegram", "default");
    monitor.stop();
  });

  it("applies cooldown — skips recently restarted channels for 2 cycles", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("crashed"),
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("caps at 3 health-monitor restarts per channel per hour", async () => {
    const manager = createSnapshotManager({
      discord: {
        default: managedStoppedAccount("keeps crashing"),
      },
    });
    const monitor = startDefaultMonitor(manager, {
      checkIntervalMs: 1000,
      cooldownCycles: 1,
      maxRestartsPerHour: 3,
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1001);
    expect(manager.startChannel).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("runs checks single-flight when restart work is still in progress", async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => resolve();
    });
    const manager = createSnapshotManager(
      {
        telegram: {
          default: managedStoppedAccount("stopped"),
        },
      },
      {
        startChannel: vi.fn(async () => {
          await startGate;
        }),
      },
    );
    const monitor = startDefaultMonitor(manager, { checkIntervalMs: 100, cooldownCycles: 0 });
    await vi.advanceTimersByTimeAsync(120);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);
    releaseStart?.();
    await Promise.resolve();
    monitor.stop();
  });

  it("stops cleanly", async () => {
    const manager = createMockChannelManager();
    const monitor = startDefaultMonitor(manager);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(5001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
  });

  it("stops via abort signal", async () => {
    const manager = createMockChannelManager();
    const abort = new AbortController();
    const monitor = startDefaultMonitor(manager, { abortSignal: abort.signal });
    abort.abort();
    await vi.advanceTimersByTimeAsync(5001);
    expect(manager.getRuntimeSnapshot).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("treats running channels without a connected field as healthy", async () => {
    const manager = createSnapshotManager({
      slack: {
        default: { configured: true, enabled: true, running: true },
      },
    });
    const monitor = await startAndRunCheck(manager);
    expect(manager.stopChannel).not.toHaveBeenCalled();
    monitor.stop();
  });

  describe("stale socket detection", () => {
    const STALE_THRESHOLD = 30 * 60_000;

    it("restarts a channel with no events past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastEventAt: now - STALE_THRESHOLD - 30_000,
          lastStartAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips channels with recent events", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastEventAt: now - 5000,
          lastStartAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("skips channels still within the startup grace window for stale detection", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastEventAt: null,
          lastStartAt: now - 5000,
        }),
      );
      await expectNoRestart(manager);
    });

    it("restarts a channel that has seen no events since connect past the stale threshold", async () => {
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastEventAt: now - STALE_THRESHOLD - 60_000,
          lastStartAt: now - STALE_THRESHOLD - 60_000,
        }),
      );
      await expectRestartedChannel(manager, "slack");
    });

    it("skips connected channels that do not report event liveness", async () => {
      const now = Date.now();
      const manager = createSnapshotManager({
        telegram: {
          default: {
            configured: true,
            connected: true,
            enabled: true,
            lastEventAt: null,
            lastStartAt: now - STALE_THRESHOLD - 60_000,
            running: true,
          },
        },
      });
      await expectNoRestart(manager);
    });

    it("respects custom staleEventThresholdMs", async () => {
      const customThreshold = 10 * 60_000;
      const now = Date.now();
      const manager = createSlackSnapshotManager(
        runningConnectedSlackAccount({
          lastEventAt: now - customThreshold - 30_000,
          lastStartAt: now - customThreshold - 60_000,
        }),
      );
      const monitor = await startAndRunCheck(manager, {
        staleEventThresholdMs: customThreshold,
      });
      expect(manager.stopChannel).toHaveBeenCalledWith("slack", "default");
      expect(manager.startChannel).toHaveBeenCalledWith("slack", "default");
      monitor.stop();
    });
  });
});
