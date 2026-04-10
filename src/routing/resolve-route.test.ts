import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as routingBindings from "./bindings.js";
import {
  deriveLastRoutePolicy,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
} from "./resolve-route.js";

interface ResolvedRouteExpectation {
  agentId: string;
  matchedBy: string;
  sessionKey?: string;
  accountId?: string;
  lastRoutePolicy?: string;
}

type CompatRoutePeerKind =
  | NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>["kind"]
  | "dm";

const resolveRoute = (
  params: Omit<Parameters<typeof resolveAgentRoute>[0], "cfg"> & { cfg?: OpenClawConfig },
) =>
  resolveAgentRoute({
    cfg: params.cfg ?? {},
    ...params,
  });

function expectResolvedRoute(
  route: ReturnType<typeof resolveAgentRoute>,
  expected: ResolvedRouteExpectation,
) {
  expect(route.agentId).toBe(expected.agentId);
  expect(route.matchedBy).toBe(expected.matchedBy);
  if (expected.sessionKey !== undefined) {
    expect(route.sessionKey).toBe(expected.sessionKey);
  }
  if (expected.accountId !== undefined) {
    expect(route.accountId).toBe(expected.accountId);
  }
  if (expected.lastRoutePolicy !== undefined) {
    expect(route.lastRoutePolicy).toBe(expected.lastRoutePolicy);
  }
}

function createCompatPeer(kind: CompatRoutePeerKind, id: string) {
  return { id, kind } as unknown as NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>;
}

