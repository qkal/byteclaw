import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.js";
import {
  type SubsystemLogger,
  createSubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { type PluginRegistry, createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";

const hoisted = vi.hoisted(() => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: hoisted.startChannelApprovalHandlerBootstrap,
}));

function createDeferred() {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createTestPlugin(params: {
  startAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;
}): ChannelPlugin {
  return {
    approvalCapability: {
      nativeRuntime: {
        availability: {
          isConfigured: vi.fn().mockReturnValue(true),
          shouldHandle: vi.fn().mockReturnValue(true),
        },
        presentation: {
          buildExpiredResult: vi.fn(),
          buildPendingPayload: vi.fn(),
          buildResolvedResult: vi.fn(),
        },
        transport: {
          deliverPending: vi.fn(),
          prepareTarget: vi.fn(),
        },
      },
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      describeAccount: () => ({
        accountId: DEFAULT_ACCOUNT_ID,
        configured: true,
        enabled: true,
      }),
      isEnabled: () => true,
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => ({ configured: true, enabled: true }),
    },
    gateway: {
      startAccount: params.startAccount,
    },
    id: "discord",
    meta: {
      blurb: "test stub",
      docsPath: "/channels/discord",
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
    },
  };
}

function installTestRegistry(plugin: ChannelPlugin) {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    plugin,
    pluginId: plugin.id,
    source: "test",
  });
  setActivePluginRegistry(registry);
}

function createManager(
  createChannelManager: typeof import("./server-channels.js").createChannelManager,
  options?: {
    channelRuntime?: PluginRuntime["channel"];
  },
) {
  const log = createSubsystemLogger("gateway/server-channels-approval-bootstrap-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  return createChannelManager({
    channelLogs,
    channelRuntimeEnvs,
    loadConfig: () => ({}),
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
  });
}

describe("server-channels approval bootstrap", () => {
  let previousRegistry: PluginRegistry | null = null;
  let createChannelManager: typeof import("./server-channels.js").createChannelManager;

  beforeAll(async () => {
    ({ createChannelManager } = await import("./server-channels.js"));
  });

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    hoisted.startChannelApprovalHandlerBootstrap.mockReset();
  });

  afterEach(() => {
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("starts and stops the shared approval bootstrap with the channel lifecycle", async () => {
    const channelRuntime = createRuntimeChannel();
    const stopApprovalBootstrap = vi.fn(async () => {});
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(stopApprovalBootstrap);

    const started = createDeferred();
    const stopped = createDeferred();
    const startAccount = vi.fn(
      async ({
        abortSignal,
        channelRuntime,
      }: Parameters<NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>>[0]) => {
        channelRuntime?.runtimeContexts.register({
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.native",
          channelId: "discord",
          context: { token: "tracked" },
        });
        started.resolve();
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, { channelRuntime });

    await manager.startChannels();
    await started.promise;

    expect(hoisted.startChannelApprovalHandlerBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: {},
        channelRuntime: expect.objectContaining({
          runtimeContexts: expect.any(Object),
        }),
        plugin: expect.objectContaining({ id: "discord" }),
      }),
    );
    expect(
      channelRuntime.runtimeContexts.get({
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
        channelId: "discord",
      }),
    ).toEqual({ token: "tracked" });

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await stopped.promise;

    expect(stopApprovalBootstrap).toHaveBeenCalledTimes(1);
    expect(
      channelRuntime.runtimeContexts.get({
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
        channelId: "discord",
      }),
    ).toBeUndefined();
  });

  it("keeps the account stopped when approval bootstrap startup fails", async () => {
    const channelRuntime = createRuntimeChannel();
    const startAccount = vi.fn(async () => {});
    hoisted.startChannelApprovalHandlerBootstrap.mockRejectedValue(new Error("boom"));

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager(createChannelManager, { channelRuntime });

    await manager.startChannels();

    expect(startAccount).not.toHaveBeenCalled();
    const accountSnapshot =
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(accountSnapshot).toEqual(
      expect.objectContaining({
        accountId: DEFAULT_ACCOUNT_ID,
        lastError: "boom",
        restartPending: false,
        running: false,
      }),
    );
  });
});
