import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { formatHealthCheckFailure } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import { formatHealthChannelLines, healthCommand } from "./health.js";

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

const defaultSessions: HealthSummary["sessions"] = {
  count: 0,
  path: "/tmp/sessions.json",
  recent: [],
};

const createMainAgentSummary = (sessions = defaultSessions) => ({
  agentId: "main",
  heartbeat: {
    ackMaxChars: 160,
    enabled: true,
    every: "1m",
    everyMs: 60_000,
    prompt: "hi",
    target: "last",
  },
  isDefault: true,
  sessions,
});

const createHealthSummary = (params: {
  channels: HealthSummary["channels"];
  channelOrder: string[];
  channelLabels: HealthSummary["channelLabels"];
  sessions?: HealthSummary["sessions"];
}): HealthSummary => {
  const sessions = params.sessions ?? defaultSessions;
  return {
    agents: [createMainAgentSummary(sessions)],
    channelLabels: params.channelLabels,
    channelOrder: params.channelOrder,
    channels: params.channels,
    defaultAgentId: "main",
    durationMs: 5,
    heartbeatSeconds: 60,
    ok: true,
    sessions,
    ts: Date.now(),
  };
};

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

describe("healthCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outputs JSON from gateway", async () => {
    const agentSessions = {
      count: 1,
      path: "/tmp/sessions.json",
      recent: [{ age: 0, key: "+1555", updatedAt: Date.now() }],
    };
    const snapshot = createHealthSummary({
      channelLabels: {
        discord: "Discord",
        telegram: "Telegram",
        whatsapp: "WhatsApp",
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channels: {
        discord: { accountId: "default", configured: false },
        telegram: {
          accountId: "default",
          configured: true,
          probe: { elapsedMs: 1, ok: true },
        },
        whatsapp: { accountId: "default", authAgeMs: 5000, linked: true },
      },
      sessions: agentSessions,
    });
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: true, timeoutMs: 5000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const logged = runtime.log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(logged) as HealthSummary;
    expect(parsed.channels.whatsapp?.linked).toBe(true);
    expect(parsed.channels.telegram?.configured).toBe(true);
    expect(parsed.sessions.count).toBe(1);
  });

  it("prints text summary when not json", async () => {
    callGatewayMock.mockResolvedValueOnce(
      createHealthSummary({
        channelLabels: {
          discord: "Discord",
          telegram: "Telegram",
          whatsapp: "WhatsApp",
        },
        channelOrder: ["whatsapp", "telegram", "discord"],
        channels: {
          discord: { accountId: "default", configured: false },
          telegram: { accountId: "default", configured: false },
          whatsapp: { accountId: "default", authAgeMs: null, linked: false },
        },
      }),
    );

    await healthCommand({ json: false }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });

  it("formats per-account probe timings", () => {
    const summary = createHealthSummary({
      channelLabels: { telegram: "Telegram" },
      channelOrder: ["telegram"],
      channels: {
        telegram: {
          accountId: "main",
          accounts: {
            flurry: {
              accountId: "flurry",
              configured: true,
              probe: { bot: { username: "flurry_ugi_bot" }, elapsedMs: 190, ok: true },
            },
            main: {
              accountId: "main",
              configured: true,
              probe: { bot: { username: "pinguini_ugi_bot" }, elapsedMs: 196, ok: true },
            },
            poe: {
              accountId: "poe",
              configured: true,
              probe: { bot: { username: "poe_ugi_bot" }, elapsedMs: 188, ok: true },
            },
          },
          configured: true,
          probe: { bot: { username: "pinguini_ugi_bot" }, elapsedMs: 196, ok: true },
        },
      },
    });

    const lines = formatHealthChannelLines(summary, { accountMode: "all" });
    expect(lines).toContain(
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    );
  });
});

describe("formatHealthCheckFailure", () => {
  it("keeps non-rich output stable", () => {
    const err = new Error("gateway closed (1006 abnormal closure): no close reason");
    expect(formatHealthCheckFailure(err, { rich: false })).toBe(
      `Health check failed: ${String(err)}`,
    );
  });

  it("formats gateway connection details as indented key/value lines", () => {
    const err = new Error(
      [
        "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "Gateway target: ws://127.0.0.1:19001",
        "Source: local loopback",
        "Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "Bind: loopback",
      ].join("\n"),
    );

    expect(stripAnsi(formatHealthCheckFailure(err, { rich: true }))).toBe(
      [
        "Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "  Gateway target: ws://127.0.0.1:19001",
        "  Source: local loopback",
        "  Config: /Users/steipete/.openclaw-dev/openclaw.json",
        "  Bind: loopback",
      ].join("\n"),
    );
  });
});