describe("resolveAgentRoute", () => {
  const expectDirectRouteSessionKey = (params: {
    cfg: OpenClawConfig;
    channel: Parameters<typeof resolveAgentRoute>[0]["channel"];
    peerId: string;
    expected: string;
  }) => {
    const route = resolveRoute({
      accountId: null,
      cfg: params.cfg,
      channel: params.channel,
      peer: { id: params.peerId, kind: "direct" },
    });
    expect(route.sessionKey).toBe(params.expected);
    return route;
  };

  const expectRouteResolutionCase = (params: {
    routeParams: Omit<Parameters<typeof resolveRoute>[0], "cfg"> & { cfg: OpenClawConfig };
    expected: ResolvedRouteExpectation;
  }) => {
    expectResolvedRoute(resolveRoute(params.routeParams), params.expected);
  };

  const expectInboundLastRouteSessionKeyCase = (params: {
    route: { mainSessionKey: string; lastRoutePolicy: "main" | "session" };
    sessionKey: string;
    expected: string;
  }) => {
    expect(
      resolveInboundLastRouteSessionKey({
        route: params.route,
        sessionKey: params.sessionKey,
      }),
    ).toBe(params.expected);
  };

  const expectDerivedLastRoutePolicyCase = (params: {
    sessionKey: string;
    mainSessionKey: string;
    expected: "main" | "session";
  }) => {
    expect(
      deriveLastRoutePolicy({
        mainSessionKey: params.mainSessionKey,
        sessionKey: params.sessionKey,
      }),
    ).toBe(params.expected);
  };

  test("defaults to main/default when no bindings exist", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      accountId: null,
      cfg,
      channel: "whatsapp",
      peer: { id: "+15551234567", kind: "direct" },
    });
    expectResolvedRoute(route, {
      accountId: "default",
      agentId: "main",
      lastRoutePolicy: "main",
      matchedBy: "default",
      sessionKey: "agent:main:main",
    });
  });

  test.each([
    { dmScope: "per-peer" as const, expected: "agent:main:direct:+15551234567" },
    {
      dmScope: "per-channel-peer" as const,
      expected: "agent:main:whatsapp:direct:+15551234567",
    },
  ])("dmScope=%s controls direct-message session key isolation", ({ dmScope, expected }) => {
    const cfg: OpenClawConfig = {
      session: { dmScope },
    };
    const route = expectDirectRouteSessionKey({
      cfg,
      channel: "whatsapp",
      expected,
      peerId: "+15551234567",
    });
    expectResolvedRoute(route, {
      agentId: "main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
  });

  test.each([
    {
      expected: "agent:main:main",
      name: "collapses inbound last-route session keys to main when policy is main",
      route: {
        lastRoutePolicy: "main" as const,
        mainSessionKey: "agent:main:main",
      },
      sessionKey: "agent:main:discord:direct:user-1",
    },
    {
      expected: "agent:main:telegram:atlas:direct:123",
      name: "preserves inbound last-route session keys when policy is session",
      route: {
        lastRoutePolicy: "session" as const,
        mainSessionKey: "agent:main:main",
      },
      sessionKey: "agent:main:telegram:atlas:direct:123",
    },
  ] as const)("$name", ({ route, sessionKey, expected }) => {
    expectInboundLastRouteSessionKeyCase({ expected, route, sessionKey });
  });

  test.each([
    {
      expected: "main" as const,
      mainSessionKey: "agent:main:main",
      name: "classifies the main session route as main",
      sessionKey: "agent:main:main",
    },
    {
      expected: "session" as const,
      mainSessionKey: "agent:main:main",
      name: "keeps non-main session routes scoped to session",
      sessionKey: "agent:main:telegram:direct:123",
    },
  ] as const)("$name", ({ sessionKey, mainSessionKey, expected }) => {
    expectDerivedLastRoutePolicyCase({ expected, mainSessionKey, sessionKey });
  });

  test.each([
    {
      channel: "telegram" as const,
      dmScope: "per-peer" as const,
      expected: "agent:main:direct:alice",
      peerId: "111111111",
    },
    {
      channel: "discord" as const,
      dmScope: "per-channel-peer" as const,
      expected: "agent:main:discord:direct:alice",
      peerId: "222222222222222222",
    },
  ])(
    "identityLinks applies to direct-message scopes: $channel $dmScope",
    ({ dmScope, channel, peerId, expected }) => {
      const cfg: OpenClawConfig = {
        session: {
          dmScope,
          identityLinks: {
            alice: ["telegram:111111111", "discord:222222222222222222"],
          },
        },
      };
      expectDirectRouteSessionKey({
        cfg,
        channel,
        expected,
        peerId,
      });
    },
  );

  test.each([
    {
      expected: {
        agentId: "a",
        matchedBy: "binding.peer",
        sessionKey: "agent:a:main",
      },
      name: "peer binding wins over account binding",
      routeParams: {
        accountId: "biz",
        cfg: {
          bindings: [
            {
              agentId: "a",
              match: {
                accountId: "biz",
                channel: "whatsapp",
                peer: { id: "+1000", kind: "direct" },
              },
            },
            {
              agentId: "b",
              match: { accountId: "biz", channel: "whatsapp" },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "whatsapp" as const,
        peer: { id: "+1000", kind: "direct" as const },
      },
    },
    {
      expected: {
        agentId: "chan",
        matchedBy: "binding.peer",
        sessionKey: "agent:chan:discord:channel:c1",
      },
      name: "discord channel peer binding wins over guild binding",
      routeParams: {
        accountId: "default",
        cfg: {
          bindings: [
            {
              agentId: "chan",
              match: {
                accountId: "default",
                channel: "discord",
                peer: { id: "c1", kind: "channel" },
              },
            },
            {
              agentId: "guild",
              match: {
                accountId: "default",
                channel: "discord",
                guildId: "g1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "g1",
        peer: { id: "c1", kind: "channel" as const },
      },
    },
    {
      expected: {
        agentId: "guild",
        matchedBy: "binding.guild",
      },
      name: "guild binding wins over account binding when peer is not bound",
      routeParams: {
        accountId: "default",
        cfg: {
          bindings: [
            {
              agentId: "guild",
              match: {
                accountId: "default",
                channel: "discord",
                guildId: "g1",
              },
            },
            {
              agentId: "acct",
              match: { accountId: "default", channel: "discord" },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "g1",
        peer: { id: "c1", kind: "channel" as const },
      },
    },
  ] as const)("$name", ({ routeParams, expected }) => {
    expectRouteResolutionCase({ expected, routeParams });
  });

  test("coerces numeric peer ids to stable session keys", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      accountId: "default",
      cfg,
      channel: "discord",
      peer: { id: 1_468_834_856_187_203_680n as unknown as string, kind: "channel" },
    });
    expect(route.sessionKey).toBe("agent:main:discord:channel:1468834856187203680");
  });

  test.each([
    {
      expected: {
        agentId: "main",
        matchedBy: "binding.guild",
      },
      name: "peer+guild binding does not act as guild-wide fallback when peer mismatches (#14752)",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "olga",
              match: {
                channel: "discord",
                guildId: "GUILD_1",
                peer: { id: "CHANNEL_A", kind: "channel" },
              },
            },
            {
              agentId: "main",
              match: {
                channel: "discord",
                guildId: "GUILD_1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "GUILD_1",
        peer: { id: "CHANNEL_B", kind: "channel" as const },
      },
    },
    {
      expected: {
        agentId: "rightguild",
        matchedBy: "binding.guild",
      },
      name: "peer+guild binding requires guild match even when peer matches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "wrongguild",
              match: {
                channel: "discord",
                guildId: "g1",
                peer: { id: "c1", kind: "channel" },
              },
            },
            {
              agentId: "rightguild",
              match: {
                channel: "discord",
                guildId: "g2",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "discord" as const,
        guildId: "g2",
        peer: { id: "c1", kind: "channel" as const },
      },
    },
    {
      expected: {
        agentId: "teamwide",
        matchedBy: "binding.team",
      },
      name: "peer+team binding does not act as team-wide fallback when peer mismatches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "roomonly",
              match: {
                channel: "slack",
                peer: { id: "C_A", kind: "channel" },
                teamId: "T1",
              },
            },
            {
              agentId: "teamwide",
              match: {
                channel: "slack",
                teamId: "T1",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "slack" as const,
        peer: { id: "C_B", kind: "channel" as const },
        teamId: "T1",
      },
    },
    {
      expected: {
        agentId: "rightteam",
        matchedBy: "binding.team",
      },
      name: "peer+team binding requires team match even when peer matches",
      routeParams: {
        cfg: {
          bindings: [
            {
              agentId: "wrongteam",
              match: {
                channel: "slack",
                peer: { id: "C1", kind: "channel" },
                teamId: "T1",
              },
            },
            {
              agentId: "rightteam",
              match: {
                channel: "slack",
                teamId: "T2",
              },
            },
          ],
        } satisfies OpenClawConfig,
        channel: "slack" as const,
        peer: { id: "C1", kind: "channel" as const },
        teamId: "T2",
      },
    },
  ] as const)("$name", ({ routeParams, expected }) => {
    expectRouteResolutionCase({ expected, routeParams });
  });

  test("missing accountId in binding matches default account only", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "defaultAcct", match: { channel: "whatsapp" } }],
    };

    expectResolvedRoute(
      resolveRoute({
        accountId: undefined,
        cfg,
        channel: "whatsapp",
        peer: { id: "+1000", kind: "direct" },
      }),
      {
        agentId: "defaultacct",
        matchedBy: "binding.account",
      },
    );

    expectResolvedRoute(
      resolveRoute({
        accountId: "biz",
        cfg,
        channel: "whatsapp",
        peer: { id: "+1000", kind: "direct" },
      }),
      {
        agentId: "main",
        matchedBy: "default",
      },
    );
  });

  test.each([
    {
      accountId: "biz",
      cfg: {
        bindings: [
          {
            agentId: "any",
            match: { accountId: "*", channel: "whatsapp" },
          },
        ],
      } satisfies OpenClawConfig,
      channel: "whatsapp" as const,
      expected: {
        agentId: "any",
        matchedBy: "binding.channel",
      },
      name: "accountId=* matches any account as a channel fallback",
      peer: { id: "+1000", kind: "direct" as const },
    },
    {
      accountId: " biz ",
      cfg: {
        bindings: [{ agentId: "biz", match: { accountId: "BIZ", channel: "discord" } }],
      } satisfies OpenClawConfig,
      channel: "discord" as const,
      expected: {
        accountId: "biz",
        agentId: "biz",
        matchedBy: "binding.account",
      },
      name: "binding accountId matching is canonicalized",
      peer: { id: "u-1", kind: "direct" as const },
    },
    {
      accountId: "biz",
      cfg: {
        agents: {
          list: [{ default: true, id: "home", workspace: "~/openclaw-home" }],
        },
      } satisfies OpenClawConfig,
      channel: "whatsapp" as const,
      expected: {
        agentId: "home",
        matchedBy: "default",
        sessionKey: "agent:home:main",
      },
      name: "defaultAgentId is used when no binding matches",
      peer: { id: "+1000", kind: "direct" as const },
    },
  ] as const)("$name", ({ cfg, channel, accountId, peer, expected }) => {
    expectResolvedRoute(
      resolveRoute({
        accountId,
        cfg,
        channel,
        peer,
      }),
      expected,
    );
  });
});

test.each([
  {
    accountId: "tasks",
    expected: "agent:main:telegram:tasks:direct:7550356539",
    name: "isolates DM sessions per account, channel and sender",
  },
  {
    accountId: null,
    expected: "agent:main:telegram:default:direct:7550356539",
    name: "uses default accountId when not provided",
  },
] as const)("dmScope=per-account-channel-peer $name", ({ accountId, expected }) => {
  const route = resolveAgentRoute({
    accountId,
    cfg: {
      session: { dmScope: "per-account-channel-peer" },
    },
    channel: "telegram",
    peer: { id: "7550356539", kind: "direct" },
  });
  expect(route.sessionKey).toBe(expected);
});

describe("parentPeer binding inheritance (thread support)", () => {
  const threadPeer = { id: "thread-456", kind: "channel" as const };
  const defaultParentPeer = { id: "parent-channel-123", kind: "channel" as const };

  function makeDiscordPeerBinding(agentId: string, peerId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        peer: { id: peerId, kind: "channel" as const },
      },
    };
  }

  function makeDiscordGuildBinding(agentId: string, guildId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        guildId,
      },
    };
  }

  function resolveDiscordThreadRoute(params: {
    cfg: OpenClawConfig;
    parentPeer?: { kind: "channel"; id: string } | null;
    guildId?: string;
  }) {
    const parentPeer = "parentPeer" in params ? params.parentPeer : defaultParentPeer;
    return resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      guildId: params.guildId,
      parentPeer,
      peer: threadPeer,
    });
  }

  function expectDiscordThreadRoute(params: {
    cfg: OpenClawConfig;
    parentPeer?: { kind: "channel"; id: string } | null;
    guildId?: string;
    expectedAgentId: string;
    expectedMatchedBy: string;
  }) {
    const route = resolveDiscordThreadRoute(params);
    expectResolvedRoute(route, {
      agentId: params.expectedAgentId,
      matchedBy: params.expectedMatchedBy,
    });
  }

  test("thread inherits binding from parent channel when no direct match", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [makeDiscordPeerBinding("adecco", defaultParentPeer.id)],
      },
      expectedAgentId: "adecco",
      expectedMatchedBy: "binding.peer.parent",
    });
  });

  test("direct peer binding wins over parent peer binding", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [
          makeDiscordPeerBinding("thread-agent", threadPeer.id),
          makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
        ],
      },
      expectedAgentId: "thread-agent",
      expectedMatchedBy: "binding.peer",
    });
  });

  test("parent peer binding wins over guild binding", () => {
    expectDiscordThreadRoute({
      cfg: {
        bindings: [
          makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
          makeDiscordGuildBinding("guild-agent", "guild-789"),
        ],
      },
      expectedAgentId: "parent-agent",
      expectedMatchedBy: "binding.peer.parent",
      guildId: "guild-789",
    });
  });

  test.each([
    {
      cfg: {
        bindings: [
          makeDiscordPeerBinding("other-parent-agent", "other-parent-999"),
          makeDiscordGuildBinding("guild-agent", "guild-789"),
        ],
      } satisfies OpenClawConfig,
      expectedAgentId: "guild-agent",
      expectedMatchedBy: "binding.guild",
      guildId: "guild-789",
      name: "falls back to guild binding when no parent peer match",
    },
    {
      cfg: {
        bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
      } satisfies OpenClawConfig,
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      name: "parentPeer with empty id is ignored",
      parentPeer: { id: "", kind: "channel" as const },
    },
    {
      cfg: {
        bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
      } satisfies OpenClawConfig,
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      name: "null parentPeer is handled gracefully",
      parentPeer: null,
    },
  ])("$name", (testCase) => {
    expectDiscordThreadRoute(testCase);
  });
});

