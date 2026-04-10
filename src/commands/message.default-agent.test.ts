import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { messageCommand } from "./message.js";

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ changes: [], config })));

const resolveCommandSecretRefsViaGateway = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    diagnostics: [] as string[],
    resolvedConfig: config,
  })),
);
const runMessageAction = vi.hoisted(() =>
  vi.fn(async () => ({
    action: "send" as const,
    channel: "telegram" as const,
    dryRun: false,
    handledBy: "core" as const,
    kind: "send" as const,
    payload: { ok: true },
    to: "123456",
  })),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction,
}));

describe("messageCommand agent routing", () => {
  beforeEach(() => {
    testConfig = {};
    applyPluginAutoEnable.mockClear();
    resolveCommandSecretRefsViaGateway.mockClear();
    runMessageAction.mockClear();
  });

  it("passes resolved command config and scoped secret targets to the outbound runner", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { $secret: "vault://telegram/token" },
        },
      },
    };
    const resolvedConfig = {
      channels: {
        telegram: {
          token: "12345:resolved-token",
        },
      },
    };
    testConfig = rawConfig;
    resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      diagnostics: [],
      resolvedConfig,
    });

    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        json: true,
        message: "hi",
        target: "123456",
      },
      {} as CliDeps,
      runtime,
    );

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "message",
        config: rawConfig,
      }),
    );
    const call = resolveCommandSecretRefsViaGateway.mock.calls[0]?.[0] as {
      targetIds?: Set<string>;
    };
    expect(call.targetIds).toBeInstanceOf(Set);
    expect([...(call.targetIds ?? [])].every((id) => id.startsWith("channels.telegram."))).toBe(
      true,
    );
    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
      }),
    );
  });

  it("passes the resolved default agent id to the outbound runner", async () => {
    testConfig = {
      agents: {
        list: [{ id: "alpha" }, { default: true, id: "ops" }],
      },
    };

    const runtime: RuntimeEnv = {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    };
    await messageCommand(
      {
        action: "send",
        channel: "telegram",
        json: true,
        message: "hi",
        target: "123456",
      },
      {} as CliDeps,
      runtime,
    );

    expect(runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
      }),
    );
  });
});
