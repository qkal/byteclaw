import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { telegramMessagingForTest } from "../../infra/outbound/targets.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "telegram", configured: ["telegram"] }),
}));

vi.mock("../../infra/outbound/target-resolver.js", () => ({
  maybeResolveIdLikeTarget: vi.fn(),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStoreSync: vi.fn(() => []),
}));

vi.mock("../../infra/outbound/targets.runtime.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));
const mockedModuleIds = [
  "../../config/sessions/main-session.js",
  "../../config/sessions/paths.js",
  "../../config/sessions/store-load.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
  "../../infra/outbound/target-resolver.js",
  "../../pairing/pairing-store.js",
];

import { loadSessionStore } from "../../config/sessions/store-load.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.runtime.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.runtime.js";
import { readChannelAllowFromStoreSync } from "../../pairing/pairing-store.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

function createStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      return trimmed
        ? { ok: true, to: trimmed }
        : { error: new Error(`${label} requires target`), ok: false };
    },
  };
}

function createAllowlistAwareStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      if (!trimmed) {
        return { error: new Error(`${label} requires target`), ok: false };
      }
      if (allowFrom && allowFrom.length > 0 && !allowFrom.includes(trimmed)) {
        return { error: new Error(`${label} target blocked`), ok: false };
      }
      return { ok: true, to: trimmed };
    },
  };
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  vi.mocked(resolveOutboundTarget).mockReset();
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: createOutboundTestPlugin({
          id: "telegram",
          messaging: telegramMessagingForTest,
          outbound: createStubOutbound("Telegram"),
        }),
        pluginId: "telegram",
        source: "test",
      },
      {
        plugin: {
          ...createOutboundTestPlugin({
            id: "whatsapp",
            outbound: createAllowlistAwareStubOutbound("WhatsApp"),
          }),
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
            resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) =>
              (cfg.channels?.whatsapp as { allowFrom?: string[] } | undefined)?.allowFrom,
          },
        },
        pluginId: "whatsapp",
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

function makeTelegramBoundCfg(accountId = "account-b"): OpenClawConfig {
  return makeCfg({
    bindings: [
      {
        agentId: AGENT_ID,
        match: { accountId, channel: "telegram" },
      },
    ],
  });
}

const AGENT_ID = "agent-b";
const DEFAULT_TARGET = {
  channel: "telegram" as const,
  to: "123456",
};

type SessionStore = ReturnType<typeof loadSessionStore>;

function setSessionStore(store: SessionStore) {
  vi.mocked(loadSessionStore).mockReturnValue(store);
}

function setMainSessionEntry(entry?: SessionStore[string]) {
  const store = entry ? ({ "agent:test:main": entry } as SessionStore) : ({} as SessionStore);
  setSessionStore(store);
}

function setLastSessionEntry(params: {
  sessionId: string;
  lastChannel: string;
  lastTo: string;
  lastThreadId?: string;
  lastAccountId?: string;
}) {
  setMainSessionEntry({
    lastChannel: params.lastChannel,
    lastTo: params.lastTo,
    sessionId: params.sessionId,
    updatedAt: 1000,
    ...(params.lastThreadId ? { lastThreadId: params.lastThreadId } : {}),
    ...(params.lastAccountId ? { lastAccountId: params.lastAccountId } : {}),
  });
}

function setStoredWhatsAppAllowFrom(allowFrom: string[]) {
  vi.mocked(readChannelAllowFromStoreSync).mockReturnValue(allowFrom);
}

async function resolveForAgent(params: {
  cfg: OpenClawConfig;
  target?: { channel?: "last" | "telegram"; to?: string };
}) {
  const channel = params.target ? params.target.channel : DEFAULT_TARGET.channel;
  const to = params.target && "to" in params.target ? params.target.to : DEFAULT_TARGET.to;
  return resolveDeliveryTarget(params.cfg, AGENT_ID, {
    channel,
    to,
  });
}

async function resolveLastTarget(cfg: OpenClawConfig) {
  return resolveForAgent({
    cfg,
    target: { channel: "last", to: undefined },
  });
}