describe("backward compatibility: peer.kind dm → direct", () => {
  test.each([
    {
      bindingPeerKind: "dm" as const satisfies CompatRoutePeerKind,
      name: "legacy dm in config matches runtime direct peer",
      runtimePeerKind: "direct" as const satisfies CompatRoutePeerKind,
    },
    {
      bindingPeerKind: "direct" as const satisfies CompatRoutePeerKind,
      name: "runtime dm peer.kind matches config direct binding (#22730)",
      runtimePeerKind: "dm" as const satisfies CompatRoutePeerKind,
    },
  ])("$name", ({ bindingPeerKind, runtimePeerKind }) => {
    const route = resolveAgentRoute({
      accountId: null,
      cfg: {
        bindings: [
          {
            agentId: "alex",
            match: {
              channel: "whatsapp",
              peer: createCompatPeer(bindingPeerKind, "+15551234567"),
            },
          },
        ],
      },
      channel: "whatsapp",
      peer: createCompatPeer(runtimePeerKind, "+15551234567"),
    });
    expectResolvedRoute(route, {
      agentId: "alex",
      matchedBy: "binding.peer",
    });
  });
});

describe("backward compatibility: peer.kind group ↔ channel", () => {
  test.each([
    {
      agentId: "slack-group-agent",
      bindingPeerKind: "group" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "slack-group-agent",
      expectedMatchedBy: "binding.peer",
      name: "config group binding matches runtime channel scope",
      runtimePeerKind: "channel" as const satisfies CompatRoutePeerKind,
    },
    {
      agentId: "slack-channel-agent",
      bindingPeerKind: "channel" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "slack-channel-agent",
      expectedMatchedBy: "binding.peer",
      name: "config channel binding matches runtime group scope",
      runtimePeerKind: "group" as const satisfies CompatRoutePeerKind,
    },
    {
      agentId: "group-only-agent",
      bindingPeerKind: "group" as const satisfies CompatRoutePeerKind,
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      name: "group/channel compatibility does not match direct peer kind",
      runtimePeerKind: "direct" as const satisfies CompatRoutePeerKind,
    },
  ])(
    "$name",
    ({ agentId, bindingPeerKind, runtimePeerKind, expectedAgentId, expectedMatchedBy }) => {
      const route = resolveAgentRoute({
        accountId: null,
        cfg: {
          bindings: [
            {
              agentId,
              match: {
                channel: "slack",
                peer: createCompatPeer(bindingPeerKind, "C123456"),
              },
            },
          ],
        },
        channel: "slack",
        peer: createCompatPeer(runtimePeerKind, "C123456"),
      });
      expectResolvedRoute(route, {
        agentId: expectedAgentId,
        matchedBy: expectedMatchedBy,
      });
    },
  );
});

