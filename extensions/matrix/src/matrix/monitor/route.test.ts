import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import {
  type OpenClawConfig,
  createTestRegistry,
  registerSessionBindingAdapter,
  resolveAgentRoute,
  __testing as sessionBindingTesting,
  setActivePluginRegistry,
} from "../../test-support/monitor-route-test-support.js";
import { resolveMatrixInboundRoute } from "./route.js";

const baseCfg = {
  agents: {
    list: [{ id: "main" }, { id: "sender-agent" }, { id: "room-agent" }, { id: "acp-agent" }],
  },
  session: { mainKey: "main" },
} satisfies OpenClawConfig;

type RouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type RoutePeer = NonNullable<RouteBinding["match"]["peer"]>;

function matrixBinding(
  agentId: string,
  peer?: RoutePeer,
  type?: RouteBinding["type"],
): RouteBinding {
  return {
    ...(type ? { type } : {}),
    agentId,
    match: {
      accountId: "ops",
      channel: "matrix",
      ...(peer ? { peer } : {}),
    },
  } as RouteBinding;
}

function senderPeer(id = "@alice:example.org"): RoutePeer {
  return { id, kind: "direct" };
}

function dmRoomPeer(id = "!dm:example.org"): RoutePeer {
  return { id, kind: "channel" };
}

function resolveDmRoute(
  cfg: OpenClawConfig,
  opts: {
    dmSessionScope?: "per-user" | "per-room";
  } = {},
) {
  return resolveMatrixInboundRoute({
    accountId: "ops",
    cfg,
    dmSessionScope: opts.dmSessionScope,
    isDirectMessage: true,
    resolveAgentRoute,
    roomId: "!dm:example.org",
    senderId: "@alice:example.org",
  });
}

describe("resolveMatrixInboundRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ plugin: matrixPlugin, pluginId: "matrix", source: "test" }]),
    );
  });

  it("prefers sender-bound DM routing over DM room fallback bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("sender-agent", senderPeer()),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("sender-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:sender-agent:main");
  });

  it("uses the DM room as a parent-peer fallback before account-level bindings", () => {
    const cfg = {
      ...baseCfg,
      bindings: [matrixBinding("acp-agent"), matrixBinding("room-agent", dmRoomPeer())],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("room-agent");
    expect(route.matchedBy).toBe("binding.peer.parent");
    expect(route.sessionKey).toBe("agent:room-agent:main");
  });

  it("can isolate Matrix DMs per room without changing agent selection", () => {
    const cfg = {
      ...baseCfg,
      bindings: [matrixBinding("sender-agent", senderPeer())],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg, {
      dmSessionScope: "per-room",
    });

    expect(configuredBinding).toBeNull();
    expect(route.agentId).toBe("sender-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:sender-agent:matrix:channel:!dm:example.org");
    expect(route.mainSessionKey).toBe("agent:sender-agent:main");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("lets configured ACP room bindings override DM parent-peer routing", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("acp-agent", dmRoomPeer(), "acp"),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg);

    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route.agentId).toBe("acp-agent");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("keeps configured ACP room bindings ahead of per-room DM session scope", () => {
    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("room-agent", dmRoomPeer()),
        matrixBinding("acp-agent", dmRoomPeer(), "acp"),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding } = resolveDmRoute(cfg, {
      dmSessionScope: "per-room",
    });

    expect(configuredBinding?.spec.agentId).toBe("acp-agent");
    expect(route.agentId).toBe("acp-agent");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toContain("agent:acp-agent:acp:binding:matrix:ops:");
    expect(route.sessionKey).not.toBe("agent:acp-agent:matrix:channel:!dm:example.org");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("lets runtime conversation bindings override both sender and room route matches", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      accountId: "ops",
      channel: "matrix",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "!dm:example.org"
          ? {
              bindingId: "ops:!dm:example.org",
              boundAt: Date.now(),
              conversation: {
                accountId: "ops",
                channel: "matrix",
                conversationId: "!dm:example.org",
              },
              metadata: { boundBy: "user-1" },
              status: "active",
              targetKind: "session",
              targetSessionKey: "agent:bound:session-1",
            }
          : null,
      touch,
    });

    const cfg = {
      ...baseCfg,
      bindings: [
        matrixBinding("sender-agent", senderPeer()),
        matrixBinding("room-agent", dmRoomPeer()),
      ],
    } satisfies OpenClawConfig;

    const { route, configuredBinding, runtimeBindingId } = resolveDmRoute(cfg);

    expect(configuredBinding).toBeNull();
    expect(runtimeBindingId).toBe("ops:!dm:example.org");
    expect(route.agentId).toBe("bound");
    expect(route.matchedBy).toBe("binding.channel");
    expect(route.sessionKey).toBe("agent:bound:session-1");
    expect(route.lastRoutePolicy).toBe("session");
    expect(touch).not.toHaveBeenCalled();
  });
});

describe("resolveMatrixInboundRoute thread-isolated sessions", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([{ plugin: matrixPlugin, pluginId: "matrix", source: "test" }]),
    );
  });

  it("scopes session key to thread when a thread id is provided", () => {
    const { route } = resolveMatrixInboundRoute({
      accountId: "ops",
      cfg: baseCfg as never,
      isDirectMessage: false,
      resolveAgentRoute,
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      threadId: "$thread-root",
    });

    expect(route.sessionKey).toContain(":thread:$thread-root");
    expect(route.mainSessionKey).not.toContain(":thread:");
    expect(route.lastRoutePolicy).toBe("session");
  });

  it("preserves mixed-case matrix thread ids in session keys", () => {
    const { route } = resolveMatrixInboundRoute({
      accountId: "ops",
      cfg: baseCfg as never,
      isDirectMessage: false,
      resolveAgentRoute,
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
      threadId: "$AbC123:example.org",
    });

    expect(route.sessionKey).toContain(":thread:$AbC123:example.org");
  });

  it("does not scope session key when thread id is absent", () => {
    const { route } = resolveMatrixInboundRoute({
      accountId: "ops",
      cfg: baseCfg as never,
      isDirectMessage: false,
      resolveAgentRoute,
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(route.sessionKey).not.toContain(":thread:");
  });
});