describe("resolveDeliveryTarget", () => {
  it("reroutes implicit whatsapp delivery to authorized allowFrom recipient", async () => {
    setLastSessionEntry({
      lastChannel: "whatsapp",
      lastTo: "+15550000099",
      sessionId: "sess-w1",
    });
    setStoredWhatsAppAllowFrom(["+15550000001"]);

    const cfg = makeCfg({ bindings: [], channels: { whatsapp: { allowFrom: [] } } });
    const result = await resolveLastTarget(cfg);

    expect(result.channel).toBe("whatsapp");
    expect(result.to).toBe("+15550000001");
  });

  it("keeps explicit whatsapp target unchanged", async () => {
    setLastSessionEntry({
      lastChannel: "whatsapp",
      lastTo: "+15550000099",
      sessionId: "sess-w2",
    });
    setStoredWhatsAppAllowFrom(["+15550000001"]);

    const cfg = makeCfg({ bindings: [], channels: { whatsapp: { allowFrom: [] } } });
    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      channel: "whatsapp",
      to: "+15550000099",
    });

    expect(result.to).toBe("+15550000099");
  });

  it("falls back to bound accountId when session has no lastAccountId", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeTelegramBoundCfg();
    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("preserves session lastAccountId when present", async () => {
    setMainSessionEntry({
      lastAccountId: "session-account",
      lastChannel: "telegram",
      lastTo: "123456",
      sessionId: "sess-1",
      updatedAt: 1000,
    });

    const cfg = makeTelegramBoundCfg();
    const result = await resolveForAgent({ cfg });

    // Session-derived accountId should take precedence over binding
    expect(result.accountId).toBe("session-account");
  });

  it("returns undefined accountId when no binding and no session", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({ bindings: [] });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("applies id-like target normalization before returning delivery targets", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(maybeResolveIdLikeTarget).mockClear();
    vi.mocked(maybeResolveIdLikeTarget).mockResolvedValueOnce({
      kind: "user",
      source: "directory",
      to: "user:123456789",
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "123456789",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("user:123456789");
    expect(maybeResolveIdLikeTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        input: "123456789",
      }),
    );
  });

  it("falls back to the runtime target resolver when the channel plugin is not already loaded", async () => {
    setMainSessionEntry(undefined);
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: createOutboundTestPlugin({
            id: "whatsapp",
            outbound: createStubOutbound("WhatsApp"),
          }),
          pluginId: "whatsapp",
          source: "test",
        },
      ]),
    );
    vi.mocked(resolveOutboundTarget).mockReturnValueOnce({ ok: true, to: "123456" });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "123456",
    });

    expect(result).toEqual(
      expect.objectContaining({
        channel: "telegram",
        ok: true,
        to: "123456",
      }),
    );
    expect(resolveOutboundTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123456",
      }),
    );
  });

  it("selects correct binding when multiple agents have bindings", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-a",
          match: { accountId: "account-a", channel: "telegram" },
        },
        {
          agentId: "agent-b",
          match: { accountId: "account-b", channel: "telegram" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBe("account-b");
  });

  it("ignores bindings for different channels", async () => {
    setMainSessionEntry(undefined);

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { accountId: "discord-account", channel: "discord" },
        },
      ],
    });

    const result = await resolveForAgent({ cfg });

    expect(result.accountId).toBeUndefined();
  });

  it("drops session threadId when destination does not match the previous recipient", async () => {
    setLastSessionEntry({
      lastChannel: "telegram",
      lastThreadId: "thread-1",
      lastTo: "999999",
      sessionId: "sess-2",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBeUndefined();
  });

  it("keeps session threadId when destination matches the previous recipient", async () => {
    setLastSessionEntry({
      lastChannel: "telegram",
      lastThreadId: "thread-2",
      lastTo: "123456",
      sessionId: "sess-3",
    });

    const result = await resolveForAgent({ cfg: makeCfg({ bindings: [] }) });
    expect(result.threadId).toBe("thread-2");
  });

  it("uses single configured channel when neither explicit nor session channel exists", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));
    expect(result.channel).toBe("telegram");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected unresolved delivery target");
    }
    // ResolveOutboundTarget provides the standard missing-target error when
    // No explicit target, no session lastTo, and no plugin resolveDefaultTo.
    expect(result.error.message).toContain("requires target");
  });

  it("returns an error when channel selection is ambiguous", async () => {
    setMainSessionEntry(undefined);
    vi.mocked(resolveMessageChannelSelection).mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));
    expect(result.channel).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ambiguous channel selection error");
    }
    expect(result.error.message).toContain("Channel is required");
  });

  it("uses sessionKey thread entry before main session entry", async () => {
    setSessionStore({
      "agent:test:main": {
        lastChannel: "telegram",
        lastTo: "main-chat",
        sessionId: "main-session",
        updatedAt: 1000,
      },
      "agent:test:thread:42": {
        lastChannel: "telegram",
        lastThreadId: 42,
        lastTo: "thread-chat",
        sessionId: "thread-session",
        updatedAt: 2000,
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:42",
      to: undefined,
    });

    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("thread-chat");
    expect(result.threadId).toBe(42);
  });

  it("falls back to the main session entry when the requested sessionKey is missing", async () => {
    setSessionStore({
      "agent:test:main": {
        lastChannel: "telegram",
        lastTo: "main-chat",
        sessionId: "main-session",
        updatedAt: 1000,
      },
    } as SessionStore);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "last",
      sessionKey: "agent:test:thread:missing",
      to: undefined,
    });

    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("main-chat");
  });

  it("uses main session channel when channel=last and session route exists", async () => {
    setLastSessionEntry({
      lastChannel: "telegram",
      lastTo: "987654",
      sessionId: "sess-4",
    });

    const result = await resolveLastTarget(makeCfg({ bindings: [] }));

    expect(result.channel).toBe("telegram");
    expect(result.to).toBe("987654");
    expect(result.ok).toBe(true);
  });

  it("parses explicit telegram topic targets into delivery threadId", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      to: "63448508:topic:1008013",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe(1_008_013);
  });

  it("keeps explicit delivery threadId on first run without session history", async () => {
    setMainSessionEntry(undefined);

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      channel: "telegram",
      threadId: "1008013",
      to: "63448508",
    });

    expect(result.ok).toBe(true);
    expect(result.to).toBe("63448508");
    expect(result.threadId).toBe("1008013");
  });

  it("explicit delivery.accountId overrides session-derived accountId", async () => {
    setLastSessionEntry({
      lastAccountId: "default",
      lastChannel: "telegram",
      lastTo: "chat-999",
      sessionId: "sess-5",
    });

    const result = await resolveDeliveryTarget(makeCfg({ bindings: [] }), AGENT_ID, {
      accountId: "bot-b",
      channel: "telegram",
      to: "chat-999",
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("bot-b");
  });

  it("explicit delivery.accountId overrides bindings-derived accountId", async () => {
    setMainSessionEntry(undefined);
    const cfg = makeCfg({
      bindings: [{ agentId: AGENT_ID, match: { accountId: "bound", channel: "telegram" } }],
    });

    const result = await resolveDeliveryTarget(cfg, AGENT_ID, {
      accountId: "explicit",
      channel: "telegram",
      to: "chat-777",
    });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe("explicit");
  });
});