describe("role-based agent routing", () => {
  type DiscordBinding = NonNullable<OpenClawConfig["bindings"]>[number];

  function makeDiscordRoleBinding(
    agentId: string,
    params: {
      roles?: readonly string[];
      peerId?: string;
      includeGuildId?: boolean;
    } = {},
  ): DiscordBinding {
    return {
      agentId,
      match: {
        channel: "discord",
        ...(params.includeGuildId === false ? {} : { guildId: "g1" }),
        ...(params.roles !== undefined ? { roles: [...params.roles] } : {}),
        ...(params.peerId ? { peer: { id: params.peerId, kind: "channel" } } : {}),
      },
    };
  }

  function expectDiscordRoleRoute(params: {
    bindings: readonly DiscordBinding[];
    memberRoleIds?: readonly string[];
    peerId?: string;
    parentPeerId?: string;
    expectedAgentId: string;
    expectedMatchedBy: string;
  }) {
    const route = resolveRoute({
      cfg: { bindings: [...params.bindings] },
      channel: "discord",
      guildId: "g1",
      ...(params.memberRoleIds ? { memberRoleIds: [...params.memberRoleIds] } : {}),
      peer: { id: params.peerId ?? "c1", kind: "channel" },
      ...(params.parentPeerId
        ? {
            parentPeer: { id: params.parentPeerId, kind: "channel" },
          }
        : {}),
    });
    expect(route.agentId).toBe(params.expectedAgentId);
    expect(route.matchedBy).toBe(params.expectedMatchedBy);
  }

  test.each([
    {
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
      memberRoleIds: ["r1"],
      name: "guild+roles binding matches when member has matching role",
    },
    {
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      memberRoleIds: ["r2"],
      name: "guild+roles binding skipped when no matching role",
    },
    {
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet"),
      ],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
      memberRoleIds: ["r1"],
      name: "guild+roles is more specific than guild-only",
    },
    {
      bindings: [
        makeDiscordRoleBinding("peer-agent", { includeGuildId: false, peerId: "c1" }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      expectedAgentId: "peer-agent",
      expectedMatchedBy: "binding.peer",
      memberRoleIds: ["r1"],
      name: "peer binding still beats guild+roles",
    },
    {
      bindings: [
        makeDiscordRoleBinding("parent-agent", {
          includeGuildId: false,
          peerId: "parent-1",
        }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      expectedAgentId: "parent-agent",
      expectedMatchedBy: "binding.peer.parent",
      memberRoleIds: ["r1"],
      name: "parent peer binding still beats guild+roles",
      parentPeerId: "parent-1",
      peerId: "thread-1",
    },
    {
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      name: "no memberRoleIds means guild+roles doesn't match",
    },
    {
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet", { roles: ["r2"] }),
      ],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
      memberRoleIds: ["r1", "r2"],
      name: "first matching binding wins with multiple role bindings",
    },
    {
      bindings: [makeDiscordRoleBinding("opus", { roles: [] })],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild",
      memberRoleIds: ["r1"],
      name: "empty roles array treated as no role restriction",
    },
    {
      bindings: [makeDiscordRoleBinding("opus", { roles: ["admin"] })],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
      memberRoleIds: ["regular"],
      name: "guild+roles binding does not match as guild-only when roles do not match",
    },
    {
      bindings: [
        makeDiscordRoleBinding("peer-roles", { peerId: "c-target", roles: ["r1"] }),
        makeDiscordRoleBinding("guild-roles", { roles: ["r1"] }),
      ],
      expectedAgentId: "guild-roles",
      expectedMatchedBy: "binding.guild+roles",
      memberRoleIds: ["r1"],
      name: "peer+guild+roles binding does not act as guild+roles fallback when peer mismatches",
      peerId: "c-other",
    },
  ] as const)("$name", (testCase) => {
    expectDiscordRoleRoute(testCase);
  });
});

describe("wildcard peer bindings (peer.id=*)", () => {
  test("peer.id=* matches any direct peer and routes to the bound agent", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "second-ana" }] },
      bindings: [
        {
          agentId: "second-ana",
          match: {
            accountId: "second-ana",
            channel: "telegram",
            peer: { id: "*", kind: "direct" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      accountId: "second-ana",
      cfg,
      channel: "telegram",
      peer: { id: "12345678", kind: "direct" },
    });
    expect(route.agentId).toBe("second-ana");
    expect(route.sessionKey).toContain("agent:second-ana:");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });

  test("peer.id=* does not match group peers when kind is direct", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ default: true, id: "main" }, { id: "dm-only" }] },
      bindings: [
        {
          agentId: "dm-only",
          match: {
            accountId: "bot1",
            channel: "telegram",
            peer: { id: "*", kind: "direct" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      accountId: "bot1",
      cfg,
      channel: "telegram",
      peer: { id: "group-999", kind: "group" },
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });

  test("exact peer binding wins over wildcard peer binding", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "exact" }, { id: "wild" }] },
      bindings: [
        {
          agentId: "wild",
          match: {
            accountId: "biz",
            channel: "whatsapp",
            peer: { id: "*", kind: "direct" },
          },
        },
        {
          agentId: "exact",
          match: {
            accountId: "biz",
            channel: "whatsapp",
            peer: { id: "+1000", kind: "direct" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      accountId: "biz",
      cfg,
      channel: "whatsapp",
      peer: { id: "+1000", kind: "direct" },
    });
    expect(route.agentId).toBe("exact");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("wildcard peer binding wins over default fallback for unmatched peers", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "exact" }, { id: "wild" }] },
      bindings: [
        {
          agentId: "wild",
          match: {
            accountId: "biz",
            channel: "whatsapp",
            peer: { id: "*", kind: "direct" },
          },
        },
        {
          agentId: "exact",
          match: {
            accountId: "biz",
            channel: "whatsapp",
            peer: { id: "+1000", kind: "direct" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      accountId: "biz",
      cfg,
      channel: "whatsapp",
      peer: { id: "+9999", kind: "direct" },
    });
    expect(route.agentId).toBe("wild");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });

  test("group wildcard peer matches any group peer", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "grp" }] },
      bindings: [
        {
          agentId: "grp",
          match: {
            accountId: "default",
            channel: "discord",
            peer: { id: "*", kind: "group" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      accountId: "default",
      cfg,
      channel: "discord",
      peer: { id: "g-42", kind: "group" },
    });
    expect(route.agentId).toBe("grp");
    expect(route.matchedBy).toBe("binding.peer.wildcard");
  });
});

