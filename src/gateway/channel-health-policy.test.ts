import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateDiscordHealth(
  account: Record<string, unknown>,
  now = 100_000,
  channelId = "discord",
) {
  return evaluateChannelHealth(account, {
    channelConnectGraceMs: 10_000,
    channelId,
    now,
    staleEventThresholdMs: 30_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateChannelHealth(
      {
        configured: true,
        enabled: false,
        running: false,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now: 100_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateChannelHealth(
      {
        configured: true,
        connected: false,
        enabled: true,
        lastStartAt: 95_000,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now: 100_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        activeRuns: 1,
        configured: true,
        connected: false,
        enabled: true,
        lastRunActivityAt: now - 30_000,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        activeRuns: 1,
        configured: true,
        connected: false,
        enabled: true,
        lastRunActivityAt: now - 26 * 60_000,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateChannelHealth(
      {
        activeRuns: 1,
        busy: true,
        configured: true,
        connected: false,
        enabled: true,
        lastRunActivityAt: now - 31_000,
        lastStartAt: now - 30_000,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when no events arrive beyond threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        configured: true,
        connected: true,
        enabled: true,
        lastEventAt: 0,
        lastStartAt: 0,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "discord",
        now: 100_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("skips stale-socket detection for telegram long-polling channels", () => {
    const evaluation = evaluateChannelHealth(
      {
        configured: true,
        connected: true,
        enabled: true,
        lastEventAt: null,
        lastStartAt: 0,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "telegram",
        now: 100_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("skips stale-socket detection for channels in webhook mode", () => {
    const evaluation = evaluateDiscordHealth({
      configured: true,
      connected: true,
      enabled: true,
      lastEventAt: 0,
      lastStartAt: 0,
      mode: "webhook",
      running: true,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets for channels without event tracking", () => {
    const evaluation = evaluateDiscordHealth({
      configured: true,
      connected: true,
      enabled: true,
      lastEventAt: null,
      lastStartAt: 0,
      running: true,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateDiscordHealth(
      {
        configured: true,
        enabled: true,
        lastEventAt: 0,
        lastStartAt: 0,
        running: true,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited event timestamps from a previous lifecycle", () => {
    const evaluation = evaluateDiscordHealth(
      {
        configured: true,
        connected: true,
        enabled: true,
        lastEventAt: 10_000,
        lastStartAt: 50_000,
        running: true,
      },
      75_000,
      "slack",
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited event timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateChannelHealth(
      {
        configured: true,
        connected: true,
        enabled: true,
        lastEventAt: 10_000,
        lastStartAt: 50_000,
        running: true,
      },
      {
        channelConnectGraceMs: 10_000,
        channelId: "slack",
        now: 140_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        reconnectAttempts: 10,
        running: false,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      {
        configured: true,
        connected: false,
        enabled: true,
        running: true,
      },
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });
});
