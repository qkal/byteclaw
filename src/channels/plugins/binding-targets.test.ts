import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureConfiguredBindingTargetReady,
  ensureConfiguredBindingTargetSession,
  resetConfiguredBindingTargetInPlace,
} from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import {
  type StatefulBindingTargetDriver,
  registerStatefulBindingTargetDriver,
  unregisterStatefulBindingTargetDriver,
} from "./stateful-target-drivers.js";

function createBindingResolution(driverId: string): ConfiguredBindingResolution {
  return {
    compiledBinding: {
      agentId: "codex",
      binding: {
        acp: {
          mode: "persistent",
        },
        agentId: "codex",
        match: {
          channel: "demo-binding",
          peer: {
            id: "123",
            kind: "channel" as const,
          },
        },
        type: "acp" as const,
      },
      bindingConversationId: "123",
      channel: "demo-binding",
      provider: {
        compileConfiguredBinding: () => ({
          conversationId: "123",
        }),
        matchInboundConversation: () => ({
          conversationId: "123",
        }),
      },
      target: {
        conversationId: "123",
      },
      targetFactory: {
        driverId,
        materialize: () => ({
          record: {
            bindingId: "binding:123",
            boundAt: 0,
            conversation: {
              accountId: "default",
              channel: "demo-binding",
              conversationId: "123",
            },
            status: "active",
            targetKind: "session",
            targetSessionKey: `agent:codex:${driverId}`,
          },
          statefulTarget: {
            agentId: "codex",
            driverId,
            kind: "stateful",
            sessionKey: `agent:codex:${driverId}`,
          },
        }),
      },
    },
    conversation: {
      accountId: "default",
      channel: "demo-binding",
      conversationId: "123",
    },
    match: {
      conversationId: "123",
    },
    record: {
      bindingId: "binding:123",
      boundAt: 0,
      conversation: {
        accountId: "default",
        channel: "demo-binding",
        conversationId: "123",
      },
      status: "active",
      targetKind: "session",
      targetSessionKey: `agent:codex:${driverId}`,
    },
    statefulTarget: {
      agentId: "codex",
      driverId,
      kind: "stateful",
      sessionKey: `agent:codex:${driverId}`,
    },
  };
}

afterEach(() => {
  unregisterStatefulBindingTargetDriver("test-driver");
});

describe("binding target drivers", () => {
  it("delegates ensureReady and ensureSession to the resolved driver", async () => {
    const ensureReady = vi.fn(async () => ({ ok: true as const }));
    const ensureSession = vi.fn(async () => ({
      ok: true as const,
      sessionKey: "agent:codex:test-driver",
    }));
    const driver: StatefulBindingTargetDriver = {
      ensureReady,
      ensureSession,
      id: "test-driver",
    };
    registerStatefulBindingTargetDriver(driver);

    const bindingResolution = createBindingResolution("test-driver");
    await expect(
      ensureConfiguredBindingTargetReady({
        bindingResolution,
        cfg: {} as never,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      ensureConfiguredBindingTargetSession({
        bindingResolution,
        cfg: {} as never,
      }),
    ).resolves.toEqual({
      ok: true,
      sessionKey: "agent:codex:test-driver",
    });

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith({
      bindingResolution,
      cfg: {} as never,
    });
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledWith({
      bindingResolution,
      cfg: {} as never,
    });
  });

  it("resolves resetInPlace through the driver session-key lookup", async () => {
    const resetInPlace = vi.fn(async () => ({ ok: true as const }));
    const driver: StatefulBindingTargetDriver = {
      ensureReady: async () => ({ ok: true }),
      ensureSession: async () => ({
        ok: true,
        sessionKey: "agent:codex:test-driver",
      }),
      id: "test-driver",
      resetInPlace,
      resolveTargetBySessionKey: ({ sessionKey }) => ({
        agentId: "codex",
        driverId: "test-driver",
        kind: "stateful",
        sessionKey,
      }),
    };
    registerStatefulBindingTargetDriver(driver);

    await expect(
      resetConfiguredBindingTargetInPlace({
        cfg: {} as never,
        commandSource: "discord:native",
        reason: "reset",
        sessionKey: "agent:codex:test-driver",
      }),
    ).resolves.toEqual({ ok: true });

    expect(resetInPlace).toHaveBeenCalledTimes(1);
    expect(resetInPlace).toHaveBeenCalledWith({
      bindingTarget: {
        agentId: "codex",
        driverId: "test-driver",
        kind: "stateful",
        sessionKey: "agent:codex:test-driver",
      },
      cfg: {} as never,
      commandSource: "discord:native",
      reason: "reset",
      sessionKey: "agent:codex:test-driver",
    });
  });

  it("returns a typed error when no driver is registered", async () => {
    const bindingResolution = createBindingResolution("missing-driver");

    await expect(
      ensureConfiguredBindingTargetReady({
        bindingResolution,
        cfg: {} as never,
      }),
    ).resolves.toEqual({
      error: "Configured binding target driver unavailable: missing-driver",
      ok: false,
    });
    await expect(
      ensureConfiguredBindingTargetSession({
        bindingResolution,
        cfg: {} as never,
      }),
    ).resolves.toEqual({
      error: "Configured binding target driver unavailable: missing-driver",
      ok: false,
      sessionKey: "agent:codex:missing-driver",
    });
  });
});