describe("binding evaluation cache scalability", () => {
  test("does not rescan full bindings after channel/account cache rollover (#36915)", () => {
    const bindingCount = 2205;
    const cfg: OpenClawConfig = {
      bindings: Array.from({ length: bindingCount }, (_, idx) => ({
        agentId: `agent-${idx}`,
        match: {
          accountId: `acct-${idx}`,
          channel: "dingtalk",
          peer: { id: `user-${idx}`, kind: "direct" },
        },
      })),
    };
    const listBindingsSpy = vi.spyOn(routingBindings, "listBindings");
    try {
      for (let idx = 0; idx < bindingCount; idx += 1) {
        const route = resolveAgentRoute({
          accountId: `acct-${idx}`,
          cfg,
          channel: "dingtalk",
          peer: { id: `user-${idx}`, kind: "direct" },
        });
        expect(route.agentId).toBe(`agent-${idx}`);
        expect(route.matchedBy).toBe("binding.peer");
      }

      const repeated = resolveAgentRoute({
        accountId: "acct-0",
        cfg,
        channel: "dingtalk",
        peer: { id: "user-0", kind: "direct" },
      });
      expect(repeated.agentId).toBe("agent-0");
      expect(listBindingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listBindingsSpy.mockRestore();
    }
  });
});
