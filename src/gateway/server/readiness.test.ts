import { describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.js";
import type { ChannelManager, ChannelRuntimeSnapshot } from "../server-channels.js";
import { createReadinessChecker } from "./readiness.js";

function snapshotWith(
  accounts: Record<string, Partial<ChannelAccountSnapshot>>,
): ChannelRuntimeSnapshot {
  const channels: ChannelRuntimeSnapshot["channels"] = {};
  const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};

  for (const [channelId, accountSnapshot] of Object.entries(accounts)) {
    const resolved = { accountId: "default", ...accountSnapshot } as ChannelAccountSnapshot;
    channels[channelId as ChannelId] = resolved;
    channelAccounts[channelId as ChannelId] = { default: resolved };
  }

  return { channelAccounts, channels };
}

function createManager(snapshot: ChannelRuntimeSnapshot): ChannelManager {
  return {
    getRuntimeSnapshot: vi.fn(() => snapshot),
    isHealthMonitorEnabled: vi.fn(() => true),
    isManuallyStopped: vi.fn(() => false),
    markChannelLoggedOut: vi.fn(),
    resetRestartAttempts: vi.fn(),
    startChannel: vi.fn(),
    startChannels: vi.fn(),
    stopChannel: vi.fn(),
  };
}

function createHealthyDiscordManager(startedAt: number, lastEventAt: number): ChannelManager {
  return createManager(
    snapshotWith({
      discord: {
        configured: true,
        connected: true,
        enabled: true,
        lastEventAt,
        lastStartAt: startedAt,
        running: true,
      },
    }),
  );
}

function withReadinessClock(run: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  try {
    run();
  } finally {
    vi.useRealTimers();
  }
}

function createReadinessHarness(params: {
  startedAgoMs: number;
  accounts: Record<string, Partial<ChannelAccountSnapshot>>;
  cacheTtlMs?: number;
}) {
  const startedAt = Date.now() - params.startedAgoMs;
  const manager = createManager(snapshotWith(params.accounts));
  return {
    manager,
    readiness: createReadinessChecker({
      cacheTtlMs: params.cacheTtlMs,
      channelManager: manager,
      startedAt,
    }),
  };
}

describe("createReadinessChecker", () => {
  it("reports ready when all managed channels are healthy", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const manager = createHealthyDiscordManager(startedAt, Date.now() - 1000);

      const readiness = createReadinessChecker({ channelManager: manager, startedAt });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 300_000 });
    });
  });

  it("ignores disabled and unconfigured channels", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            enabled: false,
            lastStartAt: Date.now() - 5 * 60_000,
            running: false,
          },
          telegram: {
            configured: false,
            enabled: true,
            lastStartAt: Date.now() - 5 * 60_000,
            running: false,
          },
        },
        startedAgoMs: 5 * 60_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 300_000 });
    });
  });

  it("uses startup grace before marking disconnected channels not ready", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            connected: false,
            enabled: true,
            lastStartAt: Date.now() - 30_000,
            running: true,
          },
        },
        startedAgoMs: 30_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 30_000 });
    });
  });

  it("reports disconnected managed channels after startup grace", () => {
    withReadinessClock(() => {
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            connected: false,
            enabled: true,
            lastStartAt: Date.now() - 5 * 60_000,
            running: true,
          },
        },
        startedAgoMs: 5 * 60_000,
      });
      expect(readiness()).toEqual({ failing: ["discord"], ready: false, uptimeMs: 300_000 });
    });
  });

  it("keeps restart-pending channels ready during reconnect backoff", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 5 * 60_000;
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            enabled: true,
            lastStartAt: startedAt - 30_000,
            lastStopAt: Date.now() - 5000,
            reconnectAttempts: 3,
            restartPending: true,
            running: false,
          },
        },
        startedAgoMs: 5 * 60_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 300_000 });
    });
  });

  it("treats stale-socket channels as ready to avoid pulling healthy idle pods", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            connected: true,
            enabled: true,
            lastEventAt: Date.now() - 31 * 60_000,
            lastStartAt: startedAt,
            running: true,
          },
        },
        startedAgoMs: 31 * 60_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 1_860_000 });
    });
  });

  it("keeps telegram long-polling channels ready without stale-socket classification", () => {
    withReadinessClock(() => {
      const startedAt = Date.now() - 31 * 60_000;
      const { readiness } = createReadinessHarness({
        accounts: {
          telegram: {
            configured: true,
            connected: true,
            enabled: true,
            lastEventAt: null,
            lastStartAt: startedAt,
            running: true,
          },
        },
        startedAgoMs: 31 * 60_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 1_860_000 });
    });
  });

  it("caches readiness snapshots briefly to keep repeated probes cheap", () => {
    withReadinessClock(() => {
      const { manager, readiness } = createReadinessHarness({
        accounts: {
          discord: {
            configured: true,
            connected: true,
            enabled: true,
            lastEventAt: Date.now() - 1000,
            lastStartAt: Date.now() - 5 * 60_000,
            running: true,
          },
        },
        cacheTtlMs: 1000,
        startedAgoMs: 5 * 60_000,
      });
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 300_000 });
      vi.advanceTimersByTime(500);
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 300_500 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      expect(readiness()).toEqual({ failing: [], ready: true, uptimeMs: 301_100 });
      expect(manager.getRuntimeSnapshot).toHaveBeenCalledTimes(2);
    });
  });
});
