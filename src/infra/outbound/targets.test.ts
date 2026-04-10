import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "./targets.js";
import type { SessionDeliveryTarget } from "./targets.js";
import {
  installResolveOutboundTargetPluginRegistryHooks,
  runResolveOutboundTargetCoreTests,
} from "./targets.shared-test.js";
import {
  createNoopOutboundChannelPlugin,
  createTargetsTestRegistry,
  createTelegramTestPlugin,
  createWhatsAppTestPlugin,
} from "./targets.test-helpers.js";

const mocks = vi.hoisted(() => ({
  normalizeDeliverableOutboundChannel: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: mocks.normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

runResolveOutboundTargetCoreTests();

beforeEach(() => {
  mocks.normalizeDeliverableOutboundChannel.mockReset();
  mocks.normalizeDeliverableOutboundChannel.mockImplementation((value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return ["discord", "imessage", "slack", "telegram", "whatsapp"].includes(String(normalized))
      ? normalized
      : undefined;
  });
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  setActivePluginRegistry(
    createTargetsTestRegistry([
      createNoopOutboundChannelPlugin("discord"),
      createNoopOutboundChannelPlugin("imessage"),
      createNoopOutboundChannelPlugin("slack"),
      createTelegramTestPlugin(),
      createWhatsAppTestPlugin(),
    ]),
  );
});

describe("resolveOutboundTarget defaultTo config fallback", () => {
  installResolveOutboundTargetPluginRegistryHooks();
  const whatsappDefaultCfg: OpenClawConfig = {
    channels: { whatsapp: { allowFrom: ["*"], defaultTo: "+15551234567" } },
  };

  it("uses whatsapp defaultTo when no explicit target is provided", () => {
    const res = resolveOutboundTarget({
      cfg: whatsappDefaultCfg,
      channel: "whatsapp",
      mode: "implicit",
      to: undefined,
    });
    expect(res).toEqual({ ok: true, to: "+15551234567" });
  });

  it("uses telegram defaultTo when no explicit target is provided", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { defaultTo: "123456789" } },
    };
    const res = resolveOutboundTarget({
      cfg,
      channel: "telegram",
      mode: "implicit",
      to: "",
    });
    expect(res).toEqual({ ok: true, to: "123456789" });
  });

  it("explicit --reply-to overrides defaultTo", () => {
    const res = resolveOutboundTarget({
      cfg: whatsappDefaultCfg,
      channel: "whatsapp",
      mode: "explicit",
      to: "+15559999999",
    });
    expect(res).toEqual({ ok: true, to: "+15559999999" });
  });

  it("still errors when no defaultTo and no explicit target", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["+1555"] } },
    };
    const res = resolveOutboundTarget({
      cfg,
      channel: "whatsapp",
      mode: "implicit",
      to: "",
    });
    expect(res.ok).toBe(false);
  });

  it("falls back to the active registry when the cached channel map is stale", () => {
    const registry = createTargetsTestRegistry([]);
    setActivePluginRegistry(registry, "stale-registry-test");

    // Warm the cached channel map before mutating the registry in place.
    expect(resolveOutboundTarget({ channel: "telegram", mode: "explicit", to: "123" }).ok).toBe(
      false,
    );

    registry.channels.push({
      plugin: createTelegramTestPlugin(),
      pluginId: "telegram",
      source: "test",
    });

    expect(resolveOutboundTarget({ channel: "telegram", mode: "explicit", to: "123" })).toEqual({
      ok: true,
      to: "123",
    });
  });
});

