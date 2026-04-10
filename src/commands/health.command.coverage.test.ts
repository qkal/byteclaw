import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { stripAnsi } from "../terminal/ansi.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HealthSummary } from "./health.js";
import { healthCommand } from "./health.js";

const callGatewayMock = vi.fn();
const buildGatewayConnectionDetailsMock = vi.fn(() => ({
  message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
}));
const logWebSelfIdMock = vi.fn();

function createRecentSessionRows(now = Date.now()) {
  return [
    { age: 60_000, key: "main", updatedAt: now - 60_000 },
    { age: null, key: "foo", updatedAt: null },
  ];
}

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(buildGatewayConnectionDetailsMock, undefined, args),
  callGateway: (...args: [unknown, ...unknown[]]) =>
    Reflect.apply(callGatewayMock, undefined, args),
}));

describe("healthCommand (coverage)", () => {
  const runtime = {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    buildGatewayConnectionDetailsMock.mockReturnValue({
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
            id: "whatsapp",
            meta: {
              blurb: "WhatsApp test stub.",
              docsPath: "/channels/whatsapp",
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
            },
            status: {
              logSelfId: () => logWebSelfIdMock(),
            },
          },
          pluginId: "whatsapp",
          source: "test",
        },
      ]),
    );
  });

  it("prints the rich text summary when linked and configured", async () => {
    const recent = createRecentSessionRows();
    callGatewayMock.mockResolvedValueOnce({
      agents: [
        {
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
          sessions: {
            count: 2,
            path: "/tmp/sessions.json",
            recent,
          },
        },
      ],
      channelLabels: {
        discord: "Discord",
        telegram: "Telegram",
        whatsapp: "WhatsApp",
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channels: {
        discord: {
          accountId: "default",
          configured: false,
        },
        telegram: {
          accountId: "default",
          configured: true,
          probe: {
            bot: { username: "bot" },
            elapsedMs: 7,
            ok: true,
            webhook: { url: "https://example.com/h" },
          },
        },
        whatsapp: {
          accountId: "default",
          authAgeMs: 5 * 60_000,
          linked: true,
        },
      },
      defaultAgentId: "main",
      durationMs: 5,
      heartbeatSeconds: 60,
      ok: true,
      sessions: {
        count: 2,
        path: "/tmp/sessions.json",
        recent,
      },
      ts: Date.now(),
    } satisfies HealthSummary);

    await healthCommand({ json: false, timeoutMs: 1000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"))).toMatch(
      /WhatsApp: linked/i,
    );
    expect(logWebSelfIdMock).toHaveBeenCalled();
  });

  it("prints gateway connection details in verbose mode", async () => {
    callGatewayMock.mockResolvedValueOnce({
      agents: [],
      channelLabels: {},
      channelOrder: [],
      channels: {},
      defaultAgentId: "main",
      durationMs: 5,
      heartbeatSeconds: 60,
      ok: true,
      sessions: {
        count: 0,
        path: "/tmp/sessions.json",
        recent: [],
      },
      ts: Date.now(),
    } satisfies HealthSummary);

    await healthCommand({ json: false, timeoutMs: 1000, verbose: true }, runtime as never);

    expect(runtime.log.mock.calls.slice(0, 3)).toEqual([
      ["Gateway connection:"],
      ["  Gateway mode: local"],
      ["  Gateway target: ws://127.0.0.1:18789"],
    ]);
    expect(buildGatewayConnectionDetailsMock).toHaveBeenCalled();
  });
});
