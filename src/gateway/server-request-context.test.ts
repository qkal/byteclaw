import { describe, expect, it, vi } from "vitest";
import type { GatewayServerLiveState } from "./server-live-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";

describe("createGatewayRequestContext", () => {
  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: Pick<GatewayServerLiveState, "cronState"> = {
      cronState: {
        cron: cronA,
        cronEnabled: true,
        storePath: "/tmp/cron-a",
      },
    };

    const context = createGatewayRequestContext({
      addChatRun: vi.fn(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      broadcastVoiceWakeChanged: vi.fn(),
      chatAbortControllers: new Map(),
      chatAbortedRuns: new Map(),
      chatDeltaLastBroadcastLen: new Map(),
      chatDeltaSentAt: new Map(),
      chatRunBuffers: new Map(),
      clients: new Set(),
      dedupe: new Map(),
      deps: {} as never,
      enforceSharedGatewayAuthGenerationForConfigWrite: vi.fn(),
      execApprovalManager: undefined,
      findRunningWizard: vi.fn(() => null),
      getHealthCache: vi.fn(() => null),
      getHealthVersion: vi.fn(() => 1),
      getRuntimeSnapshot: vi.fn(() => ({}) as never),
      getSessionEventSubscriberConnIds: vi.fn(() => new Set<string>()),
      hasConnectedMobileNode: vi.fn(() => false),
      incrementPresenceVersion: vi.fn(() => 1),
      loadGatewayModelCatalog: vi.fn(async () => []),
      logGateway: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      logHealth: { error: vi.fn() },
      markChannelLoggedOut: vi.fn(),
      nodeRegistry: {} as never,
      nodeSendToAllSubscribed: vi.fn(),
      nodeSendToSession: vi.fn(),
      nodeSubscribe: vi.fn(),
      nodeUnsubscribe: vi.fn(),
      nodeUnsubscribeAll: vi.fn(),
      pluginApprovalManager: undefined,
      purgeWizardSession: vi.fn(),
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      registerToolEventRecipient: vi.fn(),
      removeChatRun: vi.fn(),
      runtimeState,
      startChannel: vi.fn(async () => undefined),
      stopChannel: vi.fn(async () => undefined),
      subscribeSessionEvents: vi.fn(),
      subscribeSessionMessageEvents: vi.fn(),
      unavailableGatewayMethods: new Set(),
      unsubscribeAllSessionEvents: vi.fn(),
      unsubscribeSessionEvents: vi.fn(),
      unsubscribeSessionMessageEvents: vi.fn(),
      wizardRunner: vi.fn(async () => undefined),
      wizardSessions: new Map(),
    });

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = {
      cron: cronB,
      cronEnabled: true,
      storePath: "/tmp/cron-b",
    };

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });
});
