import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import {
  buildDiscordRoutePeer,
  resolveDiscordBoundConversationRoute,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";

function buildWorkerBindingConfig(peer: {
  kind: "channel" | "direct";
  id: string;
}): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker" }],
    },
    bindings: [
      {
        agentId: "worker",
        match: {
          accountId: "default",
          channel: "discord",
          peer,
        },
      },
    ],
  };
}

describe("discord route resolution helpers", () => {
  it("builds a direct peer from DM metadata", () => {
    expect(
      buildDiscordRoutePeer({
        conversationId: "channel-1",
        directUserId: "user-1",
        isDirectMessage: true,
        isGroupDm: false,
      }),
    ).toEqual({
      id: "user-1",
      kind: "direct",
    });
  });

  it("resolves bound session keys on top of the routed session", () => {
    const route: ResolvedAgentRoute = {
      accountId: "default",
      agentId: "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:discord:channel:c1",
    };

    expect(
      resolveDiscordEffectiveRoute({
        boundSessionKey: "agent:worker:discord:channel:c1",
        matchedBy: "binding.channel",
        route,
      }),
    ).toEqual({
      ...route,
      agentId: "worker",
      matchedBy: "binding.channel",
      sessionKey: "agent:worker:discord:channel:c1",
    });
  });

  it("falls back to configured route when no bound session exists", () => {
    const route: ResolvedAgentRoute = {
      accountId: "default",
      agentId: "main",
      channel: "discord",
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
      sessionKey: "agent:main:discord:channel:c1",
    };
    const configuredRoute = {
      route: {
        ...route,
        agentId: "worker",
        lastRoutePolicy: "session" as const,
        mainSessionKey: "agent:worker:main",
        matchedBy: "binding.peer" as const,
        sessionKey: "agent:worker:discord:channel:c1",
      },
    };

    expect(
      resolveDiscordEffectiveRoute({
        configuredRoute,
        route,
      }),
    ).toEqual(configuredRoute.route);
  });

  it("resolves the same route shape as the inline Discord route inputs", () => {
    const cfg = buildWorkerBindingConfig({ id: "c1", kind: "channel" });

    expect(
      resolveDiscordConversationRoute({
        accountId: "default",
        cfg,
        guildId: "g1",
        memberRoleIds: [],
        peer: { id: "c1", kind: "channel" },
      }),
    ).toMatchObject({
      agentId: "worker",
      matchedBy: "binding.peer",
      sessionKey: "agent:worker:discord:channel:c1",
    });
  });

  it("composes route building with effective-route overrides", () => {
    const cfg = buildWorkerBindingConfig({ id: "user-1", kind: "direct" });

    expect(
      resolveDiscordBoundConversationRoute({
        accountId: "default",
        boundSessionKey: "agent:worker:discord:direct:user-1",
        cfg,
        conversationId: "dm-1",
        directUserId: "user-1",
        isDirectMessage: true,
        isGroupDm: false,
        matchedBy: "binding.channel",
      }),
    ).toMatchObject({
      agentId: "worker",
      matchedBy: "binding.channel",
      sessionKey: "agent:worker:discord:direct:user-1",
    });
  });
});