describe("resolveSessionDeliveryTarget", () => {
  const expectImplicitRoute = (
    resolved: SessionDeliveryTarget,
    params: {
      channel?: SessionDeliveryTarget["channel"];
      to?: string;
      lastChannel?: SessionDeliveryTarget["lastChannel"];
      lastTo?: string;
    },
  ) => {
    expect(resolved).toEqual({
      accountId: undefined,
      channel: params.channel,
      lastAccountId: undefined,
      lastChannel: params.lastChannel,
      lastThreadId: undefined,
      lastTo: params.lastTo,
      mode: "implicit",
      threadId: undefined,
      threadIdExplicit: false,
      to: params.to,
    });
  };

  const expectTopicParsedFromExplicitTo = (
    entry: Parameters<typeof resolveSessionDeliveryTarget>[0]["entry"],
  ) => {
    const resolved = resolveSessionDeliveryTarget({
      entry,
      explicitTo: "63448508:topic:1008013",
      requestedChannel: "last",
    });
    expect(resolved.to).toBe("63448508");
    expect(resolved.threadId).toBe(1_008_013);
  };

  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastAccountId: " acct-1 ",
        lastChannel: " whatsapp ",
        lastTo: " +1555 ",
        sessionId: "sess-1",
        updatedAt: 1,
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      accountId: "acct-1",
      channel: "whatsapp",
      lastAccountId: "acct-1",
      lastChannel: "whatsapp",
      lastThreadId: undefined,
      lastTo: "+1555",
      mode: "implicit",
      threadId: undefined,
      threadIdExplicit: false,
      to: "+1555",
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "whatsapp",
        lastTo: "+1555",
        sessionId: "sess-2",
        updatedAt: 1,
      },
      requestedChannel: "telegram",
    });

    expectImplicitRoute(resolved, {
      channel: "telegram",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      to: undefined,
    });
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      allowMismatchedLastTo: true,
      entry: {
        lastChannel: "whatsapp",
        lastTo: "+1555",
        sessionId: "sess-3",
        updatedAt: 1,
      },
      requestedChannel: "telegram",
    });

    expectImplicitRoute(resolved, {
      channel: "telegram",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      to: "+1555",
    });
  });

  it("passes through explicitThreadId when provided", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 999,
        lastTo: "-100123",
        sessionId: "sess-thread",
        updatedAt: 1,
      },
      explicitThreadId: 42,
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
  });

  it("uses session lastThreadId when no explicitThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 999,
        lastTo: "-100123",
        sessionId: "sess-thread-2",
        updatedAt: 1,
      },
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(999);
  });

  it("does not inherit lastThreadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "slack",
        lastThreadId: "1739142736.000100",
        lastTo: "user:U123",
        sessionId: "sess-heartbeat-thread",
        updatedAt: 1,
      },
      mode: "heartbeat",
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBeUndefined();
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "whatsapp",
        lastTo: "+1555",
        sessionId: "sess-4",
        updatedAt: 1,
      },
      fallbackChannel: "slack",
      requestedChannel: "webchat",
    });

    expectImplicitRoute(resolved, {
      channel: "slack",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      to: undefined,
    });
  });

  it("parses :topic:NNN from explicitTo into threadId", () => {
    expectTopicParsedFromExplicitTo({
      lastChannel: "telegram",
      lastTo: "63448508",
      sessionId: "sess-topic",
      updatedAt: 1,
    });
  });

  it("parses :topic:NNN even when lastTo is absent", () => {
    expectTopicParsedFromExplicitTo({
      lastChannel: "telegram",
      sessionId: "sess-no-last",
      updatedAt: 1,
    });
  });

  it("skips :topic: parsing for non-telegram channels", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "slack",
        lastTo: "C12345",
        sessionId: "sess-slack",
        updatedAt: 1,
      },
      explicitTo: "C12345:topic:999",
      requestedChannel: "last",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("skips :topic: parsing when channel is explicitly non-telegram even if lastChannel was telegram", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastTo: "63448508",
        sessionId: "sess-cross",
        updatedAt: 1,
      },
      explicitTo: "C12345:topic:999",
      requestedChannel: "slack",
    });

    expect(resolved.to).toBe("C12345:topic:999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("keeps raw :topic: targets when the telegram plugin registry is unavailable", () => {
    setActivePluginRegistry(createTargetsTestRegistry([]));

    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastTo: "63448508",
        sessionId: "sess-no-registry",
        updatedAt: 1,
      },
      explicitTo: "63448508:topic:1008013",
      requestedChannel: "last",
    });

    expect(resolved.to).toBe("63448508:topic:1008013");
    expect(resolved.threadId).toBeUndefined();
  });

  it("explicitThreadId takes priority over :topic: parsed value", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastTo: "63448508",
        sessionId: "sess-priority",
        updatedAt: 1,
      },
      explicitThreadId: 42,
      explicitTo: "63448508:topic:1008013",
      requestedChannel: "last",
    });

    expect(resolved.threadId).toBe(42);
    expect(resolved.to).toBe("63448508");
  });

  const resolveHeartbeatTarget = (entry: SessionEntry, directPolicy?: "allow" | "block") =>
    resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry,
      heartbeat: {
        target: "last",
        ...(directPolicy ? { directPolicy } : {}),
      },
    });

  const expectHeartbeatTarget = (params: {
    name: string;
    entry: SessionEntry;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
    expectedThreadId?: string | number;
  }) => {
    const resolved = resolveHeartbeatTarget(params.entry, params.directPolicy);
    expect(resolved.channel, params.name).toBe(params.expectedChannel);
    expect(resolved.to, params.name).toBe(params.expectedTo);
    expect(resolved.reason, params.name).toBe(params.expectedReason);
    expect(resolved.threadId, params.name).toBe(params.expectedThreadId);
  };

  it.each([
    {
      entry: {
        lastChannel: "slack",
        lastThreadId: "1739142736.000100",
        lastTo: "user:U123",
        sessionId: "sess-heartbeat-slack-direct",
        updatedAt: 1,
      },
      expectedChannel: "slack",
      expectedTo: "user:U123",
      name: "allows heartbeat delivery to Slack DMs by default and drops inherited thread ids",
    },
    {
      directPolicy: "block" as const,
      entry: {
        lastChannel: "slack",
        lastThreadId: "1739142736.000100",
        lastTo: "user:U123",
        sessionId: "sess-heartbeat-slack-direct-blocked",
        updatedAt: 1,
      },
      expectedChannel: "none",
      expectedReason: "dm-blocked",
      name: "blocks heartbeat delivery to Slack DMs when directPolicy is block",
    },
    {
      entry: {
        lastChannel: "telegram",
        lastTo: "5232990709",
        sessionId: "sess-heartbeat-telegram-direct",
        updatedAt: 1,
      },
      expectedChannel: "telegram",
      expectedTo: "5232990709",
      name: "allows heartbeat delivery to Telegram direct chats by default",
    },
    {
      directPolicy: "block" as const,
      entry: {
        lastChannel: "telegram",
        lastTo: "5232990709",
        sessionId: "sess-heartbeat-telegram-direct-blocked",
        updatedAt: 1,
      },
      expectedChannel: "none",
      expectedReason: "dm-blocked",
      name: "blocks heartbeat delivery to Telegram direct chats when directPolicy is block",
    },
    {
      entry: {
        lastChannel: "telegram",
        lastTo: "-1001234567890",
        sessionId: "sess-heartbeat-telegram-group",
        updatedAt: 1,
      },
      expectedChannel: "telegram",
      expectedTo: "-1001234567890",
      name: "keeps heartbeat delivery to Telegram groups",
    },
    {
      entry: {
        lastChannel: "whatsapp",
        lastTo: "+15551234567",
        sessionId: "sess-heartbeat-whatsapp-direct",
        updatedAt: 1,
      },
      expectedChannel: "whatsapp",
      expectedTo: "+15551234567",
      name: "allows heartbeat delivery to WhatsApp direct chats by default",
    },
    {
      entry: {
        lastChannel: "whatsapp",
        lastTo: "120363140186826074@g.us",
        sessionId: "sess-heartbeat-whatsapp-group",
        updatedAt: 1,
      },
      expectedChannel: "whatsapp",
      expectedTo: "120363140186826074@g.us",
      name: "keeps heartbeat delivery to WhatsApp groups",
    },
    {
      entry: {
        chatType: "direct",
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        sessionId: "sess-heartbeat-imessage-direct",
        updatedAt: 1,
      },
      expectedChannel: "imessage",
      expectedTo: "chat-guid-unknown-shape",
      name: "uses session chatType hints when target parsing cannot classify a direct chat",
    },
    {
      directPolicy: "block" as const,
      entry: {
        chatType: "direct",
        lastChannel: "imessage",
        lastTo: "chat-guid-unknown-shape",
        sessionId: "sess-heartbeat-imessage-direct-blocked",
        updatedAt: 1,
      },
      expectedChannel: "none",
      expectedReason: "dm-blocked",
      name: "blocks session chatType direct hints when directPolicy is block",
    },
  ] satisfies {
    name: string;
    entry: NonNullable<Parameters<typeof resolveHeartbeatDeliveryTarget>[0]["entry"]>;
    directPolicy?: "allow" | "block";
    expectedChannel: string;
    expectedTo?: string;
    expectedReason?: string;
  }[])("$name", ({ name, entry, directPolicy, expectedChannel, expectedTo, expectedReason }) => {
    expectHeartbeatTarget({
      directPolicy,
      entry,
      expectedChannel,
      expectedReason,
      expectedTo,
      name,
    });
  });

  it("allows heartbeat delivery to Discord DMs by default", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        lastChannel: "discord",
        lastTo: "user:12345",
        sessionId: "sess-heartbeat-discord-dm",
        updatedAt: 1,
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("user:12345");
  });

  it("keeps heartbeat delivery to Discord channels", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      entry: {
        lastChannel: "discord",
        lastTo: "channel:999",
        sessionId: "sess-heartbeat-discord-channel",
        updatedAt: 1,
      },
      heartbeat: {
        target: "last",
      },
    });

    expect(resolved.channel).toBe("discord");
    expect(resolved.to).toBe("channel:999");
  });

  it("keeps explicit threadId in heartbeat mode", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 999,
        lastTo: "-100123",
        sessionId: "sess-heartbeat-explicit-thread",
        updatedAt: 1,
      },
      explicitThreadId: 42,
      mode: "heartbeat",
      requestedChannel: "last",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
    expect(resolved.threadId).toBe(42);
    expect(resolved.threadIdExplicit).toBe(true);
  });

  it("parses explicit heartbeat topic targets into threadId", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg,
      heartbeat: {
        target: "telegram",
        to: "-10063448508:topic:1008013",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-10063448508");
    expect(resolved.threadId).toBe(1_008_013);
  });

  it("prefers turn-scoped routing over mutable session routing for target=last", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
        sessionId: "sess-heartbeat-turn-source",
        updatedAt: 1,
      },
      heartbeat: {
        target: "last",
      },
      turnSource: {
        channel: "telegram",
        threadId: 42,
        to: "-100123",
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
    expect(resolved.threadId).toBe(42);
  });

  it("merges partial turn-scoped metadata with the stored session route for target=last", () => {
    const resolved = resolveHeartbeatDeliveryTarget({
      cfg: {},
      entry: {
        lastChannel: "telegram",
        lastTo: "-100123",
        sessionId: "sess-heartbeat-turn-source-partial",
        updatedAt: 1,
      },
      heartbeat: {
        target: "last",
      },
      turnSource: {
        threadId: 42,
      },
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-100123");
    expect(resolved.threadId).toBe(42);
  });
});

