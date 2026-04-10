import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { setMinimalOutboundSessionPluginRegistryForTests } from "./outbound-session.test-helpers.js";

const mocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
  resolveStorePath: vi.fn(
    (_store: unknown, params?: { agentId?: string }) => `/stores/${params?.agentId ?? "main"}.json`,
  ),
}));

vi.mock("../../config/sessions/inbound.runtime.js", () => ({
  recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  resolveStorePath: mocks.resolveStorePath,
}));

describe("resolveOutboundSessionRoute", () => {
  beforeEach(() => {
    mocks.recordSessionMetaFromInbound.mockClear();
    mocks.resolveStorePath.mockClear();
    setMinimalOutboundSessionPluginRegistryForTests();
  });

  const baseConfig = {} as OpenClawConfig;
  const perChannelPeerCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
  const identityLinksCfg = {
    session: {
      dmScope: "per-peer",
      identityLinks: {
        alice: ["discord:123"],
      },
    },
  } as OpenClawConfig;
  const slackMpimCfg = {
    channels: {
      slack: {
        dm: {
          groupChannels: ["G123"],
        },
      },
    },
  } as OpenClawConfig;

  async function expectResolvedRoute(params: {
    cfg: OpenClawConfig;
    channel: string;
    target: string;
    replyToId?: string;
    threadId?: string;
    expected: {
      sessionKey: string;
      from?: string;
      to?: string;
      threadId?: string | number;
      chatType?: "channel" | "direct" | "group";
    };
  }) {
    const route = await resolveOutboundSessionRoute({
      agentId: "main",
      cfg: params.cfg,
      channel: params.channel,
      replyToId: params.replyToId,
      target: params.target,
      threadId: params.threadId,
    });
    expect(route?.sessionKey).toBe(params.expected.sessionKey);
    if (params.expected.from !== undefined) {
      expect(route?.from).toBe(params.expected.from);
    }
    if (params.expected.to !== undefined) {
      expect(route?.to).toBe(params.expected.to);
    }
    if (params.expected.threadId !== undefined) {
      expect(route?.threadId).toBe(params.expected.threadId);
    }
    if (params.expected.chatType !== undefined) {
      expect(route?.chatType).toBe(params.expected.chatType);
    }
  }

  type RouteCase = Parameters<typeof expectResolvedRoute>[0];
  type NamedRouteCase = RouteCase & { name: string };

  const perChannelPeerSessionCfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;

  it.each([
    {
      cfg: baseConfig,
      channel: "whatsapp",
      expected: {
        chatType: "group",
        from: "120363040000000000@g.us",
        sessionKey: "agent:main:whatsapp:group:120363040000000000@g.us",
        to: "120363040000000000@g.us",
      },
      name: "WhatsApp group jid",
      target: "120363040000000000@g.us",
    },
    {
      cfg: baseConfig,
      channel: "matrix",
      expected: {
        chatType: "channel",
        from: "matrix:channel:!ops:matrix.example",
        sessionKey: "agent:main:matrix:channel:!ops:matrix.example",
        to: "room:!ops:matrix.example",
      },
      name: "Matrix room target",
      target: "room:!ops:matrix.example",
    },
    {
      cfg: baseConfig,
      channel: "msteams",
      expected: {
        chatType: "channel",
        from: "msteams:channel:19:meeting_abc@thread.tacv2",
        sessionKey: "agent:main:msteams:channel:19:meeting_abc@thread.tacv2",
        to: "conversation:19:meeting_abc@thread.tacv2",
      },
      name: "MSTeams conversation target",
      target: "conversation:19:meeting_abc@thread.tacv2",
    },
    {
      cfg: baseConfig,
      channel: "slack",
      expected: {
        from: "slack:channel:C123",
        sessionKey: "agent:main:slack:channel:c123:thread:456",
        threadId: "456",
        to: "channel:C123",
      },
      name: "Slack thread",
      replyToId: "456",
      target: "channel:C123",
    },
    {
      cfg: baseConfig,
      channel: "telegram",
      expected: {
        from: "telegram:group:-100123456:topic:42",
        sessionKey: "agent:main:telegram:group:-100123456:topic:42",
        threadId: 42,
        to: "telegram:-100123456",
      },
      name: "Telegram topic group",
      target: "-100123456:topic:42",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "telegram",
      expected: {
        chatType: "direct",
        from: "telegram:123456789:topic:99",
        sessionKey: "agent:main:telegram:direct:123456789:thread:99",
        threadId: 99,
        to: "telegram:123456789",
      },
      name: "Telegram DM with topic",
      target: "123456789:topic:99",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "telegram",
      expected: {
        chatType: "direct",
        sessionKey: "agent:main:telegram:direct:@alice",
      },
      name: "Telegram unresolved username DM",
      target: "@alice",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "telegram",
      expected: {
        chatType: "direct",
        from: "telegram:12345:topic:99",
        sessionKey: "agent:main:telegram:direct:12345:thread:99",
        threadId: 99,
        to: "telegram:12345",
      },
      name: "Telegram DM scoped threadId fallback",
      target: "12345",
      threadId: "12345:99",
    },
    {
      cfg: identityLinksCfg,
      channel: "discord",
      expected: {
        sessionKey: "agent:main:direct:alice",
      },
      name: "identity-links per-peer",
      target: "user:123",
    },
    {
      cfg: baseConfig,
      channel: "nextcloud-talk",
      expected: {
        chatType: "group",
        from: "nextcloud-talk:room:opsroom42",
        sessionKey: "agent:main:nextcloud-talk:group:opsroom42",
        to: "nextcloud-talk:opsroom42",
      },
      name: "Nextcloud Talk room target",
      target: "room:opsroom42",
    },
    {
      cfg: baseConfig,
      channel: "bluebubbles",
      expected: {
        from: "group:ABC123",
        sessionKey: "agent:main:bluebubbles:group:abc123",
      },
      name: "BlueBubbles chat_* prefix stripping",
      target: "chat_guid:ABC123",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "zalo",
      expected: {
        chatType: "direct",
        from: "zalo:123456",
        sessionKey: "agent:main:zalo:direct:123456",
        to: "zalo:123456",
      },
      name: "Zalo direct target",
      target: "zl:123456",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "zalouser",
      expected: {
        chatType: "direct",
        sessionKey: "agent:main:zalouser:direct:123456",
      },
      name: "Zalo Personal DM target",
      target: "123456",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "nostr",
      expected: {
        chatType: "direct",
        from: "nostr:npub1example",
        sessionKey: "agent:main:nostr:direct:npub1example",
        to: "nostr:npub1example",
      },
      name: "Nostr prefixed target",
      target: "nostr:npub1example",
    },
    {
      cfg: baseConfig,
      channel: "tlon",
      expected: {
        chatType: "group",
        from: "tlon:group:chat/~zod/main",
        sessionKey: "agent:main:tlon:group:chat/~zod/main",
        to: "tlon:chat/~zod/main",
      },
      name: "Tlon group target",
      target: "group:~zod/main",
    },
    {
      cfg: slackMpimCfg,
      channel: "slack",
      expected: {
        from: "slack:group:G123",
        sessionKey: "agent:main:slack:group:g123",
      },
      name: "Slack mpim allowlist -> group key",
      target: "channel:G123",
    },
    {
      cfg: baseConfig,
      channel: "feishu",
      expected: {
        chatType: "group",
        from: "feishu:group:oc_group_chat",
        sessionKey: "agent:main:feishu:group:oc_group_chat",
        to: "oc_group_chat",
      },
      name: "Feishu explicit group prefix keeps group routing",
      target: "group:oc_group_chat",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "feishu",
      expected: {
        chatType: "direct",
        from: "feishu:oc_dm_chat",
        sessionKey: "agent:main:feishu:direct:oc_dm_chat",
        to: "oc_dm_chat",
      },
      name: "Feishu explicit dm prefix keeps direct routing",
      target: "dm:oc_dm_chat",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "feishu",
      expected: {
        chatType: "direct",
        from: "feishu:oc_ambiguous_chat",
        sessionKey: "agent:main:feishu:direct:oc_ambiguous_chat",
        to: "oc_ambiguous_chat",
      },
      name: "Feishu bare oc_ target defaults to direct routing",
      target: "oc_ambiguous_chat",
    },
    {
      cfg: perChannelPeerCfg,
      channel: "slack",
      expected: {
        chatType: "direct",
        from: "slack:U12345ABC",
        sessionKey: "agent:main:slack:direct:u12345abc",
        to: "user:U12345ABC",
      },
      name: "Slack user DM target",
      target: "user:U12345ABC",
    },
    {
      cfg: baseConfig,
      channel: "slack",
      expected: {
        chatType: "channel",
        from: "slack:channel:C999XYZ",
        sessionKey: "agent:main:slack:channel:c999xyz",
        to: "channel:C999XYZ",
      },
      name: "Slack channel target without thread",
      target: "channel:C999XYZ",
    },
  ] satisfies NamedRouteCase[])("$name", async ({ name: _name, ...params }) => {
    await expectResolvedRoute(params);
  });

  it.each([
    {
      expected: {
        chatType: "direct",
        from: "discord:123",
        sessionKey: "agent:main:discord:direct:123",
        to: "user:123",
      },
      name: "uses resolved Discord user targets to route bare numeric ids as DMs",
      resolvedTarget: {
        kind: "user" as const,
        source: "directory" as const,
        to: "user:123",
      },
      target: "123",
    },
    {
      expected: {
        baseSessionKey: "agent:main:discord:channel:456",
        chatType: "channel",
        from: "discord:channel:456",
        sessionKey: "agent:main:discord:channel:456",
        threadId: "789",
        to: "channel:456",
      },
      name: "uses resolved Discord channel targets to route bare numeric ids as channels without thread suffixes",
      resolvedTarget: {
        kind: "channel" as const,
        source: "directory" as const,
        to: "channel:456",
      },
      target: "456",
      threadId: "789",
    },
    {
      channel: "mattermost",
      expected: {
        chatType: "direct",
        from: "mattermost:dthcxgoxhifn3pwh65cut3ud3w",
        sessionKey: "agent:main:mattermost:direct:dthcxgoxhifn3pwh65cut3ud3w",
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
      },
      name: "uses resolved Mattermost user targets to route bare ids as DMs",
      resolvedTarget: {
        kind: "user" as const,
        source: "directory" as const,
        to: "user:dthcxgoxhifn3pwh65cut3ud3w",
      },
      target: "dthcxgoxhifn3pwh65cut3ud3w",
    },
  ])("$name", async ({ channel = "discord", target, threadId, resolvedTarget, expected }) => {
    const route = await resolveOutboundSessionRoute({
      agentId: "main",
      cfg: perChannelPeerSessionCfg,
      channel,
      resolvedTarget,
      target,
      threadId,
    });

    expect(route).toMatchObject(expected);
  });

  it("rejects bare numeric Discord targets when the caller has no kind hint", async () => {
    await expect(
      resolveOutboundSessionRoute({
        agentId: "main",
        cfg: perChannelPeerSessionCfg,
        channel: "discord",
        target: "123",
      }),
    ).rejects.toThrow(/Ambiguous Discord recipient/);
  });
});

describe("ensureOutboundSessionEntry", () => {
  beforeEach(() => {
    mocks.recordSessionMetaFromInbound.mockClear();
    mocks.resolveStorePath.mockClear();
  });

  it("persists metadata in the owning session store for the route session key", async () => {
    await ensureOutboundSessionEntry({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } as OpenClawConfig,
      channel: "slack",
      route: {
        baseSessionKey: "agent:work:slack:channel:resolved",
        chatType: "channel",
        from: "slack:channel:C1",
        peer: { id: "c1", kind: "channel" },
        sessionKey: "agent:main:slack:channel:c1",
        to: "channel:C1",
      },
    });

    expect(mocks.resolveStorePath).toHaveBeenCalledWith("/stores/{agentId}.json", {
      agentId: "main",
    });
    expect(mocks.recordSessionMetaFromInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:c1",
        storePath: "/stores/main.json",
      }),
    );
  });
});