describe("resolveSessionDeliveryTarget — cross-channel reply guard (#24152)", () => {
  it("uses turnSourceChannel over session lastChannel when provided", () => {
    // Simulate: WhatsApp message originated the turn, but a Slack message
    // Arrived concurrently and updated lastChannel to "slack"
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-shared",
        updatedAt: 1,
        lastChannel: "slack", // <- concurrently overwritten
        lastTo: "U0AEMECNCBV", // <- Slack user (wrong target)
      },
      requestedChannel: "last",
      turnSourceChannel: "whatsapp", // <- originated from WhatsApp
      turnSourceTo: "+66972796305", // <- WhatsApp user (correct target)
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+66972796305");
  });

  it("falls back to session lastChannel when turnSourceChannel is not set", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastTo: "8587265585",
        sessionId: "sess-normal",
        updatedAt: 1,
      },
      requestedChannel: "last",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("8587265585");
  });

  it("respects explicit requestedChannel over turnSourceChannel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "slack",
        lastTo: "U12345",
        sessionId: "sess-explicit",
        updatedAt: 1,
      },
      explicitTo: "8587265585",
      requestedChannel: "telegram",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+66972796305",
    });

    // Explicit requestedChannel "telegram" is not "last", so it takes priority
    expect(resolved.channel).toBe("telegram");
  });

  it("preserves turnSourceAccountId and turnSourceThreadId", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastAccountId: "wrong-account",
        lastChannel: "slack",
        lastTo: "U_WRONG",
        sessionId: "sess-meta",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceAccountId: "bot-123",
      turnSourceChannel: "telegram",
      turnSourceThreadId: 42,
      turnSourceTo: "8587265585",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("8587265585");
    expect(resolved.accountId).toBe("bot-123");
    expect(resolved.threadId).toBe(42);
  });

  it("does not fall back to session target metadata when turnSourceChannel is set", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastAccountId: "wrong-account",
        lastChannel: "slack",
        lastThreadId: "1739142736.000100",
        lastTo: "U_WRONG",
        sessionId: "sess-no-fallback",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "whatsapp",
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBeUndefined();
    expect(resolved.accountId).toBeUndefined();
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.lastTo).toBeUndefined();
    expect(resolved.lastAccountId).toBeUndefined();
    expect(resolved.lastThreadId).toBeUndefined();
  });

  it("falls back to session lastThreadId when turnSourceChannel matches session channel and no explicit turnSourceThreadId", () => {
    // Regression: Telegram forum topic replies were landing in the root chat instead of the topic
    // Thread because turnSourceThreadId was undefined (not explicitly passed), causing lastThreadId
    // To be undefined even though the session had the correct lastThreadId from the inbound message.
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 1122,
        lastTo: "-1001234567890",
        sessionId: "sess-forum-topic",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceTo: "-1001234567890",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890");
    expect(resolved.threadId).toBe(1122);
  });

  it("keeps Telegram topic thread routing when turnSourceTo uses the plugin-owned topic target", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 1122,
        lastTo: "telegram:-1001234567890:topic:1122",
        sessionId: "sess-forum-topic-scoped",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:-1001234567890:topic:1122",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("telegram:-1001234567890:topic:1122");
    expect(resolved.threadId).toBe(1122);
  });

  it("matches bare stored Telegram routes against topic-scoped turn routes via plugin grammar", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 1122,
        lastTo: "-1001234567890",
        sessionId: "sess-forum-topic-mixed-shape",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceTo: "telegram:-1001234567890:topic:1122",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("telegram:-1001234567890:topic:1122");
    expect(resolved.threadId).toBe(1122);
  });

  it("does not fall back to session lastThreadId when turnSourceChannel differs from session channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "slack",
        lastThreadId: "1739142736.000100",
        lastTo: "U_SLACK",
        sessionId: "sess-cross-channel-no-thread",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceTo: "-1001234567890",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.threadId).toBeUndefined();
  });

  it("prefers explicit turnSourceThreadId over session lastThreadId on same channel", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 1122,
        lastTo: "-1001234567890",
        sessionId: "sess-explicit-thread-override",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceThreadId: 9999,
      turnSourceTo: "-1001234567890",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890");
    expect(resolved.threadId).toBe(9999);
  });

  it("drops session threadId when turnSourceTo differs from session to (shared-session race)", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "telegram",
        lastThreadId: 1122,
        lastTo: "-1001234567890",
        sessionId: "sess-shared-race",
        updatedAt: 1,
      },
      requestedChannel: "last",
      turnSourceChannel: "telegram",
      turnSourceTo: "-1009999999999",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1009999999999");
    expect(resolved.threadId).toBeUndefined();
  });

  it("uses explicitTo even when turnSourceTo is omitted", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
        sessionId: "sess-explicit-to",
        updatedAt: 1,
      },
      explicitTo: "+15551234567",
      requestedChannel: "last",
      turnSourceChannel: "whatsapp",
    });

    expect(resolved.channel).toBe("whatsapp");
    expect(resolved.to).toBe("+15551234567");
  });

  it("still allows mismatched lastTo only from turn-scoped metadata", () => {
    const resolved = resolveSessionDeliveryTarget({
      allowMismatchedLastTo: true,
      entry: {
        lastChannel: "slack",
        lastTo: "U_WRONG",
        sessionId: "sess-mismatch-turn",
        updatedAt: 1,
      },
      requestedChannel: "telegram",
      turnSourceChannel: "whatsapp",
      turnSourceTo: "+15550000000",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("+15550000000");
  });
});
